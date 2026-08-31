import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./index.js";

let out: string[];
let err: string[];
let dir: string;

beforeEach(() => {
  out = [];
  err = [];
  dir = mkdtempSync(join(tmpdir(), "rewter-cli-"));
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A scratch config + database in a temp dir, and an env that points the CLI at
 * them. Nothing here touches `~/.rewter`, and no test is allowed a real key.
 */
function scratch(config: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  return { REWTER_CONFIG: path, REWTER_DB: join(dir, "rewter.db"), ...env };
}

/** Answers a catalog request per host, so a sync can hit two upstreams. */
function routedFetch(byHost: Record<string, unknown>): typeof globalThis.fetch {
  return (async (url: string | URL) => {
    const body = byHost[new URL(String(url)).host];
    if (body === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

describe("run", () => {
  it("prints usage for `help`", async () => {
    expect(await run(["help"])).toBe(0);
    expect(out.join("")).toContain("rewter start");
  });

  it("prints usage when given no command", async () => {
    expect(await run([])).toBe(0);
    expect(out.join("")).toContain("Usage:");
  });

  it("documents that keys are read by env var name, not stored", async () => {
    // The one thing a new user must not get wrong.
    await run(["help"]);
    expect(out.join("")).toMatch(/variable \*name\*/);
  });

  it("prints the version", async () => {
    expect(await run(["version"])).toBe(0);
    expect(out.join("")).toMatch(/^rewter \d+\.\d+\.\d+\n$/);
  });

  it("exits non-zero on an unknown command and shows usage", async () => {
    expect(await run(["frobnicate"])).toBe(1);
    expect(err.join("")).toContain("unknown command: frobnicate");
    expect(err.join("")).toContain("Usage:");
  });

  it("documents where launchd gets its keys from — the thing with no shell", async () => {
    await run(["help"]);
    expect(out.join("")).toContain("~/.rewter/env");
  });

  it("rejects a non-numeric --port before touching the database", async () => {
    expect(await run(["start", "--port", "eighty"])).toBe(1);
    expect(err.join("")).toContain("--port is not a number");
  });
});

/**
 * `status` and `stop` against a pidfile this test wrote by hand — which is
 * exactly the situation they are built for: a file left by a process nobody
 * here can see. `fetch` is stubbed to play the daemon that is (or is not)
 * listening at the recorded URL.
 */
describe("run — status/stop", () => {
  const PID = { pid: 4242, url: "http://127.0.0.1:19999", startedAt: 1, version: "0.1.0" };

  /** Writes a pidfile and returns the `--pidfile <path>` args that point at it. */
  function pidfile(entry: Record<string, unknown> = PID): string[] {
    const path = join(dir, "rewter.pid");
    writeFileSync(path, JSON.stringify(entry));
    return ["--pidfile", path];
  }

  /** A stub daemon: answers `/internal/health` with `body`, everything else 404. */
  function health(body: unknown, status = 200): typeof globalThis.fetch {
    return (async (url: string | URL) =>
      String(url).endsWith("/internal/health")
        ? new Response(JSON.stringify(body), { status })
        : new Response("{}", { status: 404 })) as unknown as typeof globalThis.fetch;
  }

  /** Nothing is listening: connect fails the way a dead port does. */
  const refused = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as unknown as typeof globalThis.fetch;

  it("exits non-zero when no daemon is running, so `status && …` behaves", async () => {
    expect(await run(["status", "--pidfile", join(dir, "absent.pid")])).toBe(1);
    expect(err.join("")).toContain("not running");
  });

  it("prints where a running daemon is listening", async () => {
    const fetch = health({ status: "ok", version: "0.1.0", models: 7, providers: 2 });
    expect(await run(["status", ...pidfile()], { fetch })).toBe(0);
    expect(out.join("")).toContain("http://127.0.0.1:19999");
    expect(out.join("")).toContain("2 provider(s), 7 model(s)");
  });

  it("calls a pidfile whose URL does not answer stale, not running", async () => {
    expect(await run(["status", ...pidfile()], { fetch: refused })).toBe(1);
    expect(err.join("")).toContain("stale pidfile");
  });

  it("does not mistake something else on the port for rewter", async () => {
    // Whatever this is, it answers 200 to anything — which is precisely the
    // thing a naive liveness check gets wrong, and `stop` would then signal.
    const fetch = health({ hello: "not rewter" });
    expect(await run(["status", ...pidfile()], { fetch })).toBe(1);
    expect(err.join("")).toContain("not rewter");
  });

  it("refuses to signal a pid when the port is answering as something else", async () => {
    const fetch = health({ hello: "not rewter" });
    expect(await run(["stop", ...pidfile()], { fetch })).toBe(1);
    expect(err.join("")).toContain("refusing to signal pid 4242");
  });

  it("removes a stale pidfile and reports that the last shutdown was not graceful", async () => {
    const args = pidfile();
    expect(await run(["stop", ...args], { fetch: refused })).toBe(0);
    expect(out.join("")).toContain("stale pidfile");
    // Gone, so the next `status` is a plain "not running" rather than a repeat.
    out = [];
    expect(await run(["status", ...args], { fetch: refused })).toBe(1);
    expect(err.join("")).toBe("rewter is not running\n");
  });

  it("treats an unreadable pidfile as no claim at all", async () => {
    // Truncated by a crash mid-write, or written by an older shape. Either way
    // there is no pid here worth signalling.
    expect(await run(["stop", ...pidfile({ pid: "not a number" })], { fetch: refused })).toBe(0);
    expect(out.join("")).toContain("not running");
  });

  it("refuses to start a second daemon over a running one", async () => {
    const fetch = health({ status: "ok", version: "0.1.0" });
    const env = scratch({ providers: [] });
    expect(await run(["start", ...pidfile()], { env, fetch })).toBe(1);
    expect(err.join("")).toContain("already running");
  });
});

/**
 * These drive the real command against a scratch config and database with a
 * stubbed `fetch` — the point is the wiring (config → registry → sync → exit
 * code), not the merge policy, which `sync.test.ts` owns.
 */
describe("run — sync-models", () => {
  const OPENAI = { data: [{ id: "gpt-5" }, { id: "gpt-4o" }] };
  const OPENROUTER = {
    data: [
      {
        id: "openai/gpt-5",
        name: "OpenAI: GPT-5",
        context_length: 400_000,
        pricing: { prompt: "0.00000125", completion: "0.00001" },
      },
    ],
  };

  it("writes the synced models into the daemon's own database", async () => {
    const env = scratch({ providers: [{ preset: "openai" }] }, { OPENAI_API_KEY: "sk-test" });
    const code = await run(["sync-models", "--no-enrich"], {
      env,
      fetch: routedFetch({ "api.openai.com": OPENAI }),
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("openai: 2 added");
    // …and the rows survive the process: a second run sees them already there.
    out = [];
    await run(["sync-models", "--no-enrich"], {
      env,
      fetch: routedFetch({ "api.openai.com": OPENAI }),
    });
    expect(out.join("")).toContain("openai: 0 added");
  });

  it("writes nothing on --dry-run", async () => {
    const env = scratch({ providers: [{ preset: "openai" }] }, { OPENAI_API_KEY: "sk-test" });
    const opts = { env, fetch: routedFetch({ "api.openai.com": OPENAI }) };
    expect(await run(["sync-models", "--dry-run", "--no-enrich"], opts)).toBe(0);
    expect(out.join("")).toContain("nothing written");

    out = [];
    await run(["sync-models", "--no-enrich"], opts);
    expect(out.join("")).toContain("2 added");
  });

  it("fills a thin catalog's prices from OpenRouter by default", async () => {
    const env = scratch(
      { providers: [{ preset: "openai" }, { preset: "openrouter" }] },
      { OPENAI_API_KEY: "sk-test", OPENROUTER_API_KEY: "sk-or" },
    );
    await run(["sync-models"], {
      env,
      fetch: routedFetch({
        "api.openai.com": { data: [{ id: "gpt-5" }] },
        "openrouter.ai": OPENROUTER,
      }),
    });
    expect(err.join("")).not.toContain("prices will not be filled");
  });

  it("warns that --provider filtered enrichment into a no-op", async () => {
    // Enrichment reads OpenRouter out of the same provider list, so scoping it
    // away leaves the prices null — silently, unless we say so.
    const env = scratch(
      { providers: [{ preset: "openai" }, { preset: "openrouter" }] },
      { OPENAI_API_KEY: "sk-test", OPENROUTER_API_KEY: "sk-or" },
    );
    await run(["sync-models", "--provider", "openai"], {
      env,
      fetch: routedFetch({ "api.openai.com": OPENAI }),
    });
    expect(err.join("")).toContain("prices will not be filled");
  });

  it("refuses a --provider that is not in the config", async () => {
    const env = scratch({ providers: [{ preset: "openai" }] }, { OPENAI_API_KEY: "sk-test" });
    expect(await run(["sync-models", "--provider", "groq"], { env })).toBe(1);
    expect(err.join("")).toContain('no provider named "groq"');
  });

  it("exits non-zero when a provider failed, so a cron'd sync goes red", async () => {
    const env = scratch({ providers: [{ preset: "openai" }] }, { OPENAI_API_KEY: "sk-test" });
    const code = await run(["sync-models", "--no-enrich"], {
      env,
      // Nothing answers api.openai.com → 404.
      fetch: routedFetch({}),
    });
    expect(code).toBe(1);
    expect(out.join("")).toContain("openai: failed");
  });
});

/**
 * `logs` reads files rather than the daemon, which is the whole point: the case
 * it exists for is a daemon that is *not* running. Rendering is
 * `service/logs.test.ts`; what is here is the flag handling and the
 * "nothing yet" path a first-time user hits.
 */
describe("run — logs", () => {
  /** Writes both files launchd would, and returns the `--log-dir` args. */
  function logs(outLines: string[], errLines: string[] = []): string[] {
    const logDir = join(dir, "Logs");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "rewter.log"), `${outLines.join("\n")}\n`);
    if (errLines.length > 0) {
      writeFileSync(join(logDir, "rewter.err.log"), `${errLines.join("\n")}\n`);
    }
    return ["--log-dir", logDir];
  }

  const pino = (fields: Record<string, unknown>) =>
    JSON.stringify({ level: 30, time: 1_800_000_000_000, ...fields });

  it("renders the daemon's JSON as something a person can read", async () => {
    const args = logs([pino({ level: 40, msg: "provider disabled" })]);
    expect(await run(["logs", ...args])).toBe(0);
    expect(out.join("")).toContain("WARN");
    expect(out.join("")).toContain("provider disabled");
  });

  it("says so, successfully, when there is nothing logged yet", async () => {
    // Before the first launchd boot neither file exists; that is not a failure.
    expect(await run(["logs", "--log-dir", join(dir, "nowhere")])).toBe(0);
    expect(out.join("")).toContain("no logs yet");
  });

  it("limits with -n, counting from the end", async () => {
    const args = logs([1, 2, 3, 4].map((n) => pino({ time: 1000 + n, msg: `m${n}` })));
    expect(await run(["logs", "-n", "2", ...args])).toBe(0);
    expect(out.join("")).not.toContain("m1");
    expect(out.join("")).toContain("m4");
  });

  it("filters with --level", async () => {
    const args = logs([pino({ msg: "routine" }), pino({ level: 50, msg: "bad" })]);
    await run(["logs", "--level", "warn", ...args]);
    expect(out.join("")).not.toContain("routine");
    expect(out.join("")).toContain("bad");
  });

  it("rejects a level that is not one", async () => {
    expect(await run(["logs", "--level", "loud"])).toBe(1);
    expect(err.join("")).toContain("--level must be one of");
  });

  it("rejects a non-numeric -n", async () => {
    expect(await run(["logs", "-n", "lots"])).toBe(1);
    expect(err.join("")).toContain("-n is not a positive number");
  });
});

/**
 * `install-service` writes a plist and prints instructions. The plist's contents
 * are `service/launchd.test.ts`'s business — here it is the CLI's promise not to
 * run `launchctl` itself, and not to clobber a file you edited.
 */
describe("run — install-service", () => {
  /** Points the install at a scratch `~`, so nothing lands in the real LaunchAgents. */
  function home(): { env: NodeJS.ProcessEnv; plist: string } {
    return {
      env: { HOME: dir },
      plist: join(dir, "Library", "LaunchAgents", "com.roowus.rewter.plist"),
    };
  }

  it("writes the plist and prints the launchctl lines rather than running them", async () => {
    const { env, plist } = home();
    expect(await run(["install-service"], { env })).toBe(0);
    expect(existsSync(plist)).toBe(true);
    expect(out.join("")).toContain("launchctl bootstrap");
    expect(out.join("")).toContain("~/.rewter/env");
  });

  it("writes no keys into it", async () => {
    // `launchctl print` reads this file back to anyone who asks.
    const { env, plist } = home();
    await run(["install-service"], { env });
    expect(readFileSync(plist, "utf8")).not.toContain("EnvironmentVariables");
  });

  it("writes nothing on --dry-run but shows what it would write", async () => {
    const { env, plist } = home();
    expect(await run(["install-service", "--dry-run"], { env })).toBe(0);
    expect(out.join("")).toContain("com.roowus.rewter");
    expect(existsSync(plist)).toBe(false);
  });

  it("refuses to clobber a hand-edited plist, and says how to override", async () => {
    const { env, plist } = home();
    await run(["install-service"], { env });
    writeFileSync(plist, "<!-- mine -->");

    out = [];
    expect(await run(["install-service"], { env })).toBe(1);
    expect(err.join("")).toContain("--force");
    expect(readFileSync(plist, "utf8")).toContain("mine");

    err = [];
    expect(await run(["install-service", "--force"], { env })).toBe(0);
    expect(readFileSync(plist, "utf8")).toContain("com.roowus.rewter");
  });

  it("is quiet when re-run after an upgrade changed nothing", async () => {
    const { env } = home();
    await run(["install-service"], { env });
    out = [];
    expect(await run(["install-service"], { env })).toBe(0);
    expect(out.join("")).toContain("already current");
  });

  it("removes it again, and is a no-op when there is nothing there", async () => {
    const { env, plist } = home();
    await run(["install-service"], { env });

    out = [];
    expect(await run(["uninstall-service"], { env })).toBe(0);
    expect(existsSync(plist)).toBe(false);
    expect(out.join("")).toContain("bootout");

    out = [];
    expect(await run(["uninstall-service"], { env })).toBe(0);
    expect(out.join("")).toContain("nothing installed");
  });
});

describe("run — install-cli", () => {
  /**
   * A scratch `~` with a bin dir on PATH, so nothing lands in the real one —
   * and a scratch entry point, because the real one under vitest is
   * `src/index.ts`, and `install-cli` sets the execute bit on its target.
   * A test that leaves a mode change in `git status` is a test with a bug.
   */
  let entryPoint: string;

  function home(onPath = true): { env: NodeJS.ProcessEnv; link: string } {
    const bin = join(dir, ".local", "bin");
    return {
      env: { HOME: dir, PATH: onPath ? `${bin}:/usr/bin` : "/usr/bin" },
      link: join(bin, "rewter"),
    };
  }

  beforeEach(() => {
    entryPoint = join(dir, "checkout", "index.js");
    mkdirSync(join(dir, "checkout"), { recursive: true });
    writeFileSync(entryPoint, "#!/usr/bin/env node\n", { mode: 0o644 });
  });

  it("links the built entry point and says the word now works", async () => {
    const { env, link } = home();
    expect(await run(["install-cli"], { env, entryPoint })).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // It points at the CLI itself, not at a copy of it.
    expect(realpathSync(link)).toBe(realpathSync(entryPoint));
    expect(out.join("")).toContain("works from anywhere");
  });

  it("prints the export line instead of editing a shell rc when off PATH", async () => {
    const { env } = home(false);
    expect(await run(["install-cli"], { env, entryPoint })).toBe(0);
    expect(out.join("")).toContain("not on your PATH");
    expect(out.join("")).toContain('export PATH="');
    expect(out.join("")).not.toContain("works from anywhere");
  });

  it("writes nothing on --dry-run", async () => {
    const { env, link } = home();
    expect(await run(["install-cli", "--dry-run"], { env, entryPoint })).toBe(0);
    expect(existsSync(link)).toBe(false);
    expect(out.join("")).toContain("would link");
  });

  it("is quiet when re-run against an unchanged link", async () => {
    const { env } = home();
    await run(["install-cli"], { env, entryPoint });
    out = [];
    expect(await run(["install-cli"], { env, entryPoint })).toBe(0);
    expect(out.join("")).toContain("already current");
  });

  it("refuses to clobber someone else's `rewter`, and says how to override", async () => {
    const { env, link } = home();
    mkdirSync(join(dir, ".local", "bin"), { recursive: true });
    writeFileSync(link, "#!/bin/sh\necho not us\n");

    expect(await run(["install-cli"], { env, entryPoint })).toBe(1);
    expect(err.join("")).toContain("--force");
    expect(readFileSync(link, "utf8")).toContain("not us");

    expect(await run(["install-cli", "--force"], { env, entryPoint })).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("honours --dir for a bin directory of the user's choosing", async () => {
    const { env } = home();
    const custom = join(dir, "opt", "bin");
    expect(await run(["install-cli", "--dir", custom], { env, entryPoint })).toBe(0);
    expect(lstatSync(join(custom, "rewter")).isSymbolicLink()).toBe(true);
  });

  it("removes it again, and leaves a file that is not ours alone", async () => {
    const { env, link } = home();
    await run(["install-cli"], { env, entryPoint });

    out = [];
    expect(await run(["uninstall-cli"], { env, entryPoint })).toBe(0);
    expect(existsSync(link)).toBe(false);
    expect(out.join("")).toContain("removed");

    writeFileSync(link, "#!/bin/sh\n");
    out = [];
    expect(await run(["uninstall-cli"], { env, entryPoint })).toBe(0);
    expect(out.join("")).toContain("not a symlink");
    expect(existsSync(link)).toBe(true);
  });
});

/**
 * The installed command, executed as a program.
 *
 * `run()` tests cannot catch this: they call the exported function directly, so
 * the entry-point guard they never touch is exactly where invoking through a
 * symlink used to fail — `process.argv[1]` was the link and `import.meta.url`
 * the file behind it, the guard compared them as strings, and the CLI exited 0
 * having printed nothing. Only a real process with the link as `argv[1]` sees it.
 *
 * Node is invoked explicitly rather than executing the link as a program,
 * because that would depend on the build artifact's mode: `tsc` emits 644, and
 * on a fresh checkout `execFile` on the link is `EACCES` — which CI found and a
 * developer machine hides, `install-cli` having already set the bit there.
 * Setting it is `linkcli`'s job and has its own test; the guard is this one's.
 */
describe("the symlink, executed", () => {
  const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

  it.skipIf(!existsSync(entry))("is left executable by the build", () => {
    // `tsc` emits 644, so `build` chmods. Without that, `pnpm build` breaks an
    // already-installed `rewter` with `permission denied` — which is how this
    // was found: by the user, after a rebuild, on a command that had worked.
    expect(lstatSync(entry).mode & 0o111).toBe(0o111);
  });

  it.skipIf(!existsSync(entry))("runs the command when invoked through the link", () => {
    const link = join(dir, "rewter");
    symlinkSync(entry, link);
    const result = execFileSync(process.execPath, [link, "version"], { encoding: "utf8" });
    expect(result).toContain("rewter 0.1.0");
  });

  it.skipIf(!existsSync(entry))("runs the same way when invoked directly", () => {
    const result = execFileSync(process.execPath, [entry, "version"], { encoding: "utf8" });
    expect(result).toContain("rewter 0.1.0");
  });
});

/**
 * `gc` against the scratch database. What gets collected is
 * `service/gc.test.ts`'s business; here it is that the command opens the same
 * database the daemon uses and honours the flags.
 */
describe("run — gc", () => {
  it("reports an empty database as nothing to collect", async () => {
    const env = scratch({ providers: [] });
    expect(await run(["gc"], { env })).toBe(0);
    expect(out.join("")).toContain("nothing to collect");
  });

  it("marks a dry run as one", async () => {
    const env = scratch({ providers: [] });
    expect(await run(["gc", "--dry-run"], { env })).toBe(0);
    expect(out.join("")).toContain("nothing to collect");
  });

  it("rejects a non-numeric --older-than before opening anything", async () => {
    expect(await run(["gc", "--older-than", "ages"])).toBe(1);
    expect(err.join("")).toContain("--older-than is not a number");
  });

  it("vacuums only when asked, and leaves the database usable", async () => {
    const env = scratch({ providers: [] });
    expect(await run(["gc", "--vacuum"], { env })).toBe(0);
    expect(out.join("")).toContain("vacuumed");

    // The database still opens afterwards — the point of the assertion.
    out = [];
    expect(await run(["gc"], { env })).toBe(0);
  });

  it("does not vacuum on a dry run", async () => {
    const env = scratch({ providers: [] });
    await run(["gc", "--dry-run", "--vacuum"], { env });
    expect(out.join("")).not.toContain("vacuumed");
  });
});

/**
 * Card generation through the CLI. The parsing and normalization live in
 * `registry/cards.test.ts`; what is under test here is the wiring and the
 * guards that stand between a typo and a bill.
 */
describe("run — card", () => {
  const CONFIG = {
    providers: [{ preset: "openai" }],
    models: [
      { id: "openai/gpt-5", provider: "openai" },
      { id: "openai/gpt-4o", provider: "openai" },
    ],
  };

  const CARD = JSON.stringify({
    summary: "Fast general-purpose model.",
    strengths: ["coding", "reasoning"],
    weaknesses: [],
    bestAt: ["coding"],
    notes: null,
  });

  /**
   * An OpenAI-shaped SSE completion carrying `content`. The router streams
   * everything — even a one-shot `complete()` collects a stream — so a plain
   * JSON body would be read as a stream that ended without a finish_reason.
   */
  function completionFetch(content: string): typeof globalThis.fetch {
    const chunk = (delta: unknown, finish: string | null = null) =>
      JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o",
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
    const usage = JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o",
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    });
    const body = [
      `data: ${chunk({ role: "assistant", content: "" })}\n\n`,
      `data: ${chunk({ content })}\n\n`,
      `data: ${chunk({}, "stop")}\n\n`,
      `data: ${usage}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    return (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof globalThis.fetch;
  }

  it("writes a card and prints it", async () => {
    const env = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    const opts = { env, fetch: completionFetch(CARD) };
    expect(await run(["card", "openai/gpt-5", "--using", "openai/gpt-4o"], opts)).toBe(0);
    expect(out.join("")).toContain("best at:    coding");

    // …and it persisted: `--show` reads it back out of the same database.
    out = [];
    expect(await run(["card", "openai/gpt-5", "--show"], { env })).toBe(0);
    expect(out.join("")).toContain("Fast general-purpose model.");
  });

  it("requires --using rather than picking a generator for you", async () => {
    // The generator is billed and its judgement outlives the call; choosing it
    // silently is the wrong kind of convenience.
    const env = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    expect(await run(["card", "openai/gpt-5"], { env })).toBe(1);
    expect(err.join("")).toContain("--using");
  });

  it("refuses an unknown --using before spending anything", async () => {
    const env = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    let called = false;
    const fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    expect(await run(["card", "openai/gpt-5", "--using", "nope/nope"], { env, fetch })).toBe(1);
    expect(err.join("")).toContain("unknown model: nope/nope");
    expect(called).toBe(false);
  });

  it("refuses an unknown target model", async () => {
    const env = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    expect(await run(["card", "openai/ghost", "--using", "openai/gpt-4o"], { env })).toBe(1);
    expect(err.join("")).toContain("unknown model(s): openai/ghost");
  });

  it("does not treat a bare `card` as every model", async () => {
    // A synced registry is hundreds of rows; an implicit --all is hundreds of
    // billed calls.
    const env = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    expect(await run(["card", "--using", "openai/gpt-4o"], { env })).toBe(1);
    expect(err.join("")).toContain("--all");
  });

  it("writes nothing on --dry-run", async () => {
    const env = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    const opts = { env, fetch: completionFetch(CARD) };
    expect(await run(["card", "openai/gpt-5", "--using", "openai/gpt-4o", "--dry-run"], opts)).toBe(
      0,
    );
    expect(out.join("")).toContain("nothing written");

    out = [];
    expect(await run(["card", "openai/gpt-5", "--show"], { env })).toBe(1);
    expect(out.join("")).toContain("no cards yet");
  });

  it("exits non-zero when the generator's reply had no card in it", async () => {
    const env = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    const opts = { env, fetch: completionFetch("I'm sorry, I can't help with that.") };
    expect(await run(["card", "openai/gpt-5", "--using", "openai/gpt-4o"], opts)).toBe(1);
    expect(out.join("")).toContain("failed");
  });

  it("skips a model that already has a card unless told to regenerate", async () => {
    const env = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    const opts = { env, fetch: completionFetch(CARD) };
    await run(["card", "openai/gpt-5", "--using", "openai/gpt-4o"], opts);

    out = [];
    expect(await run(["card", "openai/gpt-5", "--using", "openai/gpt-4o"], opts)).toBe(0);
    expect(out.join("")).toContain("already has a card");

    out = [];
    const args = ["card", "openai/gpt-5", "--using", "openai/gpt-4o", "--regenerate"];
    expect(await run(args, opts)).toBe(0);
    expect(out.join("")).toContain("best at:    coding");
  });
});

/**
 * Moving a registry between machines, as two files-on-disk commands.
 *
 * The bundle format is `shared/transfer.test.ts` and the merge is
 * `registry/transfer.ts`; what is under test here is what the CLI adds — that
 * the file written is the file read back, that the promise in the header
 * ("no keys") holds against the actual bytes, and that the failures a person
 * hits with a wrong file say which file and why.
 */
describe("run — export-registry / import-registry", () => {
  const CONFIG = {
    providers: [{ preset: "openai" }],
    models: [
      { id: "openai/gpt-5", provider: "openai", contextWindow: 400_000 },
      { id: "openai/gpt-4o", provider: "openai" },
    ],
  };

  /** A second machine: same command, its own config and database. */
  function elsewhere(config: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) {
    const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(config));
    return { REWTER_CONFIG: path, REWTER_DB: join(dir, `${basename(path)}.db`), ...env };
  }

  it("writes a file, and reads it back into an empty registry", async () => {
    const here = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    const file = join(dir, "bundle.json");
    expect(await run(["export-registry", file], { env: here })).toBe(0);
    expect(out.join("")).toContain("2 models");

    // The far machine knows the provider but none of the models.
    const there = elsewhere({ providers: [{ preset: "openai" }] }, { OPENAI_API_KEY: "sk-test" });
    out = [];
    expect(await run(["import-registry", file], { env: there })).toBe(0);
    expect(out.join("")).toContain("models: 2 added");

    // …and they are really there: a second import finds them already present.
    out = [];
    expect(await run(["import-registry", file], { env: there })).toBe(0);
    expect(out.join("")).toContain("2 already here");
    expect(out.join("")).toContain("--overwrite");
  });

  it("writes a bundle with no key material in it, anywhere", async () => {
    // The claim the whole feature rests on, checked against bytes rather than
    // against the schema that is supposed to enforce it.
    const here = scratch(CONFIG, { OPENAI_API_KEY: "sk-secret-do-not-export" });
    const file = join(dir, "bundle.json");
    await run(["export-registry", file], { env: here });

    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("sk-secret-do-not-export");
    expect(text).not.toContain("apiKeyRef");
    expect(text).not.toContain("OPENAI_API_KEY");
    // It does carry the identity needed to match a provider on the far side.
    expect(JSON.parse(text).providers[0].name).toBe("OpenAI");
  });

  it("writes to stdout when named no file, so it can be piped", async () => {
    const here = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    expect(await run(["export-registry"], { env: here })).toBe(0);
    const bundle = JSON.parse(out.join(""));
    expect(bundle.models).toHaveLength(2);
    expect(bundle.version).toBe(1);
  });

  it("does not mistake a --note for the filename", async () => {
    const here = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    expect(await run(["export-registry", "--note", "before reinstall"], { env: here })).toBe(0);
    expect(JSON.parse(out.join("")).note).toBe("before reinstall");
    expect(existsSync(join(dir, "before reinstall"))).toBe(false);
  });

  it("writes nothing on --dry-run, and says so", async () => {
    const here = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    const file = join(dir, "bundle.json");
    await run(["export-registry", file], { env: here });

    const there = elsewhere({ providers: [{ preset: "openai" }] }, { OPENAI_API_KEY: "sk-test" });
    out = [];
    expect(await run(["import-registry", file, "--dry-run"], { env: there })).toBe(0);
    expect(out.join("")).toContain("2 added");
    expect(out.join("")).toContain("nothing written");

    // The preview really was a preview: the real run still has both to add.
    out = [];
    await run(["import-registry", file], { env: there });
    expect(out.join("")).toContain("models: 2 added");
  });

  it("leaves models already here alone unless --overwrite", async () => {
    const here = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    const file = join(dir, "bundle.json");
    await run(["export-registry", file], { env: here });

    // Same machine, so both models are already present.
    out = [];
    expect(await run(["import-registry", file, "--overwrite"], { env: here })).toBe(0);
    expect(out.join("")).toContain("2 replaced");
  });

  it("names the provider the far machine does not have, and exits non-zero", async () => {
    // The one failure with a fix — and a scripted import needs to go red when
    // its models did not land.
    const here = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    const file = join(dir, "bundle.json");
    await run(["export-registry", file], { env: here });

    const there = elsewhere(
      { providers: [{ preset: "anthropic" }] },
      { ANTHROPIC_API_KEY: "sk-t" },
    );
    out = [];
    expect(await run(["import-registry", file], { env: there })).toBe(1);
    expect(out.join("")).toContain("OpenAI");
    expect(out.join("")).toContain("2 models skipped");
    expect(out.join("")).toContain("an import never creates one");
  });

  it("refuses a bundle from a rewter that is not this one, by version", async () => {
    const file = join(dir, "future.json");
    writeFileSync(file, JSON.stringify({ version: 9, providers: [], models: [], cards: [] }));
    const there = elsewhere({ providers: [{ preset: "openai" }] }, { OPENAI_API_KEY: "sk-test" });
    expect(await run(["import-registry", file], { env: there })).toBe(1);
    expect(err.join("")).toContain("made by a newer rewter");
    expect(err.join("")).toContain("v9");
  });

  it("says which file is not JSON, rather than throwing", async () => {
    const file = join(dir, "notes.txt");
    writeFileSync(file, "these are my notes");
    const there = elsewhere({ providers: [{ preset: "openai" }] }, { OPENAI_API_KEY: "sk-test" });
    expect(await run(["import-registry", file], { env: there })).toBe(1);
    expect(err.join("")).toContain("notes.txt: not JSON");
  });

  it("names the field when a bundle is JSON but not a bundle", async () => {
    const file = join(dir, "half.json");
    writeFileSync(file, JSON.stringify({ version: 1, exportedAt: 1, providers: [], models: [{}] }));
    const there = elsewhere({ providers: [{ preset: "openai" }] }, { OPENAI_API_KEY: "sk-test" });
    expect(await run(["import-registry", file], { env: there })).toBe(1);
    expect(err.join("")).toContain("not a rewter registry bundle");
    expect(err.join("")).toContain("models.0");
  });

  it("asks for a filename rather than guessing one", async () => {
    const there = elsewhere({ providers: [{ preset: "openai" }] }, { OPENAI_API_KEY: "sk-test" });
    expect(await run(["import-registry"], { env: there })).toBe(1);
    expect(err.join("")).toContain("name a bundle file");
  });
});
