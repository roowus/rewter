/**
 * Stopping the daemon from the dashboard.
 *
 * A sibling of `cancelTask` in shape, and the same discipline about what the
 * button is allowed to claim. `cancelTask` distinguishes "a live session was
 * collapsed" from "a stale row was settled"; this one has to distinguish
 * *accepted* from *stopped*, because those are genuinely different and only the
 * first one has happened when the reply arrives.
 *
 * The daemon answers before it drains — it has to, a body cannot cross a closed
 * socket — so a 202 means the request was taken, not that the port is gone. The
 * message therefore says "shutting down" and the caller is expected to watch the
 * socket die for the rest of the story.
 *
 * The one interesting failure is `TypeError`-shaped: a fetch that never gets a
 * reply because the daemon died *during* the request. That is a successful
 * shutdown wearing a network error's clothes, and reporting it as "daemon
 * unreachable" would be true and useless. It is reported as its own case.
 */
import { type ShutdownResult, ShutdownResultSchema } from "@rewter/shared";

export type ShutdownOutcome =
  | { ok: true; result: ShutdownResult }
  /**
   * The connection died without a reply. Almost certainly the shutdown working
   * faster than the response could be written — but "almost certainly" is not
   * the same as knowing, so it says which it saw.
   */
  | { ok: true; result: null }
  | { ok: false; message: string };

export async function shutdownDaemon(fetchImpl: typeof fetch = fetch): Promise<ShutdownOutcome> {
  let response: Response;
  try {
    response = await fetchImpl("/internal/shutdown", { method: "POST" });
  } catch {
    return { ok: true, result: null };
  }

  // 501 is a daemon built without the hook — an embedded one, or a future
  // deployment that deliberately withheld it. Worth its own words: "cannot"
  // is not "failed".
  if (response.status === 501) {
    return { ok: false, message: "this daemon cannot stop itself — use `rewter stop`" };
  }
  if (!response.ok) return { ok: false, message: `daemon said ${response.status}` };

  const parsed = ShutdownResultSchema.safeParse(await response.json().catch(() => null));
  // Accepted but unreadable: the daemon is going regardless, and pretending the
  // request failed would leave the operator waiting for a daemon that is gone.
  if (!parsed.success) return { ok: true, result: null };
  return { ok: true, result: parsed.data };
}

/** The sentence to show once it has been accepted. */
export function shutdownMessage(result: ShutdownResult | null): string {
  if (result === null) return "shutting down — the connection closed before it answered.";
  const restart = `Start it again with: ${result.restartWith}`;
  if (result.willRestart === true) {
    return `Shutting down — ${result.supervisor} is expected to start it again. ${restart}`;
  }
  if (result.willRestart === null) {
    // The honest version of "it might come back": rewter does not recognise
    // whatever started it, so it declines to promise either way.
    return `Shutting down — rewter cannot tell what started it, so it may or may not come back. ${restart}`;
  }
  return `Shutting down — nothing will start it again. ${restart}`;
}
