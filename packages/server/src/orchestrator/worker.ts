/**
 * Tier-1 workers: one model call, no tools.
 *
 * A tier-1 worker is deliberately the thinnest thing that can be a worker — the
 * router already does retry, cost recording and error normalization, so this
 * layer only owns the lifecycle writes and the summary extraction. Tier 2 (an
 * agent loop with tools, in `workers/tier2.ts`) implements the same `runWorker`
 * shape, which is why the engine talks to a `WorkerRunner` function type rather
 * than to this module directly — choosing a tier is one lookup, not a branch
 * threaded through `spawn`.
 *
 * The lifecycle is not optional decoration: `WORKER_RUN_TRANSITIONS` has no
 * `created → succeeded` edge, so a run that skipped `streaming` would throw at
 * the repo write and take the task down with it. Every path here goes
 * `created → streaming → succeeded | failed | cancelled`.
 */
import {
  type ChatResponse,
  type Model,
  type TaskId,
  type WorkItem,
  type WorkerRun,
  type WorkerRunId,
  newWorkerRunId,
} from "@rewter/shared";
import type { Repos } from "../db/repos.js";
import type { RouteRequest } from "../router/router.js";
import { buildWorkerMessages } from "./prompt.js";

/** The slice of `Router` a worker needs — tests inject a stub, not an adapter. */
export interface WorkerRouter {
  complete(req: RouteRequest, signal?: AbortSignal): Promise<ChatResponse>;
  resolve(model: string): { model: Model };
}

export interface WorkerContext {
  workItem: WorkItem;
  taskId: TaskId;
  router: WorkerRouter;
  repos: Repos;
  clock: () => number;
  signal: AbortSignal;
  maxTokens?: number | undefined;
}

export interface WorkerOutcome {
  status: "succeeded" | "failed" | "cancelled";
  /** One line for the initiator's `wait`; the full text stays in the run row. */
  summary: string;
  fullText: string | null;
  error: string | null;
  workerRunId: WorkerRunId;
  durationMs: number;
}

export type WorkerRunner = (ctx: WorkerContext) => Promise<WorkerOutcome>;

/** Runaway guard, not a target: a worker asked for one clause shouldn't write a book. */
const DEFAULT_MAX_TOKENS = 4_000;

export const runTier1Worker: WorkerRunner = async (ctx) => {
  const startedAt = ctx.clock();
  const run = createRun(ctx);

  // An abort that lands before the call starts still has to close the run out,
  // or the task waits forever on a worker that never ran.
  if (ctx.signal.aborted) {
    ctx.repos.transitionWorkerRun(run.id, "cancelled", { error: "cancelled before start" });
    return {
      status: "cancelled",
      summary: "cancelled before it started",
      fullText: null,
      error: "cancelled before start",
      workerRunId: run.id,
      durationMs: ctx.clock() - startedAt,
    };
  }

  ctx.repos.transitionWorkerRun(run.id, "streaming");

  let response: ChatResponse;
  try {
    response = await ctx.router.complete(
      {
        model: ctx.workItem.modelId,
        messages: buildWorkerMessages(ctx.workItem.instructions),
        maxTokens: ctx.maxTokens ?? DEFAULT_MAX_TOKENS,
        taskId: ctx.taskId,
        workerRunId: run.id,
      },
      ctx.signal,
    );
  } catch (err) {
    const cancelled = ctx.signal.aborted;
    const message = err instanceof Error ? err.message : String(err);
    ctx.repos.transitionWorkerRun(run.id, cancelled ? "cancelled" : "failed", { error: message });
    return {
      status: cancelled ? "cancelled" : "failed",
      summary: cancelled ? "cancelled" : `failed: ${message}`,
      fullText: null,
      error: message,
      workerRunId: run.id,
      durationMs: ctx.clock() - startedAt,
    };
  }

  // The router turns a failed call into an `error` finish reason rather than a
  // throw, so success is not the absence of an exception.
  if (response.finishReason === "error") {
    const message = response.message.content ?? "the model returned an error";
    ctx.repos.transitionWorkerRun(run.id, ctx.signal.aborted ? "cancelled" : "failed", {
      error: message,
    });
    return {
      status: ctx.signal.aborted ? "cancelled" : "failed",
      summary: `failed: ${message}`,
      fullText: null,
      error: message,
      workerRunId: run.id,
      durationMs: ctx.clock() - startedAt,
    };
  }

  const fullText = response.message.content ?? "";
  const { summary, body } = splitSummary(fullText);
  ctx.repos.transitionWorkerRun(run.id, "succeeded", { resultText: fullText });

  return {
    status: "succeeded",
    // A worker that ignored the SUMMARY convention still has to yield something
    // the initiator can read without paying for `get_result`, so fall back to
    // the head of the body rather than reporting an empty result.
    summary: summary ?? fallbackSummary(body),
    fullText,
    error: null,
    workerRunId: run.id,
    durationMs: ctx.clock() - startedAt,
  };
};

function createRun(ctx: WorkerContext): WorkerRun {
  const now = ctx.clock();
  return ctx.repos.createWorkerRun({
    id: newWorkerRunId(),
    workItemId: ctx.workItem.id,
    taskId: ctx.taskId,
    status: "created",
    modelId: ctx.workItem.modelId,
    tier: ctx.workItem.tier,
    attempt: 1,
    harnessSessionId: null,
    resultText: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  });
}

const SUMMARY_MAX_CHARS = 300;

/**
 * Pull the trailing `SUMMARY:` line out of a worker's reply.
 *
 * Searched from the end, because a worker summarizing a document that itself
 * contains the word "SUMMARY:" would otherwise hand back a line from its own
 * input. Only the last one can be the worker's own sign-off.
 */
export function splitSummary(text: string): { summary: string | null; body: string } {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    // Models bold the label unprompted, and put the closing `**` on either side
    // of the colon: `**SUMMARY:** x` and `**SUMMARY**: x` are both common.
    const match = /^\**\s*SUMMARY\s*\**\s*:\s*\**\s*(.+)$/i.exec(line);
    if (match === null) break;
    const summary = clamp(collapse(stripBold(match[1] ?? "")), SUMMARY_MAX_CHARS);
    return { summary: summary === "" ? null : summary, body: lines.slice(0, i).join("\n").trim() };
  }
  return { summary: null, body: text.trim() };
}

function fallbackSummary(body: string): string {
  if (body.trim() === "") return "(the worker returned nothing)";
  return clamp(collapse(body), SUMMARY_MAX_CHARS);
}

/** Drop a trailing `**` left over from a bolded label the regex opened. */
function stripBold(s: string): string {
  return s.replace(/\*+\s*$/, "");
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}
