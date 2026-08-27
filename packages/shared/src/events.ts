/**
 * Event envelope — the append-only source of truth. The dashboard task tree is
 * a pure fold over these (fold lives in this package too, once M7 needs it).
 * `seq` is assigned by SQLite AUTOINCREMENT at insert; replay = `WHERE seq > ? ORDER BY seq`.
 */
import { z } from "zod";
import {
  ApprovalSchema,
  CostRecordSchema,
  TaskSchema,
  TimestampSchema,
  WorkItemSchema,
  WorkerRunSchema,
} from "./entities.js";
import { ApprovalIdSchema, TaskIdSchema, WorkItemIdSchema, WorkerRunIdSchema } from "./ids.js";
import {
  ApprovalStatusSchema,
  TaskStatusSchema,
  WorkItemStatusSchema,
  WorkerRunStatusSchema,
} from "./lifecycle.js";

export const EventPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task.created"), task: TaskSchema }),
  z.object({
    type: z.literal("task.status_changed"),
    taskId: TaskIdSchema,
    from: TaskStatusSchema,
    to: TaskStatusSchema,
  }),
  z.object({ type: z.literal("task.plan_note"), taskId: TaskIdSchema, note: z.string() }),
  z.object({ type: z.literal("work_item.created"), workItem: WorkItemSchema }),
  z.object({
    type: z.literal("work_item.status_changed"),
    workItemId: WorkItemIdSchema,
    from: WorkItemStatusSchema,
    to: WorkItemStatusSchema,
  }),
  z.object({ type: z.literal("worker_run.created"), workerRun: WorkerRunSchema }),
  z.object({
    type: z.literal("worker_run.status_changed"),
    workerRunId: WorkerRunIdSchema,
    from: WorkerRunStatusSchema,
    to: WorkerRunStatusSchema,
  }),
  z.object({
    type: z.literal("worker_run.progress"),
    workerRunId: WorkerRunIdSchema,
    text: z.string(),
  }),
  z.object({ type: z.literal("approval.requested"), approval: ApprovalSchema }),
  z.object({
    type: z.literal("approval.resolved"),
    approvalId: ApprovalIdSchema,
    status: ApprovalStatusSchema,
    resolvedBy: z.enum(["dashboard", "in_band", "policy", "timeout"]),
    note: z.string().nullable(),
  }),
  z.object({ type: z.literal("cost.recorded"), cost: CostRecordSchema }),
  z.object({ type: z.literal("steering.received"), taskId: TaskIdSchema, text: z.string() }),
  z.object({
    type: z.literal("handoff.initiated"),
    taskId: TaskIdSchema,
    fromWorkItemId: WorkItemIdSchema.nullable(),
    toModelId: z.string(),
    reason: z.string(),
  }),
]);
export type EventPayload = z.infer<typeof EventPayloadSchema>;
export type EventType = EventPayload["type"];

export const EventEnvelopeSchema = z.object({
  /** Global monotonic order, assigned by the DB. */
  seq: z.number().int().positive(),
  ts: TimestampSchema,
  taskId: TaskIdSchema.nullable(),
  payload: EventPayloadSchema,
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** What producers hand to the event bus — seq/ts are assigned at append. */
export const NewEventSchema = EventEnvelopeSchema.omit({ seq: true, ts: true });
export type NewEvent = z.infer<typeof NewEventSchema>;
