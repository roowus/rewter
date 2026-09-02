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
 * gating is not possible from outside the harness). Attach is a *mirror*, not
 * the process's own pty: headless harnesses have no visual UI — their stdout is
 * NDJSON — so `withTmuxMirror` (tmux.ts) tees the normalized events into a
 * rendered log a tmux session tails, and `attach` names that session.
 */
import type { WorkerRunId } from "@rewter/shared";

export interface HarnessSpec {
  /** The complete, self-contained task — the initiator's `instructions`. */
  instructions: string;
  /** Working directory for the harness — the task workspace's cwd. */
  cwd: string;
  /** Names the tmux mirror session (`rwtr_<runId>`) and the log it tails. */
  runId: WorkerRunId;
  /**
   * Resume a previous session instead of starting fresh. The value is a
   * `session` event's `sessionId` from an earlier run — persisted as
   * `WorkerRun.harnessSessionId`, which is what survives a daemon restart.
   * The harness reloads its own conversation history (for Claude Code,
   * `--resume`); `instructions` become the first *new* message in the resumed
   * session, so they should say "continue" things, not restate the task.
   */
  resumeSessionId?: string | undefined;
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

/** How a human watches a running harness session from a terminal. */
export interface HarnessAttachInfo {
  /** The tmux session name (`rwtr_<runId>`). */
  session: string;
  /** The command to paste: `tmux attach -t rwtr_<runId>`. */
  command: string;
}

export interface HarnessSession {
  /**
   * The event stream, ending when the process exits. A `fatal` event, when one
   * occurs, is always the last event.
   */
  events: AsyncIterable<HarnessEvent>;
  /**
   * Present when a live mirror exists for this session (see tmux.ts). The
   * runner surfaces `command` as a progress line so the feed carries the
   * attach instructions while the session is still running. Absent = no
   * mirror; the session itself is unaffected.
   */
  attach?: HarnessAttachInfo | undefined;
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
