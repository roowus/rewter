/**
 * Fetching the daemon's ops summary — `/internal/health`, which began life as
 * the liveness probe `rewter status` pings and now also carries the facts an
 * operator wants while glancing at this page: uptime, the bound URL, registry
 * counts, the database's footprint, how much log there is, and whether anything
 * is parked on an approval gate.
 *
 * Same shape as `costs.ts`, for the same reason: parsed with the shared schema,
 * not cast, because a daemon newer than this bundle sending a half-understood
 * shape should say so rather than render `undefined` where a number belongs.
 */
import { type DaemonHealth, DaemonHealthSchema } from "@rewter/shared";

export type HealthResult = { ok: true; health: DaemonHealth } | { ok: false; message: string };

export async function fetchHealth(
  options: { signal?: AbortSignal } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<HealthResult> {
  let response: Response;
  try {
    response = await fetchImpl("/internal/health", {
      ...(options.signal !== undefined && { signal: options.signal }),
    });
  } catch (cause) {
    // An abort is the caller changing its mind, not a failure to report.
    if (cause instanceof DOMException && cause.name === "AbortError") {
      return { ok: false, message: "aborted" };
    }
    return { ok: false, message: "daemon unreachable" };
  }

  if (!response.ok) return { ok: false, message: `daemon said ${response.status}` };
  const parsed = DaemonHealthSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { ok: false, message: "unrecognized response from daemon" };
  return { ok: true, health: parsed.data };
}
