/**
 * Headless Claude Code as a harness.
 *
 * `claude -p --input-format stream-json --output-format stream-json` turns the
 * CLI into exactly the shape `HarnessSession` wants: newline-delimited JSON
 * events on stdout, user messages accepted on stdin at any time (Claude Code
 * queues one that arrives mid-turn and reads it at the next turn boundary —
 * the semantics `send_to_worker` promises), and a process that exits when
 * stdin closes after its last turn.
 *
 * The wire format is parsed *defensively*: every line goes through a loose zod
 * schema and anything unrecognized is skipped, because the format belongs to
 * another program's release cycle. The four shapes we do read — `system/init`
 * (session id), `assistant` (text + tool_use blocks), `result` (turn end with
 * cost and usage), and a JSON line that refuses to parse — degrade to "skip",
 * never to a throw. A harness that crashed rewter by updating itself would be
 * a supply-chain bug of our own making.
 *
 * Env: the child gets the daemon's environment minus `ANTHROPIC_BASE_URL` and
 * `ANTHROPIC_AUTH_TOKEN`. Those two are how a machine points Claude Code at a
 * router — this daemon, typically — and a harness that routed back through
 * the process that spawned it would recurse: task → harness → /v1 → task.
 * Stripped, the child falls back to its own login (`~/.claude`), which is the
 * subscription the owner installed it with.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { z } from "zod";
import type { HarnessAdapter, HarnessEvent, HarnessSession, HarnessSpec } from "./types.js";

export interface ClaudeCodeOptions {
  /** Binary name or absolute path; resolved through PATH like any spawn. */
  binary: string;
  /**
   * Claude Code's own permission stance, passed as `--permission-mode`.
   * Headless has no human to prompt, so "default" would park forever on the
   * first gated tool; "acceptEdits" lets it edit inside its cwd while shell
   * commands still refuse-and-adapt. The *spawn* is what rewter gates — one
   * approval, honestly labelled, because per-action gating cannot reach inside
   * another program (see runner.ts).
   */
  permissionMode: string;
}

/** What we read from the wire; everything else is skipped, never rejected. */
const InitLineSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string().min(1),
});

const AssistantLineSchema = z.object({
  type: z.literal("assistant"),
  message: z.object({
    content: z.array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({ type: z.literal("tool_use"), name: z.string(), input: z.unknown() }),
        // Thinking blocks, images, future block types: acknowledged so the
        // array parse survives them, rendered as nothing.
        z
          .object({ type: z.string() })
          .passthrough(),
      ]),
    ),
  }),
});

const ResultLineSchema = z.object({
  type: z.literal("result"),
  is_error: z.boolean(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
      cache_read_input_tokens: z.number().int().nonnegative().optional(),
      cache_creation_input_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

/** Tool input rendered for a feed line: one line, bounded, never a throw. */
function toolDetail(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? "";
  } catch {
    text = "(unserializable input)";
  }
  const flat = text.replace(/\s+/g, " ");
  return flat.length <= 120 ? flat : `${flat.slice(0, 119)}…`;
}

export function toEvents(line: string): HarnessEvent[] {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return []; // Not ours to understand — --verbose interleaves human-ish lines.
  }

  const init = InitLineSchema.safeParse(json);
  if (init.success) return [{ type: "session", sessionId: init.data.session_id }];

  const assistant = AssistantLineSchema.safeParse(json);
  if (assistant.success) {
    const events: HarnessEvent[] = [];
    for (const block of assistant.data.message.content) {
      // `typeof` guards, not just `in`: the passthrough member widens every
      // field to unknown, so the union narrows on the value, not the key.
      if (block.type === "text" && "text" in block && typeof block.text === "string") {
        if (block.text.trim() !== "") events.push({ type: "text", text: block.text });
      }
      if (block.type === "tool_use" && "name" in block && typeof block.name === "string") {
        const input = "input" in block ? block.input : undefined;
        events.push({ type: "tool_use", name: block.name, detail: toolDetail(input) });
      }
    }
    return events;
  }

  const result = ResultLineSchema.safeParse(json);
  if (result.success) {
    const usage = result.data.usage;
    return [
      {
        type: "turn_end",
        resultText: result.data.result ?? "",
        isError: result.data.is_error,
        costUsd: result.data.total_cost_usd ?? null,
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
        cacheReadTokens: usage?.cache_read_input_tokens ?? null,
        cacheWriteTokens: usage?.cache_creation_input_tokens ?? null,
      },
    ];
  }

  return [];
}

/** A stream-json stdin frame: how both the task and every follow-up arrive. */
export function userFrame(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

/**
 * The push-pull seam between a process's events and an AsyncIterable: the
 * process pushes, the runner pulls, whichever side arrives first waits for
 * the other. `close()` ends iteration after the queue drains, so a fatal
 * pushed just before close is still delivered — the "fatal is always last"
 * guarantee in types.ts rests on this ordering.
 */
export class EventQueue {
  private queue: HarnessEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(event: HarnessEvent): void {
    if (this.closed) return;
    this.queue.push(event);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *events(): AsyncIterable<HarnessEvent> {
    while (true) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}

export function createClaudeCodeAdapter(opts: ClaudeCodeOptions): HarnessAdapter {
  return {
    id: "claude-code",
    displayName: "Claude Code",
    spawn(spec: HarnessSpec): HarnessSession {
      const queue = new EventQueue();
      let child: ChildProcessWithoutNullStreams | null = null;
      let sawTurnEnd = false;
      let fatalPushed = false;
      let killed = false;

      const fatal = (error: string): void => {
        if (fatalPushed) return;
        fatalPushed = true;
        queue.push({ type: "fatal", error });
      };

      const { ANTHROPIC_BASE_URL: _url, ANTHROPIC_AUTH_TOKEN: _token, ...env } = process.env;

      try {
        child = spawn(
          opts.binary,
          [
            "-p",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            // Required by the CLI when -p emits stream-json; also what makes
            // the init line (and with it the session id) appear at all.
            "--verbose",
            "--permission-mode",
            opts.permissionMode,
          ],
          { cwd: spec.cwd, env, stdio: ["pipe", "pipe", "pipe"] },
        );
      } catch (err) {
        // spawn() itself threw (bad cwd on some platforms, EMFILE). The async
        // 'error' path below covers the common ENOENT; this covers the rest.
        fatal(
          `could not start ${opts.binary}: ${err instanceof Error ? err.message : String(err)}`,
        );
        queue.close();
        return {
          events: queue.events(),
          send: () => {},
          end: () => {},
          kill: () => {},
        };
      }

      const proc = child;
      proc.on("error", (err) => {
        fatal(`could not start ${opts.binary}: ${err.message}`);
        queue.close();
      });

      let buffer = "";
      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() === "") continue;
          for (const event of toEvents(line)) {
            if (event.type === "turn_end") sawTurnEnd = true;
            queue.push(event);
          }
        }
      });

      // Kept small and only surfaced when the process dies without a result:
      // stderr is where the CLI explains a bad flag or an auth failure.
      let stderrTail = "";
      proc.stderr.on("data", (data: Buffer) => {
        stderrTail = (stderrTail + data.toString("utf8")).slice(-2000);
      });

      proc.on("close", (code) => {
        if (!sawTurnEnd && !fatalPushed && !killed) {
          const why = stderrTail.trim() === "" ? "" : `: ${stderrTail.trim()}`;
          fatal(`${opts.binary} exited (code ${code ?? "?"}) without a result${why}`);
        }
        queue.close();
      });

      // EPIPE from a dead child must not take the daemon down; the exit is
      // reported through 'close' either way.
      proc.stdin.on("error", () => {});
      proc.stdin.write(userFrame(spec.instructions));

      return {
        events: queue.events(),
        send(message: string): void {
          if (proc.exitCode !== null || killed) return;
          proc.stdin.write(userFrame(message));
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
