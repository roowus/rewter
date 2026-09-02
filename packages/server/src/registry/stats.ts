/**
 * Learned model statistics: which models actually finish which kinds of work,
 * and what it costs when they do.
 *
 * The `model_stats` table has existed since M1 with nothing writing to it; this
 * is the writer. It is an event-bus subscriber rather than a call in the engine
 * because *every* path that ends a work item — the engine's normal settle, a
 * dashboard cancel, boot reconciliation marking a run interrupted — goes
 * through `transitionWorkItem` and so through the bus. One subscriber sees them
 * all; a call in the engine would see only the happy path.
 *
 * What counts. A work item is an observation when it reaches a terminal status
 * **and** the initiator tagged it (`spawn_worker`'s `tag`). Untagged items are
 * skipped, never guessed: a statistic keyed on a guess is worse than none,
 * because the initiator will read it as evidence. `succeeded` is the only
 * success; `failed` and `cancelled` count as attempts that did not — a worker
 * cancelled because it was taking too long *is* a signal about the model. Two
 * terminal statuses are not observations at all: `interrupted` is the daemon
 * dying, not the model (and is only ever written by boot reconciliation, which
 * runs before this subscriber exists — the exclusion is belt and braces); and
 * `handed_off` is a judgement about the *initiator*, not the worker's model.
 *
 * Cost is the worker's own rows in `cost_records` (every run of the item), so a
 * tier-2 loop's several calls are one observation. Latency is created→finished
 * on the work item, which includes queue time under the concurrency limiter —
 * that is the latency the user experienced, and the one the initiator can
 * trade against.
 *
 * The reader is `renderDigest` (`digest.ts`), which turns the rows into one
 * `stats:` fact per model. Advise-only: the initiator still chooses.
 */
import type {
  CostRecord,
  EventEnvelope,
  ModelStat,
  WorkItem,
  WorkItemStatus,
} from "@rewter/shared";
import { WORK_ITEM_TRANSITIONS, isTerminal } from "@rewter/shared";

/** Terminal statuses that say something about the worker's model. See above. */
export function isObservation(status: WorkItemStatus): boolean {
  return (
    isTerminal(WORK_ITEM_TRANSITIONS, status) && status !== "handed_off" && status !== "interrupted"
  );
}

/** The slice of `Repos` the recorder reads and writes. */
export interface StatsStore {
  getWorkItem(id: string): WorkItem | undefined;
  listCosts(taskId: string): CostRecord[];
  listWorkerRuns(workItemId: string): { id: string }[];
  recordOutcome(observation: {
    modelId: string;
    taskTag: string;
    succeeded: boolean;
    costUsd: number | null;
    latencyMs: number | null;
  }): ModelStat;
}

export interface StatsRecorderOptions {
  bus: { subscribe(listener: (event: EventEnvelope) => void): () => void };
  store: StatsStore;
  log?: { warn(obj: object, msg: string): void } | undefined;
}

/**
 * Subscribe the recorder to the bus. Returns the unsubscribe function.
 *
 * Bookkeeping failures are logged and swallowed: the bus already isolates a
 * throwing subscriber from the write path, but a stats row that could not be
 * written is worth a warning line, not silence.
 */
export function wireStatsRecorder(opts: StatsRecorderOptions): { unsubscribe: () => void } {
  const unsubscribe = opts.bus.subscribe((event) => {
    if (event.payload.type !== "work_item.status_changed") return;
    if (!isObservation(event.payload.to)) return;
    try {
      recordWorkItem(opts.store, event.payload.workItemId);
    } catch (err) {
      opts.log?.warn(
        { workItemId: event.payload.workItemId, err: err instanceof Error ? err.message : err },
        "model stats: could not record outcome",
      );
    }
  });
  return { unsubscribe };
}

/**
 * Fold one finished work item into the statistics. Exposed for the test and
 * for anything that wants to record without a bus; the subscriber calls it.
 */
export function recordWorkItem(store: StatsStore, workItemId: string): ModelStat | undefined {
  const item = store.getWorkItem(workItemId);
  if (item === undefined || item.taskTag === null) return undefined;
  if (!isObservation(item.status)) return undefined;

  const runIds = new Set(store.listWorkerRuns(item.id).map((r) => r.id));
  const costRows = store
    .listCosts(item.taskId)
    .filter((c) => c.workerRunId !== null && runIds.has(c.workerRunId));
  const costUsd = costRows.length === 0 ? null : costRows.reduce((sum, c) => sum + c.costUsd, 0);
  const latencyMs = item.finishedAt === null ? null : Math.max(0, item.finishedAt - item.createdAt);

  return store.recordOutcome({
    modelId: item.modelId,
    taskTag: item.taskTag,
    succeeded: item.status === "succeeded",
    costUsd,
    latencyMs,
  });
}
