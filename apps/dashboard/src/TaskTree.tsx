/**
 * The task tree: one folded task, rendered.
 *
 * Every value here comes out of `FoldedTask`, which is a pure reduction over the
 * event log — so there is nothing to fetch and nothing that can disagree with
 * what the daemon thinks. Where a field is deliberately absent from the stream
 * (`resultSummary`, `error` — see `fold.ts`) this shows what it does have rather
 * than inventing a placeholder.
 */
import {
  type FoldedTask,
  type FoldedWorkItem,
  TASK_TRANSITIONS,
  isTerminal,
  pendingApprovals,
} from "@rewter/shared";
import { useState } from "react";
import { ApprovalCard } from "./ApprovalCard.js";
import { cancelTask } from "./cancel.js";
import { clockTime, elapsed, shortModelId, usd } from "./format.js";

/** Status drives colour via a data attribute; the CSS owns the palette. */
function Status({ value }: { value: string }): JSX.Element {
  return (
    <span className="status" data-status={value}>
      {value.replace(/_/g, " ")}
    </span>
  );
}

function WorkItemRow({ item, now }: { item: FoldedWorkItem; now: number }): JSX.Element {
  const runs = item.runs;
  // Retries are the interesting case: a work item on attempt 3 is a different
  // story from one that worked, and the count is the cheapest way to say so.
  const attempts = runs.length;

  return (
    <li className="work-item">
      <div className="work-item-head">
        <span className="label">{item.label}</span>
        <span className="title">{item.workItem.title}</span>
        <Status value={item.workItem.status} />
        <span className="model">{shortModelId(item.workItem.modelId)}</span>
        <span className="tier">T{item.workItem.tier}</span>
        {attempts > 1 && <span className="attempts">{attempts} attempts</span>}
        <span className="cost">{usd(item.costUsd)}</span>
        <span className="elapsed">{elapsed(item.workItem, now)}</span>
      </div>

      {/* `report_progress` notes, newest last — a worker's own account of what
          it is doing, which is all the detail the stream carries mid-run. */}
      {runs.flatMap((run) =>
        run.notes.map((note) => (
          <p className="note" key={`${run.run.id}-${note.seq}`}>
            <time dateTime={new Date(note.ts).toISOString()}>{clockTime(note.ts)}</time>
            {note.text}
          </p>
        )),
      )}
    </li>
  );
}

/**
 * The kill button.
 *
 * Same rule as the approval card: it does not remove itself or recolour the
 * status on click. The kill travels to the daemon, comes back as a `task.status`
 * event, and the fold is what changes the tree — so a POST the daemon refused
 * leaves the UI still showing a running task, which is the truth.
 *
 * It stays disabled after a successful click because the task is on its way to
 * terminal, and a second click on a cancelled task is the 409 case.
 */
function KillButton({ taskId }: { taskId: string }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  async function kill(): Promise<void> {
    setBusy(true);
    const result = await cancelTask(taskId);
    setOutcome(result.message);
    if (!result.ok) setBusy(false);
  }

  return (
    <>
      <button type="button" className="kill" onClick={() => void kill()} disabled={busy}>
        Kill
      </button>
      {outcome !== null && <span className="kill-outcome">{outcome}</span>}
    </>
  );
}

export function TaskTree({ task, now }: { task: FoldedTask; now: number }): JSX.Element {
  const pending = pendingApprovals(task);
  // A finished task has nothing to kill, and offering the button anyway would
  // be offering the 409.
  const live = !isTerminal(TASK_TRANSITIONS, task.task.status);

  return (
    <section className="task" aria-label={task.task.title}>
      <header className="task-head">
        <h2>{task.task.title}</h2>
        <Status value={task.task.status} />
        <span className="model">{shortModelId(task.task.initiatorModelId)}</span>
        <span className="elapsed">{elapsed(task.task, now)}</span>
        {live && <KillButton taskId={task.task.id} />}
      </header>

      {/* The split this design exists to justify: if the planner outspends the
          work, a single total would hide it. */}
      <p className="task-cost">
        <strong>{usd(task.costUsd)}</strong> total —{" "}
        <span title="the initiator's own tokens">{usd(task.initiatorCostUsd)} planning</span>
      </p>

      {pending.length > 0 && (
        <div className="approvals" aria-label="pending approvals">
          {pending.map((approval) => (
            <ApprovalCard approval={approval} key={approval.id} />
          ))}
        </div>
      )}

      {task.planNotes.length > 0 && (
        <ol className="plan">
          {task.planNotes.map((note) => (
            <li key={note.seq}>{note.text}</li>
          ))}
        </ol>
      )}

      {task.steering.length > 0 && (
        <ol className="steering" aria-label="steering">
          {task.steering.map((note) => (
            <li key={note.seq}>{note.text}</li>
          ))}
        </ol>
      )}

      <ul className="work-items">
        {task.workItems.map((item) => (
          <WorkItemRow item={item} now={now} key={item.workItem.id} />
        ))}
      </ul>

      {/* A handoff is the initiator judging itself unfit, which is a headline
          event in this system rather than a footnote. */}
      {task.handoffs.map((handoff) => (
        <p className="handoff" key={handoff.seq}>
          handed off to <strong>{shortModelId(handoff.toModelId)}</strong> — {handoff.reason}
        </p>
      ))}
    </section>
  );
}
