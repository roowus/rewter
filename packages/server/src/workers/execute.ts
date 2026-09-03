/**
 * Tier-2 tool execution: where a validated tool call meets the disk.
 *
 * One function per tool, and every one of them that can reach outside the
 * auto-approve zone calls `approvals.require` *before* doing anything. The gate
 * being one function is only half the property — the other half is that this
 * module is the only place tools are implemented, so there is one list to audit
 * rather than one per caller.
 *
 * The house rules, in the order they matter:
 *
 * 1. **Classify, then ask, then act.** `classify` says whether a path is in the
 *    zone; the gate decides; only then does anything happen. A tool that acts
 *    and reports afterwards has already done the damage.
 * 2. **Every failure is a tool result.** A missing file, a denied approval, a
 *    non-unique edit anchor, a command that exits 1 — all of them come back as
 *    text the model reads and responds to. Nothing here throws except a bug.
 * 3. **Output is capped, and says when it was cut.** A worker's context is the
 *    scarce resource, and silently truncated output is worse than obviously
 *    truncated output: the model reasons confidently about a file it only half
 *    received.
 * 4. **Reads are gated too, when they leave the zone.** A worker pointed at a
 *    project directory can read the project — that is the job — but it cannot
 *    read `~/.ssh` without being asked about, and the only thing separating
 *    those two is `classify`.
 */
import { spawn } from "node:child_process";
// `Dirent` is imported explicitly because `ReturnType<typeof readdir>` resolves
// to the Buffer-name overload, whose `name` is not a string.
import { type Dirent, existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { WorkItemId, WorkerRunId } from "@rewter/shared";
import type { z } from "zod";
import type { Approvals } from "./approvals.js";
import { isReadOnlyCommand } from "./approvals.js";
import type { SearchBackend } from "./search.js";
import type {
  EditFileArgs,
  GlobArgs,
  GrepArgs,
  ListDirArgs,
  ReadFileArgs,
  ShellArgs,
  WebFetchArgs,
  WebSearchArgs,
  WriteFileArgs,
} from "./tools.js";
import { type Workspace, classify } from "./workspace.js";

/** Caps. Generous enough for real work, small enough not to eat a context window. */
const MAX_READ_BYTES = 256 * 1024;
const MAX_SHELL_OUTPUT = 32 * 1024;
const MAX_FETCH_BYTES = 100 * 1024;
/** Per result. A snippet is a pointer to a page, not the page. */
const MAX_SNIPPET_CHARS = 400;
const MAX_LIST_ENTRIES = 500;
const MAX_GREP_MATCHES = 200;
const MAX_GLOB_RESULTS = 300;
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;

/**
 * Which shell `shell` runs commands through.
 *
 * zsh first because it is the user's login shell on macOS, where this daemon
 * lives, and a worker's command should behave the way the same command behaves
 * in the user's terminal. But *hard-coding* it was a real bug: on a host with
 * no zsh — any stock Linux box, including the CI runner — every shell command
 * came back `could not run the command: no such file or directory`, which reads
 * as "your command was wrong" rather than "this daemon cannot run commands
 * here". Resolved once at import, because the answer cannot change under a
 * running process and a per-command `existsSync` would be a syscall per tool
 * call to learn something already known.
 *
 * `$SHELL` is deliberately not consulted: it can name something that is not
 * POSIX-compatible (fish), and the tool's contract with the model — pipes,
 * redirects, `&&` — is a Bourne-family one.
 */
export const SHELL_PATH: string =
  ["/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash"].find((p) => existsSync(p)) ??
  "/bin/sh";

export interface ExecuteContext {
  workspace: Workspace;
  approvals: Approvals;
  workItemId: WorkItemId;
  workerRunId: WorkerRunId;
  signal: AbortSignal;
  /** Injected so tests need no network. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Announce a `report_progress` note to the user's feed. */
  onProgress?: (note: string) => void;
  /**
   * The `web_search` backend, when the daemon has one. Absent means the tool was
   * never declared to this worker; `webSearchTool` still answers a call
   * gracefully, because a model can call a tool it was not offered.
   */
  search?: { backend: SearchBackend; maxResults: number };
}

/** What a tool hands back to the model. */
export interface ToolResult {
  content: string;
  /** True when the action was refused; the loop counts these to spot a stuck worker. */
  denied?: boolean;
}

const ok = (content: string): ToolResult => ({ content });
const fail = (content: string): ToolResult => ({ content });

/**
 * Ask about a path unless it is in the zone.
 *
 * The summary quotes the path **as the worker wrote it** alongside the resolved
 * one: an approval card reading `../../etc/passwd` tells the user what was asked
 * for, and the resolved path tells them what it means. Either alone can mislead.
 */
async function gatePath(
  ctx: ExecuteContext,
  action: string,
  path: string,
  kind: "write_outside_workspace" | "other",
): Promise<{ absolute: string } | { denied: string }> {
  const resolved = classify(ctx.workspace, path);
  const verdict = await ctx.approvals.require({
    kind,
    summary: `${action} ${resolved.requested}`,
    detail: { requested: resolved.requested, absolute: resolved.absolute },
    workItemId: ctx.workItemId,
    workerRunId: ctx.workerRunId,
    inWorkspace: resolved.inside,
  });
  if (!verdict.ok) return { denied: verdict.reason };
  return { absolute: resolved.absolute };
}

function truncate(text: string, limit: number, what: string): string {
  if (text.length <= limit) return text;
  // Head for files (the top is where the shape of a file lives).
  return `${text.slice(0, limit)}\n\n[truncated: ${what} exceeded ${limit} bytes]`;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    // ENOENT / EACCES read far better than the full Error#message, which repeats
    // the syscall and the path the model already knows it asked for.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "no such file or directory";
    if (code === "EACCES") return "permission denied by the operating system";
    if (code === "EISDIR") return "that path is a directory, not a file";
    if (code === "ENOTDIR") return "a component of that path is not a directory";
    return err.message;
  }
  return String(err);
}

export async function readFileTool(
  ctx: ExecuteContext,
  args: z.infer<typeof ReadFileArgs>,
): Promise<ToolResult> {
  // Reads are gated when they leave the zone: a worker in a project directory
  // may read the project, but not the user's keys, and only `classify` knows
  // which of those a path is.
  const gated = await gatePath(ctx, "read", args.path, "other");
  if ("denied" in gated)
    return { content: `cannot read ${args.path}: ${gated.denied}`, denied: true };

  let raw: string;
  try {
    raw = await readFile(gated.absolute, "utf8");
  } catch (err) {
    return fail(`cannot read ${args.path}: ${errorText(err)}`);
  }

  const lines = raw.split("\n");
  const start = (args.start_line ?? 1) - 1;
  if (start >= lines.length && lines.length > 0) {
    return fail(
      `${args.path} has only ${lines.length} lines; start_line ${args.start_line} is past the end`,
    );
  }
  const end = args.max_lines === undefined ? lines.length : start + args.max_lines;
  const slice = lines.slice(start, end);

  // Numbered, because `edit_file` needs the worker to quote text back exactly and
  // numbers are how it refers to a place in between.
  const numbered = slice.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
  const more =
    end < lines.length ? `\n\n[${lines.length - end} more lines; pass start_line to continue]` : "";
  return ok(truncate(numbered, MAX_READ_BYTES, "file") + more);
}

export async function writeFileTool(
  ctx: ExecuteContext,
  args: z.infer<typeof WriteFileArgs>,
): Promise<ToolResult> {
  const gated = await gatePath(ctx, "write", args.path, "write_outside_workspace");
  if ("denied" in gated)
    return { content: `cannot write ${args.path}: ${gated.denied}`, denied: true };

  try {
    await mkdir(dirname(gated.absolute), { recursive: true });
    await writeFile(gated.absolute, args.content, "utf8");
  } catch (err) {
    return fail(`cannot write ${args.path}: ${errorText(err)}`);
  }
  const lines = args.content === "" ? 0 : args.content.split("\n").length;
  return ok(`wrote ${args.path} (${lines} lines, ${args.content.length} bytes)`);
}

export async function editFileTool(
  ctx: ExecuteContext,
  args: z.infer<typeof EditFileArgs>,
): Promise<ToolResult> {
  const gated = await gatePath(ctx, "edit", args.path, "write_outside_workspace");
  if ("denied" in gated)
    return { content: `cannot edit ${args.path}: ${gated.denied}`, denied: true };

  let before: string;
  try {
    before = await readFile(gated.absolute, "utf8");
  } catch (err) {
    return fail(`cannot edit ${args.path}: ${errorText(err)}`);
  }

  // Refused rather than guessed. An ambiguous anchor applied to the first match
  // is an edit in a place the model did not look at, which is the failure mode
  // most likely to be silently wrong.
  const first = before.indexOf(args.old_text);
  if (first === -1) {
    return fail(
      `old_text does not appear in ${args.path}. Read the file and copy the exact text, including indentation.`,
    );
  }
  if (before.indexOf(args.old_text, first + 1) !== -1) {
    const n = before.split(args.old_text).length - 1;
    return fail(
      `old_text appears ${n} times in ${args.path}; it must be unique. Include more surrounding lines.`,
    );
  }

  try {
    await writeFile(gated.absolute, before.replace(args.old_text, args.new_text), "utf8");
  } catch (err) {
    return fail(`cannot edit ${args.path}: ${errorText(err)}`);
  }
  return ok(`edited ${args.path}`);
}

export async function listDirTool(
  ctx: ExecuteContext,
  args: z.infer<typeof ListDirArgs>,
): Promise<ToolResult> {
  const gated = await gatePath(ctx, "list", args.path, "other");
  if ("denied" in gated)
    return { content: `cannot list ${args.path}: ${gated.denied}`, denied: true };

  let entries: Dirent[];
  try {
    entries = await readdir(gated.absolute, { withFileTypes: true });
  } catch (err) {
    return fail(`cannot list ${args.path}: ${errorText(err)}`);
  }

  const names = entries
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort()
    .slice(0, MAX_LIST_ENTRIES);
  const extra =
    entries.length > MAX_LIST_ENTRIES
      ? `\n[${entries.length - MAX_LIST_ENTRIES} more entries]`
      : "";
  return ok(names.length === 0 ? `${args.path} is empty` : names.join("\n") + extra);
}

/** Directories never worth walking, and expensive enough to matter. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".venv", "target"]);

/**
 * Recursive walk shared by `glob` and `grep`.
 *
 * Symlinked directories are not followed: a link back up the tree turns a walk
 * into an infinite one, and a link out of the zone would read files the gate was
 * never asked about — the same escape `classify` closes, one level up.
 */
async function walk(root: string, limit: number, signal: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [root];
  while (queue.length > 0 && out.length < limit) {
    if (signal.aborted) break;
    const dir = queue.shift() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // An unreadable directory is skipped, not fatal to the whole walk.
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(full);
      } else if (e.isFile()) {
        out.push(full);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

/**
 * Glob → RegExp.
 *
 * `**` crosses separators and `*` does not, which is the distinction that makes
 * `src/*.ts` mean something different from `src/**\/*.ts`. Everything else is
 * escaped, so a pattern cannot smuggle in regex syntax that matches far more
 * than the worker intended.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` should also match zero directories, so `**/*.ts` finds `a.ts`.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

export async function globTool(
  ctx: ExecuteContext,
  args: z.infer<typeof GlobArgs>,
): Promise<ToolResult> {
  const gated = await gatePath(ctx, "search", args.path, "other");
  if ("denied" in gated)
    return { content: `cannot search ${args.path}: ${gated.denied}`, denied: true };

  let re: RegExp;
  try {
    re = globToRegExp(args.pattern);
  } catch (err) {
    return fail(`bad pattern: ${errorText(err)}`);
  }

  const files = await walk(gated.absolute, 20_000, ctx.signal);
  const hits = files
    .map((f) => relative(gated.absolute, f))
    .filter((rel) => re.test(rel))
    .sort()
    .slice(0, MAX_GLOB_RESULTS);
  if (hits.length === 0) return ok(`no files match ${args.pattern}`);
  return ok(hits.join("\n"));
}

export async function grepTool(
  ctx: ExecuteContext,
  args: z.infer<typeof GrepArgs>,
): Promise<ToolResult> {
  const gated = await gatePath(ctx, "search", args.path, "other");
  if ("denied" in gated)
    return { content: `cannot search ${args.path}: ${gated.denied}`, denied: true };

  let re: RegExp;
  try {
    re = new RegExp(args.pattern);
  } catch (err) {
    // A bad regex is the model's typo, not a crash: name it and let it retry.
    return fail(`bad regular expression: ${errorText(err)}`);
  }
  const nameFilter = args.glob === undefined ? null : globToRegExp(args.glob);

  let files: string[];
  try {
    const info = await stat(gated.absolute);
    files = info.isDirectory() ? await walk(gated.absolute, 20_000, ctx.signal) : [gated.absolute];
  } catch (err) {
    return fail(`cannot search ${args.path}: ${errorText(err)}`);
  }

  const matches: string[] = [];
  for (const file of files) {
    if (matches.length >= MAX_GREP_MATCHES || ctx.signal.aborted) break;
    const rel = relative(gated.absolute, file) || file;
    if (nameFilter !== null && !nameFilter.test(rel)) continue;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue; // Binary or unreadable: not a match, not an error.
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i += 1) {
      const line = lines[i] as string;
      if (re.test(line)) matches.push(`${rel}:${i + 1}: ${line.slice(0, 300)}`);
    }
  }

  if (matches.length === 0) return ok(`no matches for ${args.pattern}`);
  const capped =
    matches.length >= MAX_GREP_MATCHES ? `\n[stopped at ${MAX_GREP_MATCHES} matches]` : "";
  return ok(matches.join("\n") + capped);
}

export async function shellTool(
  ctx: ExecuteContext,
  args: z.infer<typeof ShellArgs>,
): Promise<ToolResult> {
  // The allowlist decides whether this is *asked about*, never whether it runs:
  // policy is the gate's to make, and passing `readOnly` rather than skipping
  // the call is what keeps every shell command in the audit trail.
  const readOnly = isReadOnlyCommand(args.command);
  const verdict = await ctx.approvals.require({
    kind: "shell",
    summary: args.command,
    detail: { command: args.command, cwd: ctx.workspace.cwd },
    workItemId: ctx.workItemId,
    workerRunId: ctx.workerRunId,
    readOnly,
  });
  if (!verdict.ok) return { content: `command not run: ${verdict.reason}`, denied: true };

  const timeoutMs = args.timeout === undefined ? DEFAULT_SHELL_TIMEOUT_MS : args.timeout * 1_000;
  return await new Promise<ToolResult>((resolve) => {
    const child = spawn(SHELL_PATH, ["-c", args.command], {
      cwd: ctx.workspace.cwd,
      // No stdin: an interactive prompt would hang until the timeout, and a
      // worker cannot answer one anyway.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    let done = false;
    const finish = (result: ToolResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    // The tail, not the head: a failing build's useful line is the last one.
    const append = (into: "out" | "err", chunk: string) => {
      if (into === "out") out = (out + chunk).slice(-MAX_SHELL_OUTPUT);
      else err = (err + chunk).slice(-MAX_SHELL_OUTPUT);
    };
    child.stdout.on("data", (d: Buffer) => append("out", d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => append("err", d.toString("utf8")));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        fail(
          `command timed out after ${timeoutMs / 1_000}s and was killed.\n${render(out, err, null)}`,
        ),
      );
    }, timeoutMs);
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(fail("command cancelled"));
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (e) => finish(fail(`could not run the command: ${errorText(e)}`)));
    child.on("close", (code) => finish(ok(render(out, err, code))));
  });
}

/**
 * Format a command's result.
 *
 * The exit code is always stated. A worker that sees only output cannot tell a
 * test suite that passed from one that failed quietly, and "did it work" is the
 * single most important thing about running a command.
 */
function render(out: string, err: string, code: number | null): string {
  const parts: string[] = [];
  if (code !== null) parts.push(`exit code: ${code}`);
  if (out.trim() !== "") parts.push(`stdout:\n${out.trimEnd()}`);
  if (err.trim() !== "") parts.push(`stderr:\n${err.trimEnd()}`);
  if (parts.length === 1 && code !== null) parts.push("(no output)");
  return parts.join("\n\n");
}

export async function webFetchTool(
  ctx: ExecuteContext,
  args: z.infer<typeof WebFetchArgs>,
): Promise<ToolResult> {
  let url: URL;
  try {
    url = new URL(args.url);
  } catch {
    return fail(`not a valid URL: ${args.url}`);
  }
  // Ungated but restricted to http(s): `file:` would be a way around the path
  // gate entirely, which is the one thing a fetch tool must not become.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail(`only http and https URLs can be fetched, not ${url.protocol}`);
  }

  const doFetch = ctx.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { signal: ctx.signal, redirect: "follow" });
  } catch (err) {
    return fail(`could not fetch ${url.href}: ${errorText(err)}`);
  }
  if (!res.ok) return fail(`${url.href} returned HTTP ${res.status} ${res.statusText}`);

  let body: string;
  try {
    body = await res.text();
  } catch (err) {
    return fail(`could not read the body of ${url.href}: ${errorText(err)}`);
  }

  const type = res.headers.get("content-type") ?? "";
  const text = type.includes("html") ? stripHtml(body) : body;
  return ok(truncate(text, MAX_FETCH_BYTES, "page"));
}

/**
 * `web_search`: query the configured backend and render the hits as a numbered
 * list the model can act on — title, URL, one-paragraph snippet.
 *
 * Ungated, like `web_fetch`: a search reads the public web and touches nothing
 * of the user's. The one thing it must not become is a way to reach a non-http
 * URL, and the backend module enforces that on the endpoint while the renderer
 * drops any hit whose URL is not http(s).
 */
export async function webSearchTool(
  ctx: ExecuteContext,
  args: z.infer<typeof WebSearchArgs>,
): Promise<ToolResult> {
  if (ctx.search === undefined) {
    return fail("web_search is not available on this daemon (no search provider is configured)");
  }
  const maxResults = Math.min(args.max_results ?? ctx.search.maxResults, ctx.search.maxResults);
  const doFetch = ctx.fetchImpl ?? fetch;

  let results: Awaited<ReturnType<SearchBackend["search"]>>;
  try {
    results = await ctx.search.backend.search(
      { query: args.query, maxResults, signal: ctx.signal },
      doFetch,
    );
  } catch (err) {
    return fail(`search failed (${ctx.search.backend.id}): ${errorText(err)}`);
  }

  if (results.length === 0) return ok(`no results for: ${args.query}`);
  const lines = results.map((r, i) => {
    const title = r.title === "" ? r.url : r.title;
    const snippet = collapseWhitespace(r.snippet);
    const head = `${i + 1}. ${title}\n   ${r.url}`;
    return snippet === "" ? head : `${head}\n   ${clip(snippet, MAX_SNIPPET_CHARS)}`;
  });
  const n = results.length;
  return ok(`${n} result${n === 1 ? "" : "s"} for: ${args.query}\n\n${lines.join("\n\n")}`);
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Snippets get an ellipsis rather than `truncate`'s banner: it is one line, not a file. */
function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * HTML → rough text.
 *
 * Script and style bodies are dropped first: their contents are text as far as
 * tag-stripping is concerned, and a page's minified bundle would otherwise be
 * the majority of what the worker reads.
 */
export function stripHtml(html: string): string {
  return (
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(?:p|div|h[1-6]|li|tr|section|article)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, " ")
      // Every dropped tag left a space behind, so without this each line begins
      // and ends with one — invisible in a browser, but noise in a worker's
      // context and enough to break an exact quote back out of it.
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
