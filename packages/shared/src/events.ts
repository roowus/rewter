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
  TaskSettingsSchema,
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
  /**
   * A task's settings were changed after it was created — today only the
   * spending cap, from the dashboard.
   *
   * Carries the whole `TaskSettings` rather than the one field that moved,
   * because the fold's job is to hold the current `Task` and a partial would
   * make it merge two sources of truth. `from` is kept so the log reads as a
   * change rather than as a restatement: "raised $1 → $5" is the audit line,
   * and a payload with only the new value cannot produce it.
   */
  z.object({
    type: z.literal("task.settings_changed"),
    taskId: TaskIdSchema,
    from: TaskSettingsSchema,
    to: TaskSettingsSchema,
  }),
  z.object({ type: z.literal("steering.received"), taskId: TaskIdSchema, text: z.string() }),
  z.object({
    type: z.literal("handoff.initiated"),
    taskId: TaskIdSchema,
    fromWorkItemId: WorkItemIdSchema.nullable(),
    toModelId: z.string(),
    reason: z.string(),
  }),
  /**
   * The initiator tried to steer a worker and could not: the target was a
   * tier-1 worker (one model call, no turn boundary to read at) or had already
   * finished. Recorded because each is a planning miss, not a delivery fault —
   * the initiator chose a tier that forecloses steering, or steered too late —
   * and issue #7 asks how often that happens before deciding whether the answer
   * is prompt guidance or promoting the worker. A refusal that lives only in
   * the tool result cannot be counted.
   */
  z.object({
    type: z.literal("worker.message_refused"),
    taskId: TaskIdSchema,
    workItemId: WorkItemIdSchema,
    reason: z.enum(["tier_1", "finished"]),
    message: z.string(),
  }),
]);
export type EventPayload = z.infer<typeof EventPayloadSchema>;
export type EventType = EventPayload["type"];

/**
 * Every event type the union admits, derived from the schema rather than
 * hand-maintained — a list written out by hand is a second opinion about what
 * the union contains, and it goes stale the day a type is added. The server
 * validates `?type=` filters against this; the dashboard builds its filter
 * dropdown from it. A discriminated union knows its own members: `.options` is
 * the member list and each member's `type` field is the literal.
 */
export const EVENT_TYPES: readonly EventType[] = EventPayloadSchema.options.map(
  (member) => member.shape.type.value,
);

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
