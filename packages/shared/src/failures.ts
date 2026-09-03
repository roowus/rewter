/**
 * Failure aggregation: `GET /internal/failures` and the dashboard panel.
 *
 * Issue #9 asks whether a stream that dies after its first chunk should be
 * resumable, and the honest answer was "it depends how often that happens,
 * which nobody has measured". This is the measurement. The router writes one
 * `FailureRecord` per failed attempt — including the ones it retried and the
 * caller never saw — and this function turns them into the two numbers the
 * design decision needs: how many failures landed *before* any output (retryable,
 * invisible when the retry works) and how many landed *mid-stream* (not
 * retryable, always visible).
 *
 * A failure count without a denominator is a scare, not a rate, so the summary
 * also takes the window's cost records: every cost row is one upstream call that
 * finished well enough to report usage. `successes` per model comes from there,
 * and `midStream / (successes + failures)` is the frequency #9 wanted.
 *
 * Pure over the two record arrays, like `summarizeCosts`, and for the same
 * reason: one implementation, tested once, no SQL to drift from it.
 */
import { z } from "zod";
import type { CostRecord, FailureRecord } from "./entities.js";

const Totals = {
  /** Failed attempts of any kind. */
  failures: z.number().int().nonnegative(),
  /** Failed before the first chunk escaped — the router may have retried. */
  beforeOutput: z.number().int().nonnegative(),
  /** Failed after output had been delivered — never retried, always visible. */
  midStream: z.number().int().nonnegative(),
  /** Failures the router went on to retry. Always `<= beforeOutput`. */
  retried: z.number().int().nonnegative(),
  /**
   * Upstream calls that finished and reported usage (one per cost record).
   * The denominator: `midStream / (successes + failures)` is a rate.
   */
  successes: z.number().int().nonnegative(),
  /**
   * Failures by HTTP status, keyed by the status as a string; a failure with no
   * status (a dropped connection, a thrown adapter) is under `"none"`.
   */
  byStatus: z.record(z.number().int().nonnegative()),
};

export const FailureTotalsSchema = z.object(Totals);
export type FailureTotals = z.infer<typeof FailureTotalsSchema>;

export const FailureBucketSchema = z.object({
  /** Model id. */
  key: z.string(),
  ...Totals,
  /** The newest failure's message and time, so a row can be read without a log. */
  lastMessage: z.string().nullable(),
  lastAt: z.number().int().nullable(),
});
export type FailureBucket = z.infer<typeof FailureBucketSchema>;

export const FailureSummarySchema = z.object({
  since: z.number().int().nullable(),
  until: z.number().int().nullable(),
  totals: FailureTotalsSchema,
  /** One per model that failed or succeeded in the window; most failures first. */
  buckets: z.array(FailureBucketSchema),
});
export type FailureSummary = z.infer<typeof FailureSummarySchema>;

export interface SummarizeFailuresOptions {
  since?: number | null;
  until?: number | null;
}

/** Key for a failure that carried no HTTP status. */
export const NO_STATUS_KEY = "none";

const emptyTotals = (): FailureTotals => ({
  failures: 0,
  beforeOutput: 0,
  midStream: 0,
  retried: 0,
  successes: 0,
  byStatus: {},
});

const addFailure = (into: FailureTotals, r: FailureRecord): void => {
  into.failures += 1;
  if (r.phase === "before_output") into.beforeOutput += 1;
  else into.midStream += 1;
  if (r.retried) into.retried += 1;
  const status = r.statusCode === null ? NO_STATUS_KEY : String(r.statusCode);
  into.byStatus[status] = (into.byStatus[status] ?? 0) + 1;
};

const inWindow = (ts: number, since: number | null, until: number | null): boolean =>
  (since === null || ts >= since) && (until === null || ts < until);

/**
 * Bucket failures by model, with each model's successful calls beside them.
 *
 * `since`/`until` filter on `createdAt`, half-open, for both record kinds.
 * Buckets sort by failures descending, then mid-stream failures descending,
 * then key — the model that is hurting most is the first row, and a model that
 * only ever succeeded still appears, at the bottom, because "zero failures out
 * of two hundred calls" is the comparison that makes the top row meaningful.
 */
export function summarizeFailures(
  failures: readonly FailureRecord[],
  costs: readonly CostRecord[],
  options: SummarizeFailuresOptions = {},
): FailureSummary {
  const since = options.since ?? null;
  const until = options.until ?? null;

  const totals = emptyTotals();
  const buckets = new Map<string, FailureBucket>();
  const bucketFor = (key: string): FailureBucket => {
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { key, ...emptyTotals(), lastMessage: null, lastAt: null };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  for (const r of failures) {
    if (!inWindow(r.createdAt, since, until)) continue;
    addFailure(totals, r);
    const bucket = bucketFor(r.modelId);
    addFailure(bucket, r);
    if (bucket.lastAt === null || r.createdAt >= bucket.lastAt) {
      bucket.lastAt = r.createdAt;
      bucket.lastMessage = r.message;
    }
  }

  for (const c of costs) {
    if (!inWindow(c.createdAt, since, until)) continue;
    totals.successes += 1;
    bucketFor(c.modelId).successes += 1;
  }

  const rows = [...buckets.values()];
  rows.sort(
    (a, b) => b.failures - a.failures || b.midStream - a.midStream || a.key.localeCompare(b.key),
  );

  return { since, until, totals, buckets: rows };
}
