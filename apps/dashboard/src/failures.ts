/**
 * Fetching the failure summary — issue #9's measurement, read back.
 *
 * Like costs, this cannot be a fold over the socket: the rows that matter most
 * are the retried failures the router deliberately kept *out* of the task's
 * event stream (a client that got its answer should not see a phantom error),
 * and a plain `/v1` pass-through has no task to hang an event on anyway. So the
 * daemon reads the table and aggregates with the shared `summarizeFailures`;
 * the page just asks. See `costs.ts` for the longer version of the argument.
 */
import { type FailureSummary, FailureSummarySchema } from "@rewter/shared";

export type FailuresResult = { ok: true; summary: FailureSummary } | { ok: false; message: string };

export interface FetchFailuresOptions {
  since?: number;
  signal?: AbortSignal;
}

export async function fetchFailures(
  options: FetchFailuresOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<FailuresResult> {
  const params = new URLSearchParams();
  if (options.since !== undefined) params.set("since", String(options.since));
  const query = params.toString();

  let response: Response;
  try {
    response = await fetchImpl(`/internal/failures${query === "" ? "" : `?${query}`}`, {
      ...(options.signal !== undefined && { signal: options.signal }),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      return { ok: false, message: "aborted" };
    }
    return { ok: false, message: "daemon unreachable" };
  }

  if (!response.ok) return { ok: false, message: `daemon said ${response.status}` };

  // Parsed, not cast, for the same reason as costs: a shape we half-understand
  // must fail loudly rather than render as a reassuring zero.
  const parsed = FailureSummarySchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { ok: false, message: "unrecognized response from daemon" };
  return { ok: true, summary: parsed.data };
}

/**
 * The rate #9 asked for, as a percentage of all upstream calls in the window,
 * or `null` when there were no calls — no calls is not a zero percent.
 */
export function midStreamRate(totals: {
  midStream: number;
  failures: number;
  successes: number;
}): number | null {
  const calls = totals.successes + totals.failures;
  return calls === 0 ? null : (totals.midStream / calls) * 100;
}
