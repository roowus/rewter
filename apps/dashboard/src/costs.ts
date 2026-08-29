/**
 * Fetching the cost summary — the first thing in this dashboard that is not a
 * fold over the socket, and worth saying why.
 *
 * The fold *does* carry cost: every task in the tree knows what it spent. What
 * it cannot carry is the total. Two reasons, and either one alone would be
 * enough. A `cost.recorded` event with no `taskId` — every plain `/v1`
 * pass-through, which is most of what a router does — has no task to attach to,
 * so the fold counts it as orphaned and drops the number. And a fold only holds
 * what the socket replayed, so a client that connected today would report a
 * week-old daemon's spend as this morning's.
 *
 * So this asks the daemon, which reads the table. The aggregation itself is
 * still shared code (`summarizeCosts`), so the page and the endpoint cannot
 * produce different numbers — only the row supply differs.
 */
import { type CostGroupBy, type CostSummary, CostSummarySchema } from "@rewter/shared";

export type CostsResult = { ok: true; summary: CostSummary } | { ok: false; message: string };

export interface FetchCostsOptions {
  groupBy: CostGroupBy;
  /** IANA zone for day bucketing. The page passes the browser's. */
  timeZone?: string;
  since?: number;
  signal?: AbortSignal;
}

export async function fetchCosts(
  options: FetchCostsOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<CostsResult> {
  const params = new URLSearchParams({ groupBy: options.groupBy });
  if (options.timeZone !== undefined) params.set("tz", options.timeZone);
  if (options.since !== undefined) params.set("since", String(options.since));

  let response: Response;
  try {
    response = await fetchImpl(`/internal/costs?${params.toString()}`, {
      ...(options.signal !== undefined && { signal: options.signal }),
    });
  } catch (cause) {
    // An abort is the caller changing its mind, not a failure to report. The
    // page drops it rather than flashing an error between two good renders.
    if (cause instanceof DOMException && cause.name === "AbortError") {
      return { ok: false, message: "aborted" };
    }
    return { ok: false, message: "daemon unreachable" };
  }

  if (!response.ok) return { ok: false, message: `daemon said ${response.status}` };

  // Parsed, not cast: this is money on screen, and a daemon newer than the
  // bundle sending a shape we half-understand should say so rather than render
  // `undefined` as a dash and let someone read it as zero.
  const parsed = CostSummarySchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { ok: false, message: "unrecognized response from daemon" };
  return { ok: true, summary: parsed.data };
}

/** The browser's zone, so `day` buckets line up with the user's calendar. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
