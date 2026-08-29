/**
 * Cost aggregation: `GET /internal/costs?groupBy=…` and the dashboard page.
 *
 * The aggregation is a pure function over `CostRecord[]` rather than SQL, for
 * the same reason the task tree is a fold: the dashboard already receives every
 * `cost.recorded` event over the socket, so a client that wants a live-updating
 * breakdown can call this on what it has instead of re-fetching. One
 * implementation, two callers, tested once. A local daemon's cost table is
 * thousands of rows, not millions — the day SQL is faster is the day this moves,
 * and the contract above it will not change when it does.
 *
 * The split that matters is `initiatorCostUsd` vs `workerCostUsd`. A record with
 * `workerRunId === null` is the orchestrator's own planning tokens; every other
 * record is work it delegated. Reporting one total hides the failure mode this
 * whole design exists to catch — a planner that costs more than the plan saved.
 * So every bucket carries both, and they always sum to `costUsd`.
 */
import { z } from "zod";
import type { CostRecord } from "./entities.js";

/**
 * `task` groups by `taskId`, with un-attributed spend (a plain pass-through
 * request through `/v1`, which has no task) under the key `"(no task)"` rather
 * than dropped — untagged spend is still money.
 */
export const CostGroupBySchema = z.enum(["model", "day", "task"]);
export type CostGroupBy = z.infer<typeof CostGroupBySchema>;

const Totals = {
  costUsd: z.number().nonnegative(),
  /** Spend with no `workerRunId` — the orchestrator's own tokens. */
  initiatorCostUsd: z.number().nonnegative(),
  /** Spend attributed to a worker run. `initiator + worker === costUsd`. */
  workerCostUsd: z.number().nonnegative(),
  /** Number of cost records, i.e. upstream calls that reported usage. */
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
};

export const CostTotalsSchema = z.object(Totals);
export type CostTotals = z.infer<typeof CostTotalsSchema>;

export const CostBucketSchema = z.object({
  /** Model id, `YYYY-MM-DD`, or task id, depending on `groupBy`. */
  key: z.string(),
  ...Totals,
});
export type CostBucket = z.infer<typeof CostBucketSchema>;

export const CostSummarySchema = z.object({
  groupBy: CostGroupBySchema,
  /**
   * The IANA zone the `day` keys were computed in. Echoed so a dashboard
   * labels them with the zone they were bucketed in rather than its own —
   * relabelling a UTC bucket as local is how a day's spend moves.
   */
  timeZone: z.string(),
  since: z.number().int().nullable(),
  until: z.number().int().nullable(),
  totals: CostTotalsSchema,
  buckets: z.array(CostBucketSchema),
});
export type CostSummary = z.infer<typeof CostSummarySchema>;

export interface SummarizeCostsOptions {
  groupBy: CostGroupBy;
  /** IANA zone for `day` bucketing. Defaults to UTC — explicit, not ambient. */
  timeZone?: string;
  since?: number | null;
  until?: number | null;
}

/** Spend with no task attached. A key, not a hole. */
export const NO_TASK_KEY = "(no task)";

const emptyTotals = (): CostTotals => ({
  costUsd: 0,
  initiatorCostUsd: 0,
  workerCostUsd: 0,
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

const add = (into: CostTotals, r: CostRecord): void => {
  into.costUsd += r.costUsd;
  if (r.workerRunId === null) into.initiatorCostUsd += r.costUsd;
  else into.workerCostUsd += r.costUsd;
  into.calls += 1;
  into.inputTokens += r.inputTokens;
  into.outputTokens += r.outputTokens;
  into.cacheReadTokens += r.cacheReadTokens;
  into.cacheWriteTokens += r.cacheWriteTokens;
};

/**
 * `YYYY-MM-DD` in `timeZone`. Uses `en-CA` because its short date format *is*
 * ISO order, and `Intl` because a fixed UTC-offset arithmetic would put an hour
 * of every DST-shifted day in the wrong bucket.
 */
export function dayKey(ts: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts));
}

const keyOf = (r: CostRecord, groupBy: CostGroupBy, timeZone: string): string => {
  if (groupBy === "model") return r.modelId;
  if (groupBy === "day") return dayKey(r.createdAt, timeZone);
  return r.taskId ?? NO_TASK_KEY;
};

/**
 * Bucket and total a set of cost records.
 *
 * `since`/`until` filter on `createdAt`, half-open (`since <= t < until`) so
 * adjacent windows tile without double-counting the boundary record.
 *
 * Ordering is deliberate and differs by grouping: `day` sorts by key ascending
 * so a chart reads left-to-right in time, everything else sorts by cost
 * descending so the expensive thing is the first thing you see. Ties break on
 * key so the output is stable enough to snapshot.
 */
export function summarizeCosts(
  records: readonly CostRecord[],
  options: SummarizeCostsOptions,
): CostSummary {
  const { groupBy } = options;
  const timeZone = options.timeZone ?? "UTC";
  const since = options.since ?? null;
  const until = options.until ?? null;

  const totals = emptyTotals();
  const buckets = new Map<string, CostTotals>();

  for (const r of records) {
    if (since !== null && r.createdAt < since) continue;
    if (until !== null && r.createdAt >= until) continue;
    add(totals, r);
    const key = keyOf(r, groupBy, timeZone);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = emptyTotals();
      buckets.set(key, bucket);
    }
    add(bucket, r);
  }

  const rows = [...buckets].map(([key, t]) => ({ key, ...t }));
  rows.sort((a, b) =>
    groupBy === "day"
      ? a.key.localeCompare(b.key)
      : b.costUsd - a.costUsd || a.key.localeCompare(b.key),
  );

  return { groupBy, timeZone, since, until, totals, buckets: rows };
}
