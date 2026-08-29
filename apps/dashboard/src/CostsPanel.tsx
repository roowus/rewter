/**
 * What this daemon has cost.
 *
 * Deliberately a small panel above the task tree rather than a page of its own:
 * the reason to open this dashboard is the task that is running, and cost is
 * context for that, not a destination. It answers three questions and stops —
 * what has it spent, where did the money go, and how much of it was the planner
 * thinking rather than a worker working.
 *
 * That last column is the point. `initiator` is spend with no `workerRunId` —
 * the orchestrator's own tokens. An orchestrator that spends more deciding than
 * its cheap workers spend doing has failed at the thing it exists for, and a
 * single total would show that as a perfectly healthy number.
 *
 * It refetches on every `lastSeq` change rather than folding `cost.recorded`
 * locally, because the fold structurally cannot hold this: a pass-through
 * request has no task, so its cost event is orphaned, and a client that
 * connected an hour ago has only an hour of history. See `costs.ts`.
 */
import type { CostBucket, CostGroupBy, CostSummary } from "@rewter/shared";
import { useEffect, useState } from "react";
import { fetchCosts, localTimeZone } from "./costs.js";
import { shortModelId, usd } from "./format.js";
import { useDashboard } from "./store.js";

const TABS: ReadonlyArray<{ value: CostGroupBy; label: string }> = [
  { value: "model", label: "by model" },
  { value: "day", label: "by day" },
  { value: "task", label: "by task" },
];

/** Model ids shorten; day keys and task ids are already what they are. */
const bucketLabel = (bucket: CostBucket, groupBy: CostGroupBy): string =>
  groupBy === "model" ? shortModelId(bucket.key) : bucket.key;

export function CostsPanel(): JSX.Element {
  const [groupBy, setGroupBy] = useState<CostGroupBy>("model");
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The socket's position, used only as a "something happened" tick. Any event
  // may or may not have been a cost; refetching on all of them is one cheap
  // local request and avoids reimplementing the aggregation client-side.
  const lastSeq = useDashboard((s) => s.fold.lastSeq);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `lastSeq` is a tick, not an input — the effect reads nothing from it, it just needs to run again when the socket moved.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const result = await fetchCosts(
        { groupBy, timeZone: localTimeZone(), signal: controller.signal },
        fetch,
      );
      if (controller.signal.aborted) return;
      if (result.ok) {
        setSummary(result.summary);
        setError(null);
      } else {
        // Keep the last good numbers on screen and say the feed is stale. A
        // panel that empties on a transient failure reads as "spent nothing".
        setError(result.message);
      }
    })();
    return () => controller.abort();
  }, [groupBy, lastSeq]);

  return (
    <section className="costs" aria-label="costs">
      <header className="costs-head">
        <h2>spend</h2>
        <strong className="costs-total">{usd(summary?.totals.costUsd ?? 0)}</strong>
        {summary !== null && (
          <span className="costs-split">
            {usd(summary.totals.initiatorCostUsd)} planning · {usd(summary.totals.workerCostUsd)}{" "}
            work · {summary.totals.calls} calls
          </span>
        )}
        <div className="costs-tabs" role="tablist" aria-label="group costs by">
          {TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={groupBy === tab.value}
              onClick={() => setGroupBy(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {error !== null && <span className="error">{error}</span>}
      </header>

      {summary === null ? (
        error === null ? (
          <p className="empty">loading…</p>
        ) : null
      ) : summary.buckets.length === 0 ? (
        <p className="empty">Nothing spent yet.</p>
      ) : (
        <table className="costs-table">
          <thead>
            <tr>
              <th scope="col">{groupBy}</th>
              <th scope="col">total</th>
              <th scope="col">planning</th>
              <th scope="col">work</th>
              <th scope="col">calls</th>
            </tr>
          </thead>
          <tbody>
            {summary.buckets.map((bucket) => (
              <tr key={bucket.key}>
                <th scope="row" title={bucket.key}>
                  {bucketLabel(bucket, groupBy)}
                </th>
                <td>{usd(bucket.costUsd)}</td>
                <td>{usd(bucket.initiatorCostUsd)}</td>
                <td>{usd(bucket.workerCostUsd)}</td>
                <td>{bucket.calls}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* The zone the day column was bucketed in. Labelling a UTC bucket with a
          local date is how a night's spend moves to the wrong day. */}
      {summary !== null && groupBy === "day" && (
        <p className="costs-zone">days in {summary.timeZone}</p>
      )}
    </section>
  );
}
