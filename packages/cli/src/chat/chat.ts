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
import type { OpenAIMessage } from "@rewter/shared";
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
 * Run a conversation of tasks with a live prompt. Returns an exit code.
 *
 * The first instruction comes from argv, or from the first line typed when argv
 * has none. Each subsequent line typed *after* a turn has finished is a
 * follow-up: it starts a new task whose messages carry the whole conversation so
 * far — every prior user line plus the answer each one produced. (Lines typed
 * *while* a turn runs are steering, not turns — see `runTask`.) The daemon sees
 * an ordinary multi-turn OpenAI conversation; `LiveTaskIndex` forgets finished
 * tasks, so the follow-up is a fresh task with a fresh id, and the initiator
 * reads the history straight from the messages. No server-side session state.
 *
 * The assistant turn we append is the answer alone, not the progress feed. The
 * engine's contract makes that recoverable without markup: on success the
 * final answer is the *last* text delta of the stream, on its own, after a
 * separator delta (`engine.ts`, the `finish` path). Progress lines never follow
 * it. A pass-through model (`--model some/model`, no task id) has no feed, so
 * its whole text is the answer. A turn that fails or is cancelled adds no
 * assistant message and ends the session with its exit code — a scripted
 * `rewter chat "…" < /dev/null` keeps its one-shot semantics, and an
 * interactive user retries by relaunching.
 *
 * EOF (Ctrl-D) at the follow-up prompt ends the session with 0; blank lines are
 * ignored, as at any shell.
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

  const rl = createInterface({
    input: opts.io.input,
    output: out as NodeJS.WritableStream,
    prompt: PROMPT,
  });
  const lines = new LineSource(rl);
  try {
    const instruction = promptWords.length > 0 ? promptWords.join(" ") : await askLine(lines, out);
    if (instruction === undefined || instruction.trim() === "") {
      out.write("nothing to do — give me an instruction\n");
      return 1;
    }

    const messages: OpenAIMessage[] = [{ role: "user", content: instruction }];
    for (;;) {
      const turn = await runTask(rl, lines, out, conn, opts.fetch, {
        model,
        messages,
        ...(project !== undefined && { project }),
      });
      if (turn.code !== 0) return turn.code;

      // The turn is over, so this read is modal like the first one. Blank lines
      // re-prompt; EOF ends the session.
      let followUp: string | undefined;
      do {
        followUp = await askLine(lines, out);
      } while (followUp !== undefined && followUp.trim() === "");
      if (followUp === undefined) return 0;
      messages.push(
        { role: "assistant", content: turn.answer },
        { role: "user", content: followUp },
      );
    }
  } finally {
    rl.close();
  }
}

/**
 * Every line typed, in order, for the whole session. readline emits the lines
 * of one chunk synchronously — a paste, or a pipe — so a `once("line")` read
 * between two of them would lose the second. One listener for the session,
 * and two ways to consume: `next()` while no task runs (modal, queue-backed),
 * `attach()` while one does (live, straight to the steering handler).
 */
class LineSource {
  private readonly queue: string[] = [];
  private live: ((line: string) => void) | null = null;
  private wake: (() => void) | null = null;
  private closed = false;

  constructor(rl: Interface) {
    rl.on("line", (line) => {
      if (this.live !== null) {
        this.live(line);
        return;
      }
      this.queue.push(line);
      this.notify();
    });
    rl.once("close", () => {
      this.closed = true;
      this.notify();
    });
  }

  /** The next line not yet consumed; `undefined` once the input is closed and drained. */
  async next(): Promise<string | undefined> {
    while (this.queue.length === 0) {
      if (this.closed) return undefined;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    return this.queue.shift();
  }

  /** Is the queue empty *and* the input gone? Then prompting would be theatre. */
  get exhausted(): boolean {
    return this.closed && this.queue.length === 0;
  }

  /**
   * Route lines to `handler` until `detach()`. Lines already queued go first —
   * a follow-up pasted as two lines means the second one for the task it starts.
   */
  attach(handler: (line: string) => void): void {
    this.live = handler;
    for (const line of this.queue.splice(0)) handler(line);
  }

  detach(): void {
    this.live = null;
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

/** Ask for a line while no task runs — this read *is* modal. `undefined` on EOF. */
function askLine(lines: LineSource, out: ChatIo["output"]): Promise<string | undefined> {
  if (lines.exhausted) return Promise.resolve(undefined);
  out.write(PROMPT);
  return lines.next();
}

interface TaskSpec {
  model: string;
  /** The conversation so far; the last message is the instruction for this turn. */
  messages: OpenAIMessage[];
  project?: string;
}

interface TurnResult {
  /** Process exit code semantics: 0 succeeded, 1 failed, 130 interrupted. */
  code: number;
  /**
   * The final answer, verbatim, when `code` is 0: the last text delta of an
   * orchestrator stream, or the whole text of a pass-through one (see
   * `chatCommand`). Empty when the stream carried no text at all.
   */
  answer: string;
}

async function runTask(
  rl: Interface,
  lines: LineSource,
  out: ChatIo["output"],
  conn: Connection,
  fetchImpl: typeof globalThis.fetch,
  spec: TaskSpec,
): Promise<TurnResult> {
  const abort = new AbortController();
  let stream: Awaited<ReturnType<typeof startChat>>;
  try {
    stream = await startChat(conn, fetchImpl, {
      model: spec.model,
      messages: spec.messages,
      ...(spec.project !== undefined && { project: spec.project }),
      signal: abort.signal,
    });
  } catch (err) {
    if (err instanceof ChatStartError) {
      out.write(`${err.message}\n`);
      return { code: 1, answer: "" };
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
  lines.attach(onLine);

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
  // Kept apart from the line buffer, which merges deltas by row. For an
  // orchestrator run the answer is the last delta alone (engine contract); for a
  // pass-through model every delta is answer, so the whole text is.
  let lastText = "";
  let allText = "";
  const feed = feedLines();
  try {
    for await (const event of stream.events) {
      switch (event.type) {
        case "text":
          lastText = event.text;
          allText += event.text;
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
    lines.detach();
    rl.off("SIGINT", onSigint);
    await steering.catch(() => undefined);
  }

  if (interrupted) {
    render("⊘ cancelled");
    return { code: 130, answer: "" };
  }
  if (failed) return { code: 1, answer: "" };
  // The task id header is what marks an orchestrator run (see `streamOrchestration`).
  return { code: 0, answer: taskId !== undefined ? lastText : allText };
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
