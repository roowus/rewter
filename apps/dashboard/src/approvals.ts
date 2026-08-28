/**
 * Answering an approval: the one thing the dashboard does that is not reading.
 *
 * It is a REST POST rather than a socket message on purpose — an approval has
 * an outcome worth a status code. 404 is an id this daemon never saw; **409 is
 * the interesting one**: the row was already settled, which usually means the
 * same person answered in their terminal a second earlier, or another tab did.
 * That is a race the caller lost, not a mistake it made, so it reads as
 * "already answered" rather than as a failure.
 *
 * The result flows back into the tree the ordinary way, as an
 * `approval.resolved` event on the socket. Nothing here writes to the store.
 */

export interface ResolveResult {
  ok: boolean;
  /**
   * Whether a worker was actually released. `false` means the audit row was
   * settled but nobody was parked on it — a task that already finished, or one
   * from before a restart. Reported rather than hidden: it is a different fact
   * from "the worker resumed", and a user told the first one knows to look.
   */
  resumedWorker: boolean;
  message: string;
}

export async function resolveApproval(
  id: string,
  approved: boolean,
  note?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolveResult> {
  let response: Response;
  try {
    response = await fetchImpl(`/internal/approvals/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(note === undefined ? { approved } : { approved, note }),
    });
  } catch {
    // The daemon going away mid-click is the same class of event as the socket
    // dropping, and the button should say so rather than throw into a handler.
    return { ok: false, resumedWorker: false, message: "daemon unreachable" };
  }

  if (response.status === 409) {
    return { ok: false, resumedWorker: false, message: "already answered" };
  }
  if (response.status === 404) {
    return { ok: false, resumedWorker: false, message: "no such approval" };
  }
  if (!response.ok) {
    return { ok: false, resumedWorker: false, message: `daemon said ${response.status}` };
  }

  const body = (await response.json().catch(() => ({}))) as {
    resumedWorker?: boolean;
    reason?: string;
  };
  return {
    ok: true,
    resumedWorker: body.resumedWorker === true,
    message: body.resumedWorker === true ? "worker resumed" : "recorded — no worker was waiting",
  };
}
