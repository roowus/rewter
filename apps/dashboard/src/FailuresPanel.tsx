/**
 * How often upstreams fail, and — the question issue #9 actually asked — how
 * often they fail *after* they have started answering.
 *
 * Two kinds of failure, and the panel keeps them apart because they call for
 * different fixes. A failure before any output is one the router already
 * handles: it retries, and if the retry works the client never knows. Its rate
 * says how much the retry is earning. A failure mid-stream cannot be retried
 * without duplicating text the client has rendered, so it always reaches the
 * user; its rate is the one that decides whether resumable streams are worth
 * building. A single "errors" number would blend the solved problem into the
 * open one.
 *
 * Successes come from cost records, so every figure here is a rate over the
 * same window's calls rather than a bare count. The panel refetches on socket
 * movement like the costs panel does, and for the same reason: the fold cannot
 * hold these rows (see `failures.ts`).
 */
import type { FailureBucket, FailureSummary } from "@rewter/shared";
import { useEffect, useState } from "react";
import { COST_RANGES, type CostRange, rangeStart } from "./costs.js";
import { fetchFailures, midStreamRate } from "./failures.js";
import { clockTime, shortModelId } from "./format.js";
import { useDashboard } from "./store.js";

const pct = (value: number | null): string => (value === null ? "—" : `${value.toFixed(1)}%`);

/** The most common status in the window, named so the row reads as a cause. */
function topStatus(byStatus: Record<string, number>): string {
  let best: [string, number] | undefined;
  for (const [status, count] of Object.entries(byStatus)) {
    if (best === undefined || count > best[1]) best = [status, count];
  }
  return best === undefined ? "—" : `${best[0]} × ${best[1]}`;
}

function Cards({ summary }: { summary: FailureSummary }): JSX.Element {
  const { totals } = summary;
  const calls = totals.successes + totals.failures;
  return (
    <dl className="cost-cards">
      <div className="cost-card">
        <dt>mid-stream rate</dt>
        {/* The #9 number. No calls is no rate, not a zero one. */}
        <dd title="failures after first output, over all upstream calls">
          {pct(midStreamRate(totals))}
        </dd>
      </div>
      <div className="cost-card">
        <dt>failure rate</dt>
        <dd title="all failed attempts, over all upstream calls">
          {pct(calls === 0 ? null : (totals.failures / calls) * 100)}
        </dd>
      </div>
      <div className="cost-card">
        <dt>retried</dt>
        <dd title="failures the router retried, which the client never saw">
          {totals.retried} of {totals.beforeOutput} before output
        </dd>
      </div>
      <div className="cost-card">
        <dt>top status</dt>
        <dd>{topStatus(totals.byStatus)}</dd>
      </div>
    </dl>
  );
}

function Row({ bucket }: { bucket: FailureBucket }): JSX.Element {
  return (
    <tr>
      <th scope="row" title={bucket.key}>
        {shortModelId(bucket.key)}
      </th>
      <td>{bucket.successes}</td>
      <td>{bucket.beforeOutput}</td>
      <td>{bucket.midStream}</td>
      <td>{pct(midStreamRate(bucket))}</td>
      <td
        className="failures-last"
        title={bucket.lastAt === null ? undefined : clockTime(bucket.lastAt)}
      >
        {bucket.lastMessage ?? "—"}
      </td>
    </tr>
  );
}

export function FailuresPanel(): JSX.Element {
  const [range, setRange] = useState<CostRange>("7d");
  const [summary, setSummary] = useState<FailureSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastSeq = useDashboard((s) => s.fold.lastSeq);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `lastSeq` is a tick, not an input — the effect reads nothing from it, it just needs to run again when the socket moved.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const since = rangeStart(range, Date.now());
      const result = await fetchFailures(
        { ...(since !== undefined && { since }), signal: controller.signal },
        fetch,
      );
      if (controller.signal.aborted) return;
      if (result.ok) {
        setSummary(result.summary);
        setError(null);
      } else {
        // Last good numbers stay up; a panel that blanks reads as "no failures".
        setError(result.message);
      }
    })();
    return () => controller.abort();
  }, [range, lastSeq]);

  return (
    <section className="costs" aria-label="failures">
      <header className="costs-head">
        <h2>failures</h2>
        <strong className="costs-total">{summary?.totals.failures ?? 0}</strong>
        {summary !== null && (
          <span className="costs-split">
            {summary.totals.beforeOutput} before output · {summary.totals.midStream} mid-stream ·{" "}
            {summary.totals.successes} ok
          </span>
        )}
        <div className="costs-tabs leading" role="tablist" aria-label="failure time range">
          {COST_RANGES.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={range === option.value}
              onClick={() => setRange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {error !== null && <span className="error">{error}</span>}
      </header>

      {summary !== null && <Cards summary={summary} />}

      {summary === null ? (
        error === null ? (
          <p className="empty">loading…</p>
        ) : null
      ) : summary.buckets.length === 0 ? (
        <p className="empty">
          {summary.since === null ? "No upstream calls yet." : "No upstream calls in this range."}
        </p>
      ) : (
        <table className="costs-table">
          <thead>
            <tr>
              <th scope="col">model</th>
              <th scope="col">ok</th>
              <th scope="col">before output</th>
              <th scope="col">mid-stream</th>
              <th scope="col">mid-stream rate</th>
              <th scope="col">last failure</th>
            </tr>
          </thead>
          <tbody>
            {summary.buckets.map((bucket) => (
              <Row key={bucket.key} bucket={bucket} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
