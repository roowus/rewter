/**
 * The tier-3 runner: a `HarnessSession` worn as a `WorkerRunner`.
 *
 * Same lifecycle spine as tier 2 (created → streaming → terminal, every exit a
 * repo transition), but the loop is inverted: tier 2 *drives* a model and
 * decides when to call tools; a harness drives itself, and this runner only
 * observes the event stream and manages three edges the process cannot:
 *
 *  - **The gate.** Per-action approval cannot reach inside another program —
 *    Claude Code prompts nobody in headless mode and rewter cannot intercept
 *    its tool calls. So the honest gate is one approval, before the process
 *    exists, whose summary names the binary and the directory it will own.
 *    Auto-approve and "inside the task workspace" short-circuit it exactly as
 *    they do for a tier-2 shell command, because it *is* the same gate object
 *    (the engine passes openTier2's Approvals in).
 *  - **The inbox.** `send_to_worker` pushes strings; this runner drains them at
 *    every event and forwards through `session.send()` — Claude Code queues a
 *    mid-turn message and reads it at its next turn boundary, which is the
 *    exact promise `send_to_worker` makes. A turn that nothing was sent into
 *    ends the conversation: `end()` closes stdin and the process exits on its
 *    own. (Not "inbox empty at the boundary" — a message forwarded mid-turn
 *    empties the inbox early while still owing the session another turn.)
 *  - **The money.** Harness spend never touches the router, so without a
 *    CostRecord it would be invisible to the task's cap. Every turn_end that
 *    reports a cost is written under the synthetic model id
 *    `harness/claude-code` with an all-null pricing snapshot — "the harness
 *    said so" is the snapshot, and `overBudget()` sees it at the next spawn.
 */
import {
  type ModelId,
  ModelIdSchema,
  type WorkItem,
  type WorkerRunId,
  newCostRecordId,
} from "@rewter/shared";
import { splitSummary } from "../orchestrator/worker.js";
import type { WorkerContext, WorkerOutcome, WorkerRunner } from "../orchestrator/worker.js";
import type { Approvals } from "../workers/approvals.js";
import { createRun } from "../workers/tier2.js";
import type { HarnessAdapter } from "./types.js";

export interface HarnessRunnerOptions {
  adapter: HarnessAdapter;
  /** The task's shared gate — the same object tier-2 workers park on. */
  approvals: Approvals;
  /** Where the harness works; the tier-2 workspace cwd, so approvals agree. */
  cwd: string;
  /** True when `cwd` is inside the auto-approve zone (workspace.root). */
  cwdInWorkspace: boolean;
  /** Feed line + durable progress event; same seam as Tier2Options. */
  onProgress?: ((note: string, workItem: WorkItem, workerRunId: WorkerRunId) => void) | undefined;
}

const SUMMARY_MAX_CHARS = 300;

export function createHarnessRunner(opts: HarnessRunnerOptions): WorkerRunner {
  return (ctx) => runHarnessWorker(ctx, opts);
}

export async function runHarnessWorker(
  ctx: WorkerContext,
  opts: HarnessRunnerOptions,
): Promise<WorkerOutcome> {
  const startedAt = ctx.clock();
  const run = createRun(ctx);
  const done = (
    status: WorkerOutcome["status"],
    fields: { summary: string; fullText: string | null; error: string | null },
  ): WorkerOutcome => ({
    status,
    ...fields,
    workerRunId: run.id,
    durationMs: ctx.clock() - startedAt,
  });

  if (ctx.signal.aborted) {
    ctx.repos.transitionWorkerRun(run.id, "cancelled", { error: "cancelled before start" });
    return done("cancelled", {
      summary: "cancelled before it started",
      fullText: null,
      error: "cancelled",
    });
  }

  // The one gate, before the process exists. A denial is a failed worker with
  // the reason in its summary — the initiator reads it and does the work at
  // tier 2 or itself, which is exactly what the refusal text suggests.
  const verdict = await opts.approvals.require({
    kind: "spawn_harness",
    summary: `run ${opts.adapter.displayName} in ${opts.cwd}`,
    detail: { harness: opts.adapter.id, cwd: opts.cwd },
    workItemId: ctx.workItem.id,
    workerRunId: run.id,
    inWorkspace: opts.cwdInWorkspace,
  });
  if (!verdict.ok) {
    const error = `harness spawn refused: ${verdict.reason}`;
    ctx.repos.transitionWorkerRun(run.id, "failed", { error });
    return done("failed", { summary: `failed: ${error}`, fullText: null, error });
  }
  // The gate can park for minutes; the task may have died while we waited.
  if (ctx.signal.aborted) {
    ctx.repos.transitionWorkerRun(run.id, "cancelled", { error: "cancelled" });
    return done("cancelled", { summary: "cancelled", fullText: null, error: "cancelled" });
  }

  const session = opts.adapter.spawn({
    instructions: ctx.workItem.instructions,
    cwd: opts.cwd,
    runId: run.id,
  });
  ctx.repos.transitionWorkerRun(run.id, "streaming");

  // Abort → kill. The event stream then closes and the loop below writes the
  // cancelled row itself — one exit path, not a racing listener.
  const onAbort = (): void => session.kill();
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  const progress = (note: string): void => opts.onProgress?.(note, ctx.workItem, run.id);
  // A message forwarded since the last turn boundary means another turn is
  // coming: the harness queues mid-turn input and reads it at the boundary, so
  // this flag — not the inbox's state *at* the boundary — is what says whether
  // the session must outlive the turn that just ended.
  let expectAnotherTurn = false;
  const drainInbox = (): void => {
    const pending = ctx.inbox?.() ?? [];
    for (const message of pending) session.send(message);
    if (pending.length > 0) expectAnotherTurn = true;
  };

  let lastResult: { text: string; isError: boolean } | null = null;
  let fatalError: string | null = null;

  try {
    for await (const event of session.events) {
      drainInbox();
      switch (event.type) {
        case "session":
          ctx.repos.setHarnessSessionId(run.id, event.sessionId);
          break;
        case "text":
          progress(clamp(collapse(event.text), 200));
          break;
        case "tool_use":
          progress(`${event.name} ${event.detail}`.trim());
          break;
        case "turn_end": {
          lastResult = { text: event.resultText, isError: event.isError };
          recordTurnCost(ctx, run.id, event);
          drainInbox();
          // Anything forwarded during or at the end of this turn starts the
          // next one, so stdin must stay open — closing it now would orphan a
          // follow-up the harness has already queued. Only a turn nothing was
          // sent into means the conversation is over.
          if (expectAnotherTurn) {
            expectAnotherTurn = false;
          } else {
            session.end();
          }
          break;
        }
        case "fatal":
          fatalError = event.error;
          break;
      }
    }
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    session.kill();
  }

  if (ctx.signal.aborted) {
    ctx.repos.transitionWorkerRun(run.id, "cancelled", { error: "cancelled" });
    return done("cancelled", { summary: "cancelled", fullText: null, error: "cancelled" });
  }

  if (fatalError !== null || lastResult === null) {
    const error = fatalError ?? "the harness exited without producing a result";
    ctx.repos.transitionWorkerRun(run.id, "failed", { error });
    return done("failed", {
      summary: `failed: ${clamp(collapse(error), SUMMARY_MAX_CHARS - 8)}`,
      fullText: null,
      error,
    });
  }

  if (!lastResult.isError && lastResult.text.trim() === "") {
    // "Success" with no text is not a success. Claude Code's result line always
    // carries the final assistant message when a turn really happened; an empty
    // one means the model streamed nothing (dead upstream, silently exhausted
    // quota). Live smoke found exactly this: a broken router returned empty
    // streams and the run closed "succeeded — (the harness returned nothing)"
    // while the requested file was never created. Fail loudly instead — the
    // initiator reads the reason and retries at tier 2 or elsewhere.
    const error = "the harness reported success but returned no output";
    ctx.repos.transitionWorkerRun(run.id, "failed", { error });
    return done("failed", { summary: `failed: ${error}`, fullText: null, error });
  }

  if (lastResult.isError) {
    // The harness completed and *said* it failed — its text is the error, and
    // worth keeping as resultText: "what Claude Code said went wrong" is the
    // most useful artifact a retry could read.
    const error = clamp(collapse(lastResult.text), 500);
    ctx.repos.transitionWorkerRun(run.id, "failed", {
      error,
      ...(lastResult.text === "" ? {} : { resultText: lastResult.text }),
    });
    return done("failed", {
      summary: `failed: ${clamp(collapse(lastResult.text), SUMMARY_MAX_CHARS - 8)}`,
      fullText: lastResult.text === "" ? null : lastResult.text,
      error,
    });
  }

  ctx.repos.transitionWorkerRun(run.id, "succeeded", { resultText: lastResult.text });
  const { summary, body } = splitSummary(lastResult.text);
  return done("succeeded", {
    summary:
      clamp(collapse(summary ?? body), SUMMARY_MAX_CHARS) || "(the harness returned nothing)",
    fullText: lastResult.text,
    error: null,
  });
}

/**
 * The synthetic id harness spend is recorded under. Passes ModelIdSchema by
 * construction (checked at module load — a rename that broke the regex would
 * fail the first import, not the first paying task).
 */
export const HARNESS_COST_MODEL_ID: ModelId = ModelIdSchema.parse("harness/claude-code");

function recordTurnCost(
  ctx: WorkerContext,
  workerRunId: WorkerOutcome["workerRunId"],
  event: {
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
  },
): void {
  // No cost and no tokens = nothing to record; a zero row would read as "free".
  if (event.costUsd === null && event.inputTokens === null && event.outputTokens === null) return;
  ctx.repos.recordCost({
    id: newCostRecordId(),
    taskId: ctx.taskId,
    workerRunId,
    modelId: HARNESS_COST_MODEL_ID,
    inputTokens: event.inputTokens ?? 0,
    outputTokens: event.outputTokens ?? 0,
    cacheReadTokens: event.cacheReadTokens ?? 0,
    cacheWriteTokens: event.cacheWriteTokens ?? 0,
    costUsd: event.costUsd ?? 0,
    // The harness computed the cost; there is no per-token price to snapshot.
    pricingSnapshot: {
      inputPerMTok: null,
      outputPerMTok: null,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    },
    createdAt: ctx.clock(),
  });
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}
