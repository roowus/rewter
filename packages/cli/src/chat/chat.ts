/**
 * `rewter chat` — the terminal client for the orchestrator.
 *
 * The one behaviour this command exists for: **the input line is never modally
 * bound to the running turn**. The task's feed renders above the prompt while
 * the prompt stays live; anything typed mid-run POSTs to the task's steer
 * endpoint immediately, where the daemon's one steering grammar decides
 * whether it is an approval command or an instruction for the initiator. Other
 * CLIs make you wait for the turn to end; the whole point of the daemon owning
 * the loop is that this one doesn't.
 *
 * Everything else is deliberately thin. The daemon narrates the feed
 * (`orchestrator/narrate.ts` — glyph lines, approval cards, the final answer),
 * so this command renders text it receives rather than reconstructing state:
 * no fold, no socket, just the SSE body and a readline. The fold-backed live
 * task tree is the dashboard's job until a later slice earns it here.
 *
 * Rendering discipline: stream deltas are buffered and flushed per *line*, so
 * redrawing the prompt under them is a clear-line + reprint, not a cursor
 * ballet. Escape codes only ever go to a TTY — piped output gets the plain
 * feed, which also keeps the tests honest.
 */
import { clearLine, createInterface, cursorTo } from "node:readline";
import type { Interface } from "node:readline";
import { cancelTask, discoverDaemon, steerTask } from "./client.js";
import type { Connection } from "./client.js";
import { ChatStartError, startChat } from "./stream.js";

export interface ChatIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WriteStream | NodeJS.WritableStream;
}

export interface ChatOptions {
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  pidfilePath: string;
  io: ChatIo;
}

const PROMPT = "› ";

/**
 * Run one task to completion with a live prompt. Returns an exit code.
 *
 * `argsPrompt` is the initial instruction (from argv); when empty, the first
 * line typed becomes it. Either way there is exactly one task per invocation —
 * multi-turn conversation is a later slice, and a smaller one than it sounds,
 * because steering already covers "one more thing" while the task lives.
 */
export async function chatCommand(args: string[], opts: ChatOptions): Promise<number> {
  const model = flagValue(args, "--model") ?? "auto/orchestrator";
  const project = flagValue(args, "--project") ?? flagValue(args, "-p");
  const promptWords = positional(args, ["--model", "--project", "-p", "--pidfile", "--url"]);
  const out = opts.io.output;

  const found = await discoverDaemon({
    env: withUrlFlag(opts.env, flagValue(args, "--url")),
    pidfilePath: opts.pidfilePath,
    fetch: opts.fetch,
  });
  if (!found.ok) {
    out.write(`${found.reason}\n`);
    return 1;
  }
  const conn = found.connection;

  const rl = createInterface({ input: opts.io.input, output: out as NodeJS.WritableStream });
  try {
    const instruction =
      promptWords.length > 0 ? promptWords.join(" ") : await askFirstLine(rl, out);
    if (instruction === undefined || instruction.trim() === "") {
      out.write("nothing to do — give me an instruction\n");
      return 1;
    }
    return await runTask(rl, out, conn, opts.fetch, {
      model,
      instruction,
      ...(project !== undefined && { project }),
    });
  } finally {
    rl.close();
  }
}

/** With no argv prompt, ask for one — this read *is* modal; the task hasn't started. */
function askFirstLine(rl: Interface, out: ChatIo["output"]): Promise<string | undefined> {
  return new Promise((resolve) => {
    out.write(PROMPT);
    rl.once("line", (line) => resolve(line));
    rl.once("close", () => resolve(undefined));
  });
}

interface TaskSpec {
  model: string;
  instruction: string;
  project?: string;
}

async function runTask(
  rl: Interface,
  out: ChatIo["output"],
  conn: Connection,
  fetchImpl: typeof globalThis.fetch,
  spec: TaskSpec,
): Promise<number> {
  const abort = new AbortController();
  let stream: Awaited<ReturnType<typeof startChat>>;
  try {
    stream = await startChat(conn, fetchImpl, {
      model: spec.model,
      messages: [{ role: "user", content: spec.instruction }],
      ...(spec.project !== undefined && { project: spec.project }),
      signal: abort.signal,
    });
  } catch (err) {
    if (err instanceof ChatStartError) {
      out.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const render = lineRenderer(rl, out);
  const taskId = stream.taskId;
  if (taskId !== undefined) render(`· task ${taskId}`);

  // The live input line. Every line typed while the stream runs goes to the
  // steer endpoint; the echo tells the user what the daemon's parser did with
  // it, because "queued" and "consumed as an approval" look identical at the
  // keyboard and are very different facts.
  let steering = Promise.resolve();
  const onLine = (line: string): void => {
    const message = line.trim();
    if (message === "") return;
    if (taskId === undefined) {
      render("· cannot steer — the daemon did not send a task id (not an orchestrator run?)");
      return;
    }
    // Serialised so two quick lines cannot land out of order.
    steering = steering.then(async () => {
      const result = await steerTask(conn, fetchImpl, taskId, message);
      if (!result.ok) {
        render(`· steering failed: ${result.reason}`);
        return;
      }
      const { queued, remainder, approvals } = result.result;
      if (approvals > 0) render(`· ${approvals} approval command(s) applied`);
      if (queued) render(`· queued for the initiator: ${remainder}`);
      else if (approvals === 0) render("· nothing recognised — empty after parsing");
    });
  };
  rl.on("line", onLine);

  // Ctrl-C is a kill, and an honest one: cancel the task on the daemon (which
  // settles it and stops the spend), not just the local socket.
  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
    render("⊘ cancelling…");
    if (taskId !== undefined) {
      void cancelTask(conn, fetchImpl, taskId).catch(() => undefined);
    }
    abort.abort();
  };
  rl.on("SIGINT", onSigint);

  let failed = false;
  const feed = feedLines();
  try {
    for await (const event of stream.events) {
      switch (event.type) {
        case "text":
          for (const line of feed.push(event.text)) render(line);
          break;
        case "error":
          if (!interrupted) {
            failed = true;
            render(`✖ ${event.message}`);
          }
          break;
        case "usage":
          break;
        case "done":
          break;
      }
    }
  } catch (err) {
    if (!interrupted) throw err;
  } finally {
    for (const line of feed.flush()) render(line);
    rl.off("line", onLine);
    rl.off("SIGINT", onSigint);
    await steering.catch(() => undefined);
  }

  if (interrupted) {
    render("⊘ cancelled");
    return 130;
  }
  return failed ? 1 : 0;
}

/**
 * Deltas in, whole lines out. The feed is line-oriented (glyphs, cards, the
 * answer), and whole lines are what the prompt redraw can be correct under.
 */
function feedLines(): { push: (delta: string) => string[]; flush: () => string[] } {
  let partial = "";
  return {
    push: (delta: string): string[] => {
      partial += delta;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      return lines;
    },
    flush: (): string[] => {
      if (partial === "") return [];
      const last = partial;
      partial = "";
      return [last];
    },
  };
}

/**
 * Print a feed line above a live prompt.
 *
 * On a TTY: clear the prompt row, print the line, re-print the prompt with
 * whatever the user had typed (readline keeps the buffer; `prompt(true)`
 * preserves it). Anywhere else — a pipe, a test — just write the line: escape
 * codes in captured output are noise pretending to be UI.
 */
function lineRenderer(rl: Interface, out: ChatIo["output"]): (line: string) => void {
  const tty = (out as NodeJS.WriteStream).isTTY === true;
  if (!tty) return (line) => out.write(`${line}\n`);
  const stream = out as NodeJS.WriteStream;
  return (line) => {
    clearLine(stream, 0);
    cursorTo(stream, 0);
    stream.write(`${line}\n`);
    rl.prompt(true);
  };
}

/** `REWTER_URL` from a `--url` flag without mutating the caller's env. */
function withUrlFlag(env: NodeJS.ProcessEnv, url: string | undefined): NodeJS.ProcessEnv {
  return url === undefined ? env : { ...env, REWTER_URL: url };
}

// Local copies of index.ts's tiny arg helpers — importing them would drag the
// whole command table into this module's dependency graph for two functions.
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function positional(args: string[], valued: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--") || valued.includes(arg)) {
      if (valued.includes(arg)) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}
