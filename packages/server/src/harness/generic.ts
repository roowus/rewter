/**
 * Any CLI as a harness, described by config instead of code.
 *
 * The claude-code adapter exists because Claude Code has a wire format worth
 * knowing; every other coding CLI would need the same ~200 lines of spawn /
 * line-buffer / fatal plumbing wrapped around a different parse. This adapter
 * is that plumbing once, with the parse chosen by config:
 *
 *  - **`parse: "jsonl"`** — the *generic JSON adapter spec*. The process emits
 *    newline-delimited JSON objects shaped like rewter's own harness events:
 *    `{"type":"text","text":…}`, `{"type":"tool_use","name":…,"detail":…}`,
 *    `{"type":"turn_end","resultText":…,"isError":…,"costUsd":…,…}`, and
 *    optionally `{"type":"session","sessionId":…}` (which makes the run
 *    resumable — only emit it if `resumeArgs` is also configured, or the
 *    restart header will offer a resume the adapter cannot honor). A CLI that
 *    speaks anything else gets a five-line wrapper script; the spec is the
 *    contract, the wrapper is the adapter. Parsing is defensive like
 *    claude-code's: unknown lines and unparseable JSON are skipped, never a
 *    throw — the wire belongs to another program.
 *  - **`parse: "plain"`** — stdout lines become `text` events. With a
 *    `donePattern` (a regex tested per line), a matching line is a sentinel: it
 *    ends the turn with everything accumulated since the last boundary as the
 *    result, and is itself excluded from it — REPL-style CLIs get multi-turn
 *    `send()` for free. Without one, the *process exit* is the turn end: exit 0
 *    succeeds with the accumulated output, non-zero fails with it (or with the
 *    stderr tail when stdout was empty) — a one-shot CLI's exit code is its
 *    honest result contract.
 *
 * The task arrives via the command template when any element of `args`
 * contains `{instructions}`; otherwise it is written to stdin followed by a
 * newline. Follow-ups (`send_to_worker`) are always plain stdin lines. `{cwd}`
 * substitutes anywhere in `args`; `{sessionId}` substitutes in `resumeArgs`,
 * which are appended only when resuming. A resume requested of an entry
 * without `resumeArgs` is a `fatal`, not a silent fresh start — the initiator
 * asked for a conversation this adapter cannot reload, and pretending
 * otherwise would hand it a stranger claiming to remember.
 *
 * Env passes through untouched: unlike Claude Code, an arbitrary CLI routed at
 * this daemon is a decision the owner made in config, not a recursion hazard
 * baked into ~/.claude/settings.json.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { z } from "zod";
import { EventQueue } from "./queue.js";
import type { HarnessAdapter, HarnessEvent, HarnessSession, HarnessSpec } from "./types.js";

export interface GenericHarnessOptions {
  /**
   * Adapter id: what `ProjectPolicy.allowedHarnesses` lists and what costs are
   * billed under (`harness/<id>`). Config validates the shape and uniqueness.
   */
  id: string;
  /** Shown in approval summaries and worker labels; defaults to the id. */
  displayName?: string | undefined;
  /** Binary name or absolute path — absolute under launchd (no user PATH). */
  binary: string;
  /**
   * Command template. `{instructions}` and `{cwd}` substitute inside each
   * element (argv array, no shell — substitution cannot inject). If no element
   * mentions `{instructions}`, the task is delivered on stdin instead.
   */
  args?: string[] | undefined;
  parse: "jsonl" | "plain";
  /**
   * plain mode only: a regex tested against each stdout line. A match ends the
   * turn; the matching line is a sentinel, not part of the result.
   */
  donePattern?: string | undefined;
  /**
   * Extra argv appended when resuming; `{sessionId}` substitutes inside each
   * element. Absent = this harness cannot resume, and a resume request fails
   * loudly rather than silently starting fresh.
   */
  resumeArgs?: string[] | undefined;
}

/**
 * The generic JSON adapter spec, as zod: what a jsonl-mode process may say.
 * Mirrors HarnessEvent minus `fatal` (a process does not get to declare its
 * own death — exits and spawn errors do that) with lenient optionality, so a
 * minimal wrapper writes `{"type":"turn_end","resultText":"done"}` and no more.
 */
const GenericLineSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session"), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    name: z.string().min(1),
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal("turn_end"),
    resultText: z.string().optional(),
    isError: z.boolean().optional(),
    costUsd: z.number().nullable().optional(),
    inputTokens: z.number().int().nonnegative().nullable().optional(),
    outputTokens: z.number().int().nonnegative().nullable().optional(),
    cacheReadTokens: z.number().int().nonnegative().nullable().optional(),
    cacheWriteTokens: z.number().int().nonnegative().nullable().optional(),
  }),
]);

/** One line, bounded — the same display contract toolDetail keeps upstream. */
function displayClamp(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= 120 ? flat : `${flat.slice(0, 119)}…`;
}

/** jsonl mode: one wire line → zero or more events. Never throws. */
export function jsonlToEvents(line: string): HarnessEvent[] {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return []; // Not JSON: the CLI logs like a human sometimes. Skip.
  }
  const parsed = GenericLineSchema.safeParse(json);
  if (!parsed.success) return [];
  const data = parsed.data;
  switch (data.type) {
    case "session":
      return [{ type: "session", sessionId: data.sessionId }];
    case "text":
      return data.text.trim() === "" ? [] : [{ type: "text", text: data.text }];
    case "tool_use":
      return [{ type: "tool_use", name: data.name, detail: displayClamp(data.detail ?? "") }];
    case "turn_end":
      return [
        {
          type: "turn_end",
          resultText: data.resultText ?? "",
          isError: data.isError ?? false,
          costUsd: data.costUsd ?? null,
          inputTokens: data.inputTokens ?? null,
          outputTokens: data.outputTokens ?? null,
          cacheReadTokens: data.cacheReadTokens ?? null,
          cacheWriteTokens: data.cacheWriteTokens ?? null,
        },
      ];
  }
}

/** `{placeholder}` substitution inside argv elements — array exec, no shell. */
function substitute(template: string, values: Record<string, string>): string {
  return template.replace(/\{(instructions|cwd|sessionId)\}/g, (match, key: string) => {
    const value = values[key];
    return value !== undefined ? value : match;
  });
}

/** A turn end a generic process reports without numbers: no cost, no tokens. */
function plainTurnEnd(resultText: string, isError: boolean): HarnessEvent {
  return {
    type: "turn_end",
    resultText,
    isError,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  };
}

export function createGenericAdapter(opts: GenericHarnessOptions): HarnessAdapter {
  // Config validated this compiles; parsing it here keeps the adapter honest
  // when constructed directly (tests, future callers).
  const donePattern = opts.donePattern !== undefined ? new RegExp(opts.donePattern) : null;

  return {
    id: opts.id,
    displayName: opts.displayName ?? opts.id,
    spawn(spec: HarnessSpec): HarnessSession {
      const queue = new EventQueue();
      let fatalPushed = false;
      let killed = false;

      const fatal = (error: string): void => {
        if (fatalPushed) return;
        fatalPushed = true;
        queue.push({ type: "fatal", error });
      };

      const noopSession = (): HarnessSession => ({
        events: queue.events(),
        send: () => {},
        end: () => {},
        kill: () => {},
      });

      if (spec.resumeSessionId !== undefined && opts.resumeArgs === undefined) {
        fatal(
          `${opts.id} cannot resume a session: no resumeArgs configured for this harness. Spawn a fresh worker instead.`,
        );
        queue.close();
        return noopSession();
      }

      const values: Record<string, string> = {
        instructions: spec.instructions,
        cwd: spec.cwd,
        ...(spec.resumeSessionId !== undefined ? { sessionId: spec.resumeSessionId } : {}),
      };
      const templateArgs = opts.args ?? [];
      const argv = [
        ...templateArgs.map((a) => substitute(a, values)),
        ...(spec.resumeSessionId !== undefined
          ? (opts.resumeArgs ?? []).map((a) => substitute(a, values))
          : []),
      ];
      const instructionsInArgv = templateArgs.some((a) => a.includes("{instructions}"));

      let child: ChildProcessWithoutNullStreams | null = null;
      try {
        child = spawn(opts.binary, argv, {
          cwd: spec.cwd,
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        fatal(
          `could not start ${opts.binary}: ${err instanceof Error ? err.message : String(err)}`,
        );
        queue.close();
        return noopSession();
      }

      const proc = child;
      proc.on("error", (err) => {
        fatal(`could not start ${opts.binary}: ${err.message}`);
        queue.close();
      });

      let sawTurnEnd = false;
      // plain mode: the result under construction — lines since the last turn
      // boundary, sentinel lines excluded.
      let accumulated: string[] = [];

      const handleLine = (line: string): void => {
        if (opts.parse === "jsonl") {
          for (const event of jsonlToEvents(line)) {
            if (event.type === "turn_end") sawTurnEnd = true;
            queue.push(event);
          }
          return;
        }
        if (line.trim() === "") return;
        if (donePattern?.test(line)) {
          sawTurnEnd = true;
          queue.push(plainTurnEnd(accumulated.join("\n"), false));
          accumulated = [];
          return;
        }
        accumulated.push(line);
        queue.push({ type: "text", text: line });
      };

      let buffer = "";
      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });

      let stderrTail = "";
      proc.stderr.on("data", (data: Buffer) => {
        stderrTail = (stderrTail + data.toString("utf8")).slice(-2000);
      });

      proc.on("close", (code) => {
        // A final line without a trailing newline is still a line.
        if (buffer.trim() !== "") handleLine(buffer);
        buffer = "";
        if (!fatalPushed && !killed && !sawTurnEnd) {
          if (opts.parse === "plain" && donePattern === null) {
            // No sentinel configured: the exit *is* the turn end. Non-zero is
            // the CLI saying it ran and failed — a result, not a fatal.
            const text = accumulated.join("\n");
            const failedSilently = code !== 0 && text.trim() === "";
            queue.push(plainTurnEnd(failedSilently ? stderrTail.trim() : text, (code ?? 1) !== 0));
          } else {
            const why = stderrTail.trim() === "" ? "" : `: ${stderrTail.trim()}`;
            fatal(`${opts.binary} exited (code ${code ?? "?"}) without a result${why}`);
          }
        }
        queue.close();
      });

      // EPIPE from a dead child must not take the daemon down; the exit is
      // reported through 'close' either way.
      proc.stdin.on("error", () => {});
      if (!instructionsInArgv) proc.stdin.write(`${spec.instructions}\n`);

      return {
        events: queue.events(),
        send(message: string): void {
          if (proc.exitCode !== null || killed) return;
          proc.stdin.write(`${message}\n`);
        },
        end(): void {
          if (proc.exitCode !== null || killed) return;
          proc.stdin.end();
        },
        kill(): void {
          if (killed) return;
          killed = true;
          proc.kill("SIGTERM");
        },
      };
    },
  };
}
