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
import { setTaskBudget } from "./budget.js";
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

/**
 * The spending cap, shown and — while the task is live — editable.
 *
 * The cap has existed since M5 and been unreachable: a task spawned from Claude
 * Code takes whatever the config file says, and a user watching it burn through
 * that number had no way to move it without editing a file and restarting the
 * daemon. This is the control that closes that.
 *
 * Two rules the display turns on. `null` is *uncapped*, not `$0` — `usd(0)` for
 * a task with no ceiling would read as a task that may not spend, which is the
 * exact opposite. And the field is seeded from the folded cap but not bound to
 * it: a fold arriving mid-edit (a worker's cost, say) must not overwrite what
 * is being typed, so `draft` is committed on submit and reset on cancel.
 *
 * No optimistic write. The daemon's `task.settings_changed` event is what moves
 * the number, so a POST it refused leaves the old cap on screen — true.
 */
function Budget({
  taskId,
  cap,
  spent,
  live,
}: {
  taskId: string;
  cap: number | null;
  spent: number;
  live: boolean;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  function open(): void {
    setDraft(cap === null ? "" : String(cap));
    setOutcome(null);
    setEditing(true);
  }

  async function save(): Promise<void> {
    const trimmed = draft.trim();
    // Empty means uncapped. That is the only way to *remove* a cap, so it has
    // to be a distinct input rather than an amount of zero.
    const next = trimmed === "" ? null : Number(trimmed);
    if (next !== null && (!Number.isFinite(next) || next <= 0)) {
      setOutcome("must be a positive amount");
      return;
    }
    setBusy(true);
    const result = await setTaskBudget(taskId, next);
    setOutcome(result.message);
    setBusy(false);
    if (result.ok) setEditing(false);
  }

  const pct = cap === null || cap <= 0 ? null : Math.min(100, Math.round((spent / cap) * 100));

  return (
    <p className="task-budget">
      <span className="budget-label">budget</span>{" "}
      {cap === null ? (
        <span className="budget-cap" title="no ceiling — the task spends until it finishes">
          uncapped
        </span>
      ) : (
        <span className="budget-cap">
          {usd(spent)} of <strong>{usd(cap)}</strong>
          {pct !== null && <span className="budget-pct"> ({pct}%)</span>}
        </span>
      )}
      {live && !editing && (
        <button type="button" className="budget-edit" onClick={open}>
          {cap === null ? "Set budget" : "Change"}
        </button>
      )}
      {editing && (
        <span className="budget-form">
          <label htmlFor={`budget-${taskId}`} className="visually-hidden">
            budget cap in dollars
          </label>
          <input
            id={`budget-${taskId}`}
            type="text"
            inputMode="decimal"
            value={draft}
            placeholder="uncapped"
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="button" onClick={() => void save()} disabled={busy}>
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </button>
        </span>
      )}
      {outcome !== null && <span className="budget-outcome">{outcome}</span>}
    </p>
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

      <Budget
        taskId={task.task.id}
        cap={task.task.settings.maxSpendUsd}
        spent={task.costUsd}
        live={live}
      />

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
