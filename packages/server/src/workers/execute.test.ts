/**
 * Tool execution tests.
 *
 * These run against a real temporary directory, because the thing worth testing
 * is exactly what a mocked `fs` would paper over: whether a path escapes, what
 * happens to a file that is not there, and whether an edit lands where the
 * worker thought it would.
 *
 * The properties, in the order they matter:
 *
 *  - **No tool acts before the gate answers.** Every test that denies asserts
 *    both the message and that the disk was left alone — the second half is the
 *    one that catches an act-then-ask ordering bug.
 *  - **A path out of the zone is asked about, not refused.** Pointing a task at
 *    a project directory is meant to produce prompts; the sandbox's job is to
 *    know which paths those are, not to block them.
 *  - **Every failure is text.** No test here expects a throw.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelIdSchema,
  type TaskId,
  TaskSettingsSchema,
  newTaskId,
  newWorkItemId,
  newWorkerRunId,
} from "@rewter/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { Approvals } from "./approvals.js";
import {
  type ExecuteContext,
  SHELL_PATH,
  editFileTool,
  globToRegExp,
  globTool,
  grepTool,
  listDirTool,
  readFileTool,
  shellTool,
  stripHtml,
  webFetchTool,
  writeFileTool,
} from "./execute.js";
import { type Workspace, openWorkspace } from "./workspace.js";

let db: Db;
let repos: Repos;
let bus: EventBus;
let tick: number;
let taskId: TaskId;
let autoApprove: boolean;
let approvals: Approvals;
let workspace: Workspace;
/** Where a task pointed at "a real project" works. Outside the zone by design. */
let project: string;
let ctx: ExecuteContext;

beforeEach(() => {
  db = openDb(":memory:");
  tick = 1_756_252_800_000;
  const clock = () => ++tick;
  bus = new EventBus(db, clock);
  repos = new Repos(db, bus, clock);
  autoApprove = false;
  taskId = newTaskId();
  const now = ++tick;
  repos.createTask({
    id: taskId,
    status: "running",
    title: "tool execution",
    initiatorModelId: ModelIdSchema.parse("anthropic/claude-sonnet-5"),
    conversationFingerprint: null,
    settings: TaskSettingsSchema.parse({}),
    resultSummary: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  });

  const base = mkdtempSync(join(tmpdir(), "rewter-exec-"));
  project = mkdtempSync(join(tmpdir(), "rewter-project-"));
  workspace = openWorkspace({ taskId, baseDir: base });
  approvals = new Approvals({ repos, taskId, autoApprove: () => autoApprove, clock });
  ctx = {
    workspace,
    approvals,
    workItemId: newWorkItemId(),
    workerRunId: newWorkerRunId(),
    signal: new AbortController().signal,
  };
});

/** Point the worker at the "project" directory: everything is then outside the zone. */
function inProject(): void {
  ctx = { ...ctx, workspace: { root: workspace.root, cwd: project } };
}

/** Approve whatever parks next, as the dashboard would. */
function approveNext(note?: string): void {
  setTimeout(() => {
    for (const a of approvals.pending()) approvals.resolve(a.id, true, "dashboard", note);
  }, 0);
}

/** Deny whatever parks next, with the note the worker should read. */
function denyNext(note?: string): void {
  setTimeout(() => {
    for (const a of approvals.pending()) approvals.resolve(a.id, false, "dashboard", note);
  }, 0);
}

describe("read_file", () => {
  it("returns numbered lines a worker can quote back to edit_file", async () => {
    writeFileSync(join(workspace.root, "a.txt"), "one\ntwo\nthree\n");
    const res = await readFileTool(ctx, { path: "a.txt" });
    expect(res.content).toContain("1\tone");
    expect(res.content).toContain("3\tthree");
    expect(res.denied).toBeUndefined();
  });

  it("needs no approval inside the zone", async () => {
    writeFileSync(join(workspace.root, "a.txt"), "x\n");
    // No approveNext: if this parked, the test would time out.
    const res = await readFileTool(ctx, { path: "a.txt" });
    expect(res.content).toContain("1\tx");
    expect(approvals.pending()).toHaveLength(0);
  });

  it("asks before reading outside the zone, and reads once approved", async () => {
    writeFileSync(join(project, "secret.txt"), "hello\n");
    inProject();
    approveNext();
    const res = await readFileTool(ctx, { path: "secret.txt" });
    expect(res.content).toContain("1\thello");
  });

  it("hands the user's note back to the worker when a read is denied", async () => {
    writeFileSync(join(project, "secret.txt"), "hello\n");
    inProject();
    denyNext("read the fixture under test/ instead");
    const res = await readFileTool(ctx, { path: "secret.txt" });
    expect(res.denied).toBe(true);
    expect(res.content).toContain("read the fixture under test/ instead");
    expect(res.content).not.toContain("hello");
  });

  it("pages with start_line and says how much is left", async () => {
    writeFileSync(
      join(workspace.root, "big.txt"),
      Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join("\n"),
    );
    const res = await readFileTool(ctx, { path: "big.txt", start_line: 10, max_lines: 5 });
    expect(res.content).toContain("10\tL10");
    expect(res.content).toContain("14\tL14");
    expect(res.content).not.toContain("15\tL15");
    expect(res.content).toContain("more lines");
  });

  it("says a file is missing rather than throwing", async () => {
    const res = await readFileTool(ctx, { path: "nope.txt" });
    expect(res.content).toContain("no such file or directory");
  });

  it("says so when start_line is past the end", async () => {
    writeFileSync(join(workspace.root, "a.txt"), "one\ntwo");
    const res = await readFileTool(ctx, { path: "a.txt", start_line: 99 });
    expect(res.content).toContain("has only 2 lines");
  });

  it("gates a traversal out of the zone the same as any other outside path", async () => {
    writeFileSync(join(project, "x.txt"), "leak\n");
    denyNext();
    // Written as a relative escape; `classify` resolves it before the gate sees it.
    const res = await readFileTool(ctx, { path: join("..", "..", project, "x.txt") });
    expect(res.denied).toBe(true);
  });
});

describe("write_file", () => {
  it("writes inside the zone without asking, creating parents", async () => {
    const res = await writeFileTool(ctx, { path: "nested/deep/a.txt", content: "hi\n" });
    expect(res.content).toContain("wrote nested/deep/a.txt");
    expect(readFileSync(join(workspace.root, "nested/deep/a.txt"), "utf8")).toBe("hi\n");
  });

  it("asks before writing into a project directory", async () => {
    inProject();
    approveNext();
    const res = await writeFileTool(ctx, { path: "out.txt", content: "written\n" });
    expect(res.content).toContain("wrote out.txt");
    expect(readFileSync(join(project, "out.txt"), "utf8")).toBe("written\n");
  });

  it("does not touch the disk when the write is denied", async () => {
    inProject();
    denyNext("do not overwrite the source");
    const res = await writeFileTool(ctx, { path: "out.txt", content: "written\n" });
    expect(res.denied).toBe(true);
    expect(res.content).toContain("do not overwrite the source");
    // The property this test exists for: refused means nothing happened.
    expect(() => readFileSync(join(project, "out.txt"), "utf8")).toThrow();
  });

  it("counts an empty write as zero lines rather than one", async () => {
    const res = await writeFileTool(ctx, { path: "empty.txt", content: "" });
    expect(res.content).toContain("0 lines");
  });
});

describe("edit_file", () => {
  beforeEach(() => {
    writeFileSync(join(workspace.root, "code.ts"), "const a = 1;\nconst b = 2;\nconst a2 = 1;\n");
  });

  it("replaces a unique passage", async () => {
    const res = await editFileTool(ctx, {
      path: "code.ts",
      old_text: "const b = 2;",
      new_text: "const b = 3;",
    });
    expect(res.content).toBe("edited code.ts");
    expect(readFileSync(join(workspace.root, "code.ts"), "utf8")).toContain("const b = 3;");
  });

  it("refuses an ambiguous anchor instead of editing the first match", async () => {
    const before = readFileSync(join(workspace.root, "code.ts"), "utf8");
    const res = await editFileTool(ctx, { path: "code.ts", old_text: "= 1;", new_text: "= 9;" });
    expect(res.content).toContain("appears 2 times");
    expect(res.content).toContain("must be unique");
    // Refused, not partially applied — the whole point of refusing.
    expect(readFileSync(join(workspace.root, "code.ts"), "utf8")).toBe(before);
  });

  it("tells the worker to re-read when the anchor is not there at all", async () => {
    const res = await editFileTool(ctx, {
      path: "code.ts",
      old_text: "const c = 3;",
      new_text: "x",
    });
    expect(res.content).toContain("does not appear");
    expect(res.content).toContain("exact text");
  });

  it("deletes a passage when new_text is empty", async () => {
    await editFileTool(ctx, { path: "code.ts", old_text: "const b = 2;\n", new_text: "" });
    expect(readFileSync(join(workspace.root, "code.ts"), "utf8")).not.toContain("const b");
  });

  it("asks before editing a file in a project directory", async () => {
    writeFileSync(join(project, "src.ts"), "old\n");
    inProject();
    approveNext();
    const res = await editFileTool(ctx, { path: "src.ts", old_text: "old", new_text: "new" });
    expect(res.content).toBe("edited src.ts");
    expect(readFileSync(join(project, "src.ts"), "utf8")).toBe("new\n");
  });

  it("leaves the file alone when the edit is denied", async () => {
    writeFileSync(join(project, "src.ts"), "old\n");
    inProject();
    denyNext();
    const res = await editFileTool(ctx, { path: "src.ts", old_text: "old", new_text: "new" });
    expect(res.denied).toBe(true);
    expect(readFileSync(join(project, "src.ts"), "utf8")).toBe("old\n");
  });
});

describe("list_dir", () => {
  it("marks directories and sorts", async () => {
    mkdirSync(join(workspace.root, "sub"));
    writeFileSync(join(workspace.root, "a.txt"), "");
    const res = await listDirTool(ctx, { path: "." });
    expect(res.content.split("\n")).toEqual(["a.txt", "sub/"]);
  });

  it("says a directory is empty rather than returning nothing", async () => {
    mkdirSync(join(workspace.root, "empty"));
    const res = await listDirTool(ctx, { path: "empty" });
    expect(res.content).toContain("is empty");
  });

  it("reports a missing directory as text", async () => {
    const res = await listDirTool(ctx, { path: "nope" });
    expect(res.content).toContain("no such file or directory");
  });
});

describe("glob", () => {
  beforeEach(() => {
    mkdirSync(join(workspace.root, "src/deep"), { recursive: true });
    writeFileSync(join(workspace.root, "src/a.ts"), "");
    writeFileSync(join(workspace.root, "src/b.js"), "");
    writeFileSync(join(workspace.root, "src/deep/c.ts"), "");
    writeFileSync(join(workspace.root, "top.ts"), "");
  });

  it("matches within one directory level for a single star", async () => {
    const res = await globTool(ctx, { pattern: "src/*.ts", path: "." });
    expect(res.content).toBe("src/a.ts");
  });

  it("crosses directories for a double star, including zero of them", async () => {
    const res = await globTool(ctx, { pattern: "**/*.ts", path: "." });
    expect(res.content.split("\n")).toEqual(["src/a.ts", "src/deep/c.ts", "top.ts"]);
  });

  it("says nothing matched rather than returning an empty string", async () => {
    const res = await globTool(ctx, { pattern: "**/*.py", path: "." });
    expect(res.content).toContain("no files match");
  });

  it("skips node_modules, which is never what a worker means", async () => {
    mkdirSync(join(workspace.root, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(workspace.root, "node_modules/pkg/index.ts"), "");
    const res = await globTool(ctx, { pattern: "**/*.ts", path: "." });
    expect(res.content).not.toContain("node_modules");
  });

  it("does not follow a symlinked directory out of the tree", async () => {
    writeFileSync(join(project, "outside.ts"), "");
    symlinkSync(project, join(workspace.root, "escape"));
    const res = await globTool(ctx, { pattern: "**/*.ts", path: "." });
    expect(res.content).not.toContain("outside.ts");
  });
});

describe("globToRegExp", () => {
  it("treats * as within-a-segment and ** as across segments", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(false);
    expect(globToRegExp("**/*.ts").test("src/deep/a.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true);
  });

  it("escapes regex metacharacters so a pattern cannot widen itself", () => {
    // Without escaping, `.` matches any character and this would be true.
    expect(globToRegExp("a.ts").test("axts")).toBe(false);
    expect(globToRegExp("a+b.ts").test("a+b.ts")).toBe(true);
    expect(globToRegExp("v(1).ts").test("v(1).ts")).toBe(true);
  });

  it("anchors both ends", () => {
    expect(globToRegExp("*.ts").test("a.ts.bak")).toBe(false);
  });

  it("matches exactly one character for ?", () => {
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
    expect(globToRegExp("a?.ts").test("abc.ts")).toBe(false);
    expect(globToRegExp("a?.ts").test("a/.ts")).toBe(false);
  });
});

describe("grep", () => {
  beforeEach(() => {
    mkdirSync(join(workspace.root, "src"), { recursive: true });
    writeFileSync(join(workspace.root, "src/a.ts"), "const x = 1;\n// TODO: fix\n");
    writeFileSync(join(workspace.root, "src/b.md"), "TODO in markdown\n");
  });

  it("returns file, line number and the matching line", async () => {
    const res = await grepTool(ctx, { pattern: "TODO", path: "." });
    expect(res.content).toContain("src/a.ts:2: // TODO: fix");
    expect(res.content).toContain("src/b.md:1: TODO in markdown");
  });

  it("narrows to a name filter", async () => {
    const res = await grepTool(ctx, { pattern: "TODO", path: ".", glob: "**/*.ts" });
    expect(res.content).toContain("src/a.ts");
    expect(res.content).not.toContain("b.md");
  });

  it("searches a single file when the path is a file", async () => {
    const res = await grepTool(ctx, { pattern: "const", path: "src/a.ts" });
    expect(res.content).toContain(":1: const x = 1;");
  });

  it("names a bad regular expression instead of crashing the worker", async () => {
    const res = await grepTool(ctx, { pattern: "([unclosed", path: "." });
    expect(res.content).toContain("bad regular expression");
  });

  it("says nothing matched", async () => {
    const res = await grepTool(ctx, { pattern: "zzzznotpresent", path: "." });
    expect(res.content).toContain("no matches");
  });
});

describe("shell", () => {
  it("resolves a shell that exists on this host", () => {
    // Hard-coding `zsh` meant every command on a host without one came back
    // "could not run the command: no such file or directory" — which reads as
    // "your command was wrong", not "this daemon cannot run commands here".
    // CI was the host that proved it. Asserting the path directly turns that
    // into one named failure rather than every shell test failing obscurely.
    expect(existsSync(SHELL_PATH)).toBe(true);
  });

  it("runs a read-only command without asking, and states the exit code", async () => {
    writeFileSync(join(workspace.root, "hello.txt"), "");
    const res = await shellTool(ctx, { command: "ls" });
    expect(res.content).toContain("exit code: 0");
    expect(res.content).toContain("hello.txt");
    expect(approvals.pending()).toHaveLength(0);
  });

  it("logs the auto-approval rather than skipping the gate", async () => {
    await shellTool(ctx, { command: "pwd" });
    // The row is what makes "nothing needed asking" and "the gate was off"
    // distinguishable later, so a read-only run must still leave one behind.
    const requested = bus
      .eventsAfter(0, taskId)
      .map((e) => e.payload)
      .filter((p) => p.type === "approval.requested");
    expect(requested).toHaveLength(1);
    const first = requested[0];
    const row =
      first?.type === "approval.requested" ? repos.getApproval(first.approval.id) : undefined;
    expect(row?.status).toBe("auto_approved");
    expect(row?.resolutionNote).toContain("read-only");
  });

  it("asks before anything that is not plainly read-only", async () => {
    approveNext();
    const res = await shellTool(ctx, { command: "echo written > out.txt" });
    expect(res.content).toContain("exit code: 0");
    expect(readFileSync(join(workspace.root, "out.txt"), "utf8")).toBe("written\n");
  });

  it("does not run a denied command", async () => {
    denyNext("run the tests, not the build");
    const res = await shellTool(ctx, { command: "echo nope > out.txt" });
    expect(res.denied).toBe(true);
    expect(res.content).toContain("run the tests, not the build");
    expect(() => readFileSync(join(workspace.root, "out.txt"), "utf8")).toThrow();
  });

  it("asks about a metacharacter command even when it starts with a listed verb", async () => {
    // `ls; …` begins with `ls` and must still be asked about.
    denyNext();
    const res = await shellTool(ctx, { command: "ls; echo pwned > out.txt" });
    expect(res.denied).toBe(true);
    expect(() => readFileSync(join(workspace.root, "out.txt"), "utf8")).toThrow();
  });

  it("reports a non-zero exit as a result, not a failure of the tool", async () => {
    const res = await shellTool(ctx, { command: "cat /definitely/not/here" });
    expect(res.content).toContain("exit code: 1");
    expect(res.content).toContain("stderr:");
    expect(res.denied).toBeUndefined();
  });

  it("runs in the working directory, not the process's", async () => {
    const res = await shellTool(ctx, { command: "pwd" });
    expect(res.content).toContain(workspace.root);
  });

  it("kills a command that outlives its timeout and says so", async () => {
    approveNext();
    const res = await shellTool(ctx, { command: "sleep 5", timeout: 1 });
    expect(res.content).toContain("timed out after 1s");
  });

  it("does not hang on a command that would wait for input", async () => {
    // stdio is "ignore", so `cat` sees EOF immediately instead of blocking.
    const res = await shellTool(ctx, { command: "cat" });
    expect(res.content).toContain("exit code: 0");
  });

  it("says '(no output)' rather than leaving the worker guessing", async () => {
    approveNext();
    const res = await shellTool(ctx, { command: "true" });
    expect(res.content).toContain("(no output)");
  });

  it("keeps the tail of a large output, where a failure's cause is", async () => {
    approveNext();
    const res = await shellTool(ctx, { command: "seq 1 200000" });
    expect(res.content).toContain("200000");
    expect(res.content.length).toBeLessThan(64 * 1024);
  });

  it("does not start a command once the task is cancelled", async () => {
    approvals.cancel();
    const res = await shellTool(ctx, { command: "echo nope > out.txt" });
    expect(res.denied).toBe(true);
    expect(res.content).toContain("cancelled");
    expect(() => readFileSync(join(workspace.root, "out.txt"), "utf8")).toThrow();
  });

  it("kills a running command when the worker is aborted", async () => {
    const controller = new AbortController();
    approveNext();
    const promise = shellTool({ ...ctx, signal: controller.signal }, { command: "sleep 30" });
    setTimeout(() => controller.abort(), 50);
    const res = await promise;
    expect(res.content).toContain("cancelled");
  });
});

describe("web_fetch", () => {
  function withFetch(impl: typeof fetch): ExecuteContext {
    return { ...ctx, fetchImpl: impl };
  }

  it("returns a plain-text body as-is", async () => {
    const res = await webFetchTool(
      withFetch(
        async () => new Response("hello world", { headers: { "content-type": "text/plain" } }),
      ),
      { url: "https://example.com/a.txt" },
    );
    expect(res.content).toBe("hello world");
  });

  it("reduces HTML to readable text", async () => {
    const html =
      "<html><head><style>p{color:red}</style></head><body><h1>Title</h1><p>Body &amp; more</p><script>alert(1)</script></body></html>";
    const res = await webFetchTool(
      withFetch(async () => new Response(html, { headers: { "content-type": "text/html" } })),
      { url: "https://example.com/" },
    );
    expect(res.content).toContain("Title");
    expect(res.content).toContain("Body & more");
    expect(res.content).not.toContain("alert(1)");
    expect(res.content).not.toContain("color:red");
  });

  it("refuses a file: URL, which would route around the path gate", async () => {
    let called = false;
    const res = await webFetchTool(
      withFetch(async () => {
        called = true;
        return new Response("");
      }),
      { url: "file:///etc/passwd" },
    );
    expect(res.content).toContain("only http and https");
    expect(called).toBe(false);
  });

  it("reports a malformed URL", async () => {
    const res = await webFetchTool(ctx, { url: "not a url" });
    expect(res.content).toContain("not a valid URL");
  });

  it("reports an HTTP error status", async () => {
    const res = await webFetchTool(
      withFetch(async () => new Response("nope", { status: 404, statusText: "Not Found" })),
      { url: "https://example.com/missing" },
    );
    expect(res.content).toContain("HTTP 404");
  });

  it("reports a network failure as text", async () => {
    const res = await webFetchTool(
      withFetch(async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }),
      { url: "https://nope.invalid/" },
    );
    expect(res.content).toContain("could not fetch");
  });

  it("truncates a huge page and says it did", async () => {
    const big = "x".repeat(200 * 1024);
    const res = await webFetchTool(
      withFetch(async () => new Response(big, { headers: { "content-type": "text/plain" } })),
      { url: "https://example.com/big" },
    );
    expect(res.content).toContain("[truncated:");
    expect(res.content.length).toBeLessThan(110 * 1024);
  });
});

describe("stripHtml", () => {
  it("puts block boundaries on their own lines", () => {
    expect(stripHtml("<p>one</p><p>two</p>")).toBe("one\ntwo");
  });

  it("drops comments and decodes the common entities", () => {
    expect(stripHtml("<!-- hidden --><p>a &lt;b&gt; &quot;c&quot;</p>")).toBe('a <b> "c"');
  });
});
