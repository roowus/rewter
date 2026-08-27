/**
 * Lifecycle state machines for every stateful entity.
 *
 * These are the ONLY legal transition definitions — repos call `assertTransition`
 * on every status write, so an illegal transition throws before touching the DB.
 *
 *   Task:      pending → running → succeeded|failed|cancelled   (⇅ waiting_approval)
 *   WorkItem:  pending → running → succeeded|failed|cancelled|handed_off (⇅ waiting_approval)
 *   WorkerRun: created → streaming ⇄ tool_pending → succeeded|failed|cancelled
 *   Approval:  pending → approved|denied|auto_approved|expired
 */
import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "pending",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const WorkItemStatusSchema = z.enum([
  "pending",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "handed_off",
]);
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>;

export const WorkerRunStatusSchema = z.enum([
  "created",
  "streaming",
  "tool_pending",
  "succeeded",
  "failed",
  "cancelled",
]);
export type WorkerRunStatus = z.infer<typeof WorkerRunStatusSchema>;

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "auto_approved",
  "expired",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

export const TASK_TRANSITIONS: TransitionMap<TaskStatus> = {
  pending: ["running", "cancelled", "failed"],
  running: ["waiting_approval", "succeeded", "failed", "cancelled"],
  waiting_approval: ["running", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export const WORK_ITEM_TRANSITIONS: TransitionMap<WorkItemStatus> = {
  pending: ["running", "cancelled", "failed"],
  running: ["waiting_approval", "succeeded", "failed", "cancelled", "handed_off"],
  waiting_approval: ["running", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  handed_off: [],
};

export const WORKER_RUN_TRANSITIONS: TransitionMap<WorkerRunStatus> = {
  created: ["streaming", "failed", "cancelled"],
  streaming: ["tool_pending", "succeeded", "failed", "cancelled"],
  tool_pending: ["streaming", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export const APPROVAL_TRANSITIONS: TransitionMap<ApprovalStatus> = {
  pending: ["approved", "denied", "auto_approved", "expired"],
  approved: [],
  denied: [],
  auto_approved: [],
  expired: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly entity: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`illegal ${entity} transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

function makeAssert<S extends string>(entity: string, map: TransitionMap<S>) {
  return (from: S, to: S): void => {
    if (!map[from].includes(to)) throw new IllegalTransitionError(entity, from, to);
  };
}

export const assertTaskTransition = makeAssert("Task", TASK_TRANSITIONS);
export const assertWorkItemTransition = makeAssert("WorkItem", WORK_ITEM_TRANSITIONS);
export const assertWorkerRunTransition = makeAssert("WorkerRun", WORKER_RUN_TRANSITIONS);
export const assertApprovalTransition = makeAssert("Approval", APPROVAL_TRANSITIONS);

export function isTerminal<S extends string>(map: TransitionMap<S>, status: S): boolean {
  return map[status].length === 0;
}
