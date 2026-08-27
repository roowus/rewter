import { customAlphabet } from "nanoid";
import { z } from "zod";

/**
 * Branded entity IDs. The prefix is part of the value (`task_V1StGXR8z5`), so IDs
 * are self-describing in logs, events, and in-band steering replies ("approve apr_x").
 */
const alphabet = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export const ID_PREFIXES = {
  task: "task",
  workItem: "wi",
  workerRun: "run",
  approval: "apr",
  event: "evt",
  provider: "prv",
  model: "mdl",
  cost: "cst",
} as const;

type Prefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

function idSchema<P extends Prefix>(prefix: P) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_[0-9a-z]{12}$`))
    .brand(prefix);
}

export const TaskIdSchema = idSchema(ID_PREFIXES.task);
export const WorkItemIdSchema = idSchema(ID_PREFIXES.workItem);
export const WorkerRunIdSchema = idSchema(ID_PREFIXES.workerRun);
export const ApprovalIdSchema = idSchema(ID_PREFIXES.approval);
export const EventIdSchema = idSchema(ID_PREFIXES.event);
export const ProviderIdSchema = idSchema(ID_PREFIXES.provider);
export const CostRecordIdSchema = idSchema(ID_PREFIXES.cost);

export type TaskId = z.infer<typeof TaskIdSchema>;
export type WorkItemId = z.infer<typeof WorkItemIdSchema>;
export type WorkerRunId = z.infer<typeof WorkerRunIdSchema>;
export type ApprovalId = z.infer<typeof ApprovalIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type CostRecordId = z.infer<typeof CostRecordIdSchema>;

function makeId<T>(prefix: Prefix, schema: { parse: (v: string) => T }): () => T {
  return () => schema.parse(`${prefix}_${alphabet()}`);
}

export const newTaskId = makeId(ID_PREFIXES.task, TaskIdSchema);
export const newWorkItemId = makeId(ID_PREFIXES.workItem, WorkItemIdSchema);
export const newWorkerRunId = makeId(ID_PREFIXES.workerRun, WorkerRunIdSchema);
export const newApprovalId = makeId(ID_PREFIXES.approval, ApprovalIdSchema);
export const newEventId = makeId(ID_PREFIXES.event, EventIdSchema);
export const newProviderId = makeId(ID_PREFIXES.provider, ProviderIdSchema);
export const newCostRecordId = makeId(ID_PREFIXES.cost, CostRecordIdSchema);

/** Model IDs are human-authored slugs like `anthropic/claude-sonnet-5`, not generated. */
export const ModelIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._:/-]*$/i)
  .brand("modelId");
export type ModelId = z.infer<typeof ModelIdSchema>;
