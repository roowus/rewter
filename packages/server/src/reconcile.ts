/**
 * Boot reconciliation: closing out what the last process left mid-flight.
 *
 * A daemon that is killed — `kill -9`, a reboot, an OOM — leaves rows in the
 * database saying `running`, because the code that would have written a terminal
 * status died with the process. Nothing in the new process is going to finish
 * them: a task's liveness lives entirely in memory (its `AbortController`, the
 * promises parked on pending approvals, the open upstream sockets), and none of
 * that survives. So on every boot, before the socket opens, we walk the
 * non-terminal rows and mark them `interrupted`.
 *
 * **Why `interrupted` and not `failed`.** A failure is a judgement: something
 * tried and did not work. Nothing judged these. Writing `failed` would tell an
 * operator scanning history that the model got it wrong, when what actually
 * happened is that the machine went away — and it would poison the phase-2
 * learned stats, which key off exactly that success/failure distinction. The
 * separate state costs one enum member and keeps the record honest.
 *
 * **Why not resume.** Tempting, and wrong for now. A tier-2 worker mid-`shell`
 * has an unknown amount of its command already applied to the filesystem; an
 * orchestration parked on an approval has no stream left to ask on. Replaying
 * from the event log would re-run side effects that already happened. Marking
 * interrupted keeps the full history — every event is still there for the
 * dashboard to fold — and lets the user decide whether to ask again.
 *
 * The one exception is a tier-3 harness *session*, and even that is not resumed
 * *here*. The harness keeps its conversation in its own storage on disk, which
 * survives daemon death precisely because it needs no living process — so an
 * interrupted run with a `harnessSessionId` stays interrupted (this sweep's
 * only concern is closing rows honestly), and the session id it left behind is
 * offered to the *next* task's initiator instead
 * (`Repos.listResumableHarnessSessions` → the prompt header → `spawn_worker`'s
 * `resume_session_id` → `claude --resume`). Resuming is a decision about new
 * work, so it belongs to the model that plans new work, not to boot cleanup.
 *
 * Ordering is deepest-first (runs → work items → tasks), so a parent is never
 * closed while a child of it is still open: anything reading the tree mid-sweep
 * sees a consistent shape rather than a finished task with a running worker
 * under it. Each write goes through the ordinary lifecycle-guarded repo methods,
 * so every one of them emits its `status_changed` event and the dashboard's fold
 * shows the interruption rather than a task that simply stops updating.
 */
import { WORKER_RUN_TRANSITIONS, WORK_ITEM_TRANSITIONS, isTerminal } from "@rewter/shared";
import type { Repos } from "./db/repos.js";

export interface ReconcileResult {
  tasks: string[];
  workItems: string[];
  workerRuns: string[];
}

/** The note left on every row this sweep closes, so history says why. */
export const INTERRUPTED_REASON = "interrupted: the daemon stopped while this was still running";

/**
 * Mark everything the previous process left unfinished as `interrupted`.
 *
 * Idempotent by construction — it only touches non-terminal rows, and
 * `interrupted` is terminal, so a second call is a no-op. That matters because
 * this runs on *every* boot, including the boots after a clean shutdown, where
 * it should find nothing.
 */
export function reconcileOnBoot(repos: Repos): ReconcileResult {
  const result: ReconcileResult = { tasks: [], workItems: [], workerRuns: [] };

  for (const task of repos.listUnfinishedTasks()) {
    // Deepest first: a work item is only closed after its runs, and the task
    // only after its items.
    for (const item of repos.listWorkItems(task.id)) {
      for (const run of repos.listWorkerRuns(item.id)) {
        if (isTerminal(WORKER_RUN_TRANSITIONS, run.status)) continue;
        repos.transitionWorkerRun(run.id, "interrupted", { error: INTERRUPTED_REASON });
        result.workerRuns.push(run.id);
      }
      if (isTerminal(WORK_ITEM_TRANSITIONS, item.status)) continue;
      repos.transitionWorkItem(item.id, "interrupted", { error: INTERRUPTED_REASON });
      result.workItems.push(item.id);
    }

    repos.transitionTask(task.id, "interrupted", { error: INTERRUPTED_REASON });
    result.tasks.push(task.id);

    // Approvals the dead process was parked on can never be answered — the
    // promise that was waiting on them is gone. Left pending they would sit in
    // the dashboard's approvals list forever, inviting a click that resolves a
    // row nobody is listening to. `expired` is the state the lifecycle already
    // has for exactly this.
    for (const approval of repos.listPendingApprovals(task.id)) {
      repos.resolveApproval(approval.id, "expired", "timeout", INTERRUPTED_REASON);
    }
  }

  return result;
}

/** One line for the boot log; empty string when there was nothing to close. */
export function reconcileSummary(result: ReconcileResult): string {
  if (result.tasks.length === 0) return "";
  const parts = [
    `${result.tasks.length} task(s)`,
    `${result.workItems.length} work item(s)`,
    `${result.workerRuns.length} run(s)`,
  ];
  return `interrupted by a previous shutdown: ${parts.join(", ")}`;
}
