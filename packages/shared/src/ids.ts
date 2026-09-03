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
  project: "proj",
  failure: "fail",
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
export const ProjectIdSchema = idSchema(ID_PREFIXES.project);
export const FailureRecordIdSchema = idSchema(ID_PREFIXES.failure);

export type TaskId = z.infer<typeof TaskIdSchema>;
export type WorkItemId = z.infer<typeof WorkItemIdSchema>;
export type WorkerRunId = z.infer<typeof WorkerRunIdSchema>;
export type ApprovalId = z.infer<typeof ApprovalIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type CostRecordId = z.infer<typeof CostRecordIdSchema>;
export type ProjectId = z.infer<typeof ProjectIdSchema>;
export type FailureRecordId = z.infer<typeof FailureRecordIdSchema>;

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
export const newProjectId = makeId(ID_PREFIXES.project, ProjectIdSchema);
export const newFailureRecordId = makeId(ID_PREFIXES.failure, FailureRecordIdSchema);

/** Model IDs are human-authored slugs like `anthropic/claude-sonnet-5`, not generated. */
export const ModelIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._:/-]*$/i)
  .brand("modelId");
export type ModelId = z.infer<typeof ModelIdSchema>;

/**
 * Project slugs are human-chosen handles ("clarity", "portfolio") that travel
 * everywhere the project is named from outside: the `x-rewter-project` header,
 * the `auto/orchestrator@<slug>` model suffix, and the on-disk skills directory
 * `~/.rewter/skills/<slug>/`. The charset is the intersection of what all three
 * accept safely — lowercase, digits, single hyphens; no slashes (it's a dirname),
 * no `@` or `:` (they delimit the model suffix), bounded so it fits on one
 * digest line. Distinct from the `proj_…` id, which is the stable DB key: slugs
 * are for humans and may be renamed; ids never change.
 */
export const ProjectSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .brand("projectSlug");
export type ProjectSlug = z.infer<typeof ProjectSlugSchema>;

/**
 * Skill slugs follow the agentskills.io `name` rules — lowercase, digits,
 * single hyphens, ≤64 chars — which is deliberately the same shape as project
 * slugs: both are dirnames, digest-line tokens, and things humans type at a
 * prompt (`load_skill deploy-checklist`). The slug doubles as the skill's
 * directory name on disk; the two are required to agree at index time.
 */
export const SkillSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .brand("skillSlug");
export type SkillSlug = z.infer<typeof SkillSlugSchema>;
