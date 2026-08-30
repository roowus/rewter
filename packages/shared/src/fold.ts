/**
 * The fold: `EventEnvelope[]` → task tree.
 *
 * The event log is the source of truth, so the dashboard's view of a task is a
 * pure reduction over it rather than a second answer computed on the server.
 * That is also why there is no `GET /internal/tasks/:id` — two implementations of
 * "what is this task doing" is two things that can disagree, and the one the user
 * is looking at would be the one nobody tested.
 *
 * It lives in `shared` so both sides run the same code: the daemon can fold to
 * answer a question, the dashboard folds a WS replay, and neither can drift.
 *
 * ## Incremental by construction
 *
 * A dashboard connects, replays `events?afterSeq=N`, then receives live events one
 * at a time. So the unit is `applyEvent(state, event)` and `foldEvents` is just a
 * loop over it: the same state survives the handover from replay to live, and a
 * client never re-folds from zero to show one new line.
 *
 * `seq` is the guard. Replay and the live subscription overlap — an event appended
 * between the replay query and the subscription arrives twice — so anything at or
 * below `lastSeq` is dropped. Without that, a duplicated `cost.recorded` bills the
 * user twice on screen.
 *
 * ## What the stream does and does not carry
 *
 * Status transitions travel as `{from, to}` and nothing else: `resultSummary`,
 * `error` and the final answer never reach the log. So a folded entity has its
 * `status`, `updatedAt` and `finishedAt` patched (all three are derivable from the
 * transition and the envelope's `ts`), while `resultSummary` and `error` stay as
 * they were at creation — i.e. `null`. A consumer that needs the answer text reads
 * it from the response stream, not from here.
 *
 * ## Labels are derived, not transmitted
 *
 * The engine names workers `w1`, `w2`, … by spawn order, and that name appears in
 * the user's feed — but it is engine-local state that never enters an event. The
 * fold reassigns it from `work_item.created` order, which is the same order,
 * *provided the fold saw every creation*. A fold that starts mid-stream cannot
 * know how many workers preceded it, so its labels are its own; `orphanedEvents`
 * is how a UI can tell that happened.
 */
import type { Approval, CostRecord, Task, WorkItem, WorkerRun } from "./entities.js";
import type { EventEnvelope } from "./events.js";
import {
  TASK_TRANSITIONS,
  type TaskStatus,
  WORKER_RUN_TRANSITIONS,
  WORK_ITEM_TRANSITIONS,
  type WorkItemStatus,
  type WorkerRunStatus,
  isTerminal,
} from "./lifecycle.js";

/** A worker's own `report_progress` note, or any other timestamped line. */
export interface FoldedNote {
  seq: number;
  ts: number;
  text: string;
}

export interface FoldedHandoff {
  seq: number;
  ts: number;
  fromWorkItemId: string | null;
  toModelId: string;
  reason: string;
}

/**
 * One attempt at a work item. `run` is patched in place for status/timestamps —
 * see the module note on what the stream carries.
 */
export interface FoldedRun {
  run: WorkerRun;
  /** `worker_run.progress` lines, in arrival order. */
  notes: FoldedNote[];
  costUsd: number;
}

/** A work item plus everything that happened under it. */
export interface FoldedWorkItem {
  /** `w1`, `w2`, … — derived here; see the module note. */
  label: string;
  workItem: WorkItem;
  runs: FoldedRun[];
  /** Sum over this item's runs. */
  costUsd: number;
}

export interface FoldedTask {
  task: Task;
  workItems: FoldedWorkItem[];
  /** In request order; resolved ones keep their resolution. */
  approvals: Approval[];
  planNotes: FoldedNote[];
  /** User turns injected mid-run. */
  steering: FoldedNote[];
  handoffs: FoldedHandoff[];
  /** Every cost record seen, whoever it was attributed to. */
  costUsd: number;
  /**
   * Spend with no `workerRunId` — the initiator's own tokens. Split out because
   * "the planner cost more than the work" is the question this design exists to
   * answer, and a single total hides it.
   */
  initiatorCostUsd: number;
  /** Highest `seq` folded into this task, for per-task resume. */
  lastSeq: number;
}

export interface FoldState {
  /** Keyed by task id. */
  tasks: Record<string, FoldedTask>;
  /** Highest `seq` folded, for `?afterSeq=`. */
  lastSeq: number;
  /**
   * Events referring to an entity this fold never saw created — the signature of
   * a replay that started partway through. Not an error: a mid-stream fold is a
   * legitimate thing to want, it just cannot be complete, and silently dropping
   * the evidence would make it look complete.
   */
  orphanedEvents: number;
}

export function emptyFoldState(): FoldState {
  return { tasks: {}, lastSeq: 0, orphanedEvents: 0 };
}

/** Fold a batch. Pass `from` to continue an existing state (replay → live). */
export function foldEvents(
  events: readonly EventEnvelope[],
  from: FoldState = emptyFoldState(),
): FoldState {
  let state = from;
  for (const event of events) state = applyEvent(state, event);
  return state;
}

/** Convenience for the single-task case: fold everything, return one task. */
export function foldTask(events: readonly EventEnvelope[], taskId: string): FoldedTask | undefined {
  return foldEvents(events).tasks[taskId];
}

/** Tasks in creation order (`task.created` seq), newest last. */
export function tasksInOrder(state: FoldState): FoldedTask[] {
  return Object.values(state.tasks).sort((a, b) => a.task.createdAt - b.task.createdAt);
}

/** Cards still awaiting an answer — what the dashboard's approval queue renders. */
export function pendingApprovals(task: FoldedTask): Approval[] {
  return task.approvals.filter((a) => a.status === "pending");
}

/**
 * Apply one event.
 *
 * A re-delivered event (`seq <= lastSeq`) returns the *same* state object, so a
 * store can compare by identity and skip the render entirely — the overlap
 * between replay and the live subscription is the common case, not a rare one.
 * Anything else returns a new state, because even an event that changed no
 * entity moved `lastSeq`, and that is what the next `?afterSeq=` asks with.
 */
export function applyEvent(state: FoldState, event: EventEnvelope): FoldState {
  // Replay and the live subscription overlap by design; see the module note.
  if (event.seq <= state.lastSeq) return state;

  const payload = event.payload;

  // `task.created` is the only event that may introduce a task.
  if (payload.type === "task.created") {
    const task = payload.task;
    return {
      ...state,
      lastSeq: event.seq,
      tasks: {
        ...state.tasks,
        [task.id]: {
          task,
          workItems: [],
          approvals: [],
          planNotes: [],
          steering: [],
          handoffs: [],
          costUsd: 0,
          initiatorCostUsd: 0,
          lastSeq: event.seq,
        },
      },
    };
  }

  const taskId = taskIdOf(event);
  const existing = taskId === null ? undefined : state.tasks[taskId];
  if (taskId === null || existing === undefined) {
    // Advance `lastSeq` anyway: the event was seen, and refusing to record that
    // would make the next `?afterSeq=` ask for it again forever.
    return { ...state, lastSeq: event.seq, orphanedEvents: state.orphanedEvents + 1 };
  }

  const updated = applyToTask(existing, event);
  if (updated === existing) {
    return { ...state, lastSeq: event.seq, orphanedEvents: state.orphanedEvents + 1 };
  }
  return {
    ...state,
    lastSeq: event.seq,
    tasks: { ...state.tasks, [taskId]: { ...updated, lastSeq: event.seq } },
  };
}

/** Returns `task` unchanged when the event referred to something unknown. */
function applyToTask(task: FoldedTask, event: EventEnvelope): FoldedTask {
  const p = event.payload;
  switch (p.type) {
    case "task.created":
      // Handled by the caller; a second one for the same task is a duplicate.
      return task;

    case "task.status_changed":
      return {
        ...task,
        task: patchStatus(task.task, p.to, event.ts, TASK_TRANSITIONS),
      };

    case "task.plan_note":
      return { ...task, planNotes: [...task.planNotes, note(event, p.note)] };

    // Unlike a status change, this replaces the field wholesale rather than
    // patching it: `to` is the settings object the daemon is running with, so
    // adopting it keeps the fold's `Task` identical to the row rather than
    // merging toward it.
    case "task.settings_changed":
      return { ...task, task: { ...task.task, settings: p.to, updatedAt: event.ts } };

    case "steering.received":
      return { ...task, steering: [...task.steering, note(event, p.text)] };

    case "handoff.initiated":
      return {
        ...task,
        handoffs: [
          ...task.handoffs,
          {
            seq: event.seq,
            ts: event.ts,
            fromWorkItemId: p.fromWorkItemId,
            toModelId: p.toModelId,
            reason: p.reason,
          },
        ],
      };

    case "work_item.created": {
      if (task.workItems.some((w) => w.workItem.id === p.workItem.id)) return task;
      return {
        ...task,
        workItems: [
          ...task.workItems,
          {
            label: `w${task.workItems.length + 1}`,
            workItem: p.workItem,
            runs: [],
            costUsd: 0,
          },
        ],
      };
    }

    case "work_item.status_changed":
      return mapWorkItem(task, p.workItemId, (item) => ({
        ...item,
        workItem: patchStatus(item.workItem, p.to, event.ts, WORK_ITEM_TRANSITIONS),
      }));

    case "worker_run.created":
      return mapWorkItem(task, p.workerRun.workItemId, (item) =>
        item.runs.some((r) => r.run.id === p.workerRun.id)
          ? item
          : { ...item, runs: [...item.runs, { run: p.workerRun, notes: [], costUsd: 0 }] },
      );

    case "worker_run.status_changed":
      return mapRun(task, p.workerRunId, (r) => ({
        ...r,
        run: patchStatus(r.run, p.to, event.ts, WORKER_RUN_TRANSITIONS),
      }));

    case "worker_run.progress":
      return mapRun(task, p.workerRunId, (r) => ({
        ...r,
        notes: [...r.notes, note(event, p.text)],
      }));

    case "approval.requested": {
      if (task.approvals.some((a) => a.id === p.approval.id)) return task;
      return { ...task, approvals: [...task.approvals, p.approval] };
    }

    case "approval.resolved": {
      const index = task.approvals.findIndex((a) => a.id === p.approvalId);
      if (index === -1) return task;
      const approvals = [...task.approvals];
      approvals[index] = {
        ...(approvals[index] as Approval),
        status: p.status,
        resolvedBy: p.resolvedBy,
        resolutionNote: p.note,
        // The row's own `resolvedAt` never travels; the envelope's `ts` is the
        // same moment, written by the same append.
        resolvedAt: event.ts,
      };
      return { ...task, approvals };
    }

    case "cost.recorded":
      return applyCost(task, p.cost);
  }
}

/**
 * Costs land on the run that spent them and roll up to the task.
 *
 * A record with no `workerRunId` is the initiator's own; one naming a run we
 * never saw created still counts toward the task total — dropping money because
 * the fold started late would understate the bill, which is the one direction a
 * cost display must not be wrong in.
 */
function applyCost(task: FoldedTask, cost: CostRecord): FoldedTask {
  const total = task.costUsd + cost.costUsd;
  if (cost.workerRunId === null) {
    return { ...task, costUsd: total, initiatorCostUsd: task.initiatorCostUsd + cost.costUsd };
  }
  const withRun = mapRun(task, cost.workerRunId, (r) => ({
    ...r,
    costUsd: r.costUsd + cost.costUsd,
  }));
  if (withRun === task) return { ...task, costUsd: total };
  return {
    ...withRun,
    costUsd: total,
    workItems: withRun.workItems.map((item) => ({
      ...item,
      costUsd: item.runs.reduce((sum, r) => sum + r.costUsd, 0),
    })),
  };
}

function mapWorkItem(
  task: FoldedTask,
  workItemId: string,
  f: (item: FoldedWorkItem) => FoldedWorkItem,
): FoldedTask {
  const index = task.workItems.findIndex((w) => w.workItem.id === workItemId);
  if (index === -1) return task;
  const current = task.workItems[index] as FoldedWorkItem;
  const next = f(current);
  if (next === current) return task;
  const workItems = [...task.workItems];
  workItems[index] = next;
  return { ...task, workItems };
}

function mapRun(
  task: FoldedTask,
  workerRunId: string,
  f: (run: FoldedRun) => FoldedRun,
): FoldedTask {
  for (const item of task.workItems) {
    const index = item.runs.findIndex((r) => r.run.id === workerRunId);
    if (index === -1) continue;
    return mapWorkItem(task, item.workItem.id, (w) => {
      const runs = [...w.runs];
      runs[index] = f(runs[index] as FoldedRun);
      return { ...w, runs };
    });
  }
  return task;
}

/**
 * Patch what a transition event actually tells us: the new status, the moment it
 * happened, and — when the status is terminal — that the entity is finished.
 * Everything else stays as created; see the module note.
 */
function patchStatus<
  S extends TaskStatus | WorkItemStatus | WorkerRunStatus,
  E extends { status: S; updatedAt: number; finishedAt: number | null },
>(entity: E, to: S, ts: number, transitions: Readonly<Record<S, readonly S[]>>): E {
  return {
    ...entity,
    status: to,
    updatedAt: ts,
    finishedAt: isTerminal(transitions, to) ? ts : entity.finishedAt,
  };
}

function note(event: EventEnvelope, text: string): FoldedNote {
  return { seq: event.seq, ts: event.ts, text };
}

/** The envelope's `taskId` is authoritative; payloads that carry one agree with it. */
function taskIdOf(event: EventEnvelope): string | null {
  if (event.taskId !== null) return event.taskId;
  const p = event.payload;
  if ("taskId" in p && typeof p.taskId === "string") return p.taskId;
  return null;
}
