/**
 * Killing a task from the dashboard.
 *
 * A sibling of `resolveApproval` in shape and for the same reason: an outcome
 * worth a status code, and nothing here writes to the store — the kill comes
 * back down the socket as a `task.status` event and folds like everything else.
 *
 * The distinction the daemon draws is worth surfacing rather than flattening.
 * `aborted: true` means a live orchestration was collapsed — workers cut off
 * mid-flight, and its own stream is about to write the row. `aborted: false`
 * with a 200 means the row was settled here because there was no session behind
 * it: a task from before a restart, whose "running" was a lie left on disk.
 * Those look identical in the tree a second later and are very different things
 * to have done, so the button says which one happened.
 */

export interface CancelResult {
  ok: boolean;
  /** Whether a live session was actually collapsed. */
  aborted: boolean;
  message: string;
}

export async function cancelTask(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CancelResult> {
  let response: Response;
  try {
    response = await fetchImpl(`/internal/tasks/${id}/cancel`, { method: "POST" });
  } catch {
    return { ok: false, aborted: false, message: "daemon unreachable" };
  }

  // 409 is the double-click, or the task finishing between render and click.
  // Not a failure of the caller's, and `cancelled → cancelled` is illegal, so
  // the daemon refuses rather than throwing at its own state machine.
  if (response.status === 409) {
    return { ok: false, aborted: false, message: "already finished" };
  }
  if (response.status === 404) {
    return { ok: false, aborted: false, message: "no such task" };
  }
  if (!response.ok) {
    return { ok: false, aborted: false, message: `daemon said ${response.status}` };
  }

  const body = (await response.json().catch(() => ({}))) as { aborted?: boolean };
  const aborted = body.aborted === true;
  return {
    ok: true,
    aborted,
    message: aborted ? "cancelling" : "recorded — nothing was running",
  };
}
