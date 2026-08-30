/**
 * Moving a task's spending cap from the dashboard.
 *
 * A sibling of `cancelTask` in shape and for the same reason: an outcome worth a
 * status code, and nothing here writes to the store. The new cap arrives back
 * down the socket as a `task.settings_changed` event and folds like everything
 * else, so the number on screen is the one the daemon is running with rather
 * than the one this module sent.
 *
 * The daemon's `applied` flag is surfaced rather than flattened, for the same
 * reason `aborted` is: a cap written onto a row nothing is executing is a real
 * outcome, but it is not "the running task will now stop at $5", and a control
 * that reported both the same way would be claiming the second.
 *
 * Parsing is left to the caller's input handling — the empty string means
 * uncapped, and turning that into `null` here would make `""` and `"0"`
 * indistinguishable at the boundary where the difference still exists.
 */

export interface BudgetResult {
  ok: boolean;
  /** Whether a live session took the new cap, or only the row moved. */
  applied: boolean;
  message: string;
}

export async function setTaskBudget(
  id: string,
  maxSpendUsd: number | null,
  fetchImpl: typeof fetch = fetch,
): Promise<BudgetResult> {
  let response: Response;
  try {
    response = await fetchImpl(`/internal/tasks/${id}/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxSpendUsd }),
    });
  } catch {
    return { ok: false, applied: false, message: "daemon unreachable" };
  }

  // 409 is the task finishing between render and click. A cap on a finished
  // task would write cleanly and mean nothing.
  if (response.status === 409) {
    return { ok: false, applied: false, message: "already finished" };
  }
  if (response.status === 404) {
    return { ok: false, applied: false, message: "no such task" };
  }
  if (response.status === 400) {
    return { ok: false, applied: false, message: "must be a positive amount" };
  }
  if (!response.ok) {
    return { ok: false, applied: false, message: `daemon said ${response.status}` };
  }

  const body = (await response.json().catch(() => ({}))) as { applied?: boolean };
  const applied = body.applied === true;
  return {
    ok: true,
    applied,
    message: applied ? "budget updated" : "saved — nothing was running",
  };
}
