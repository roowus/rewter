/**
 * The tier-3 harness seam: an external coding agent (Claude Code headless, and
 * later anything with a scriptable CLI) driven as a worker.
 *
 * The shape mirrors what the engine already knows how to hold. A harness
 * session is a process the runner (`runner.ts`) wraps into the same
 * `WorkerRunner` contract tiers 1 and 2 implement, so the engine's spawn path,
 * inbox, cancellation tree and lifecycle writes all apply unchanged. What is
 * new is only what an external process forces: events arrive as a stream we do
 * not control the pacing of, and teardown is a `kill()` rather than an aborted
 * fetch.
 *
 * Deliberately narrow. No approval callbacks (the spawn itself is gated, once,
 * by the ordinary `Approvals` choke point — see runner.ts for why per-action
 * gating is not possible from outside the harness), no attach info yet (tmux
 * wrapping is the next slice; this one runs the process directly).
 */
import type { WorkerRunId } from "@rewter/shared";

export interface HarnessSpec {
  /** The complete, self-contained task — the initiator's `instructions`. */
  instructions: string;
  /** Working directory for the harness — the task workspace's cwd. */
  cwd: string;
  /** Names the session (`rwtr_<runId>` once tmux lands); useful in logs now. */
  runId: WorkerRunId;
}

/**
 * What a harness emits, normalized. Adapters translate their CLI's wire format
 * into these; the runner never sees a raw line.
 */
export type HarnessEvent =
  /** The harness announced itself; `sessionId` is its resumable session handle. */
  | { type: "session"; sessionId: string }
  /** Assistant prose — progress worth a feed line, not the final answer. */
  | { type: "text"; text: string }
  /** The harness used one of its own tools. `detail` is already display-sized. */
  | { type: "tool_use"; name: string; detail: string }
  /**
   * One turn finished. `resultText` is the turn's final answer; a session that
   * was sent follow-ups ends more than one turn, and the last result wins.
   */
  | {
      type: "turn_end";
      resultText: string;
      isError: boolean;
      costUsd: number | null;
      inputTokens: number | null;
      outputTokens: number | null;
      cacheReadTokens: number | null;
      cacheWriteTokens: number | null;
    }
  /** The process died without a result: crash, missing binary, bad flags. */
  | { type: "fatal"; error: string };

export interface HarnessSession {
  /**
   * The event stream, ending when the process exits. A `fatal` event, when one
   * occurs, is always the last event.
   */
  events: AsyncIterable<HarnessEvent>;
  /**
   * Deliver a user message mid-session. The harness reads it at its next input
   * opportunity — for Claude Code that is a queued turn, exactly the semantics
   * `send_to_worker` promises. Never throws; a message to a dead process is
   * dropped (the runner sees the exit through `events` either way).
   */
  send(message: string): void;
  /**
   * No more input: close the harness's stdin so it finishes its current turn
   * and exits on its own. The stream-json input mode keeps the process alive
   * waiting for follow-ups, so *somebody* has to say the conversation is over —
   * and only the runner knows (the inbox came up empty at a turn end). Never
   * throws; idempotent.
   */
  end(): void;
  /** Tear the process down. Idempotent. */
  kill(): void;
}

export interface HarnessAdapter {
  /** Stable id — what `ProjectPolicy.allowedHarnesses` lists. */
  id: string;
  /** For approval prompts and feed lines. */
  displayName: string;
  /**
   * Start a session. Must not throw for foreseeable failures (missing binary,
   * spawn error) — those arrive as a `fatal` event so the runner has one
   * failure path, not two.
   */
  spawn(spec: HarnessSpec): HarnessSession;
}
