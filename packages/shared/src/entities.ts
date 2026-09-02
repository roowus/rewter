/**
 * Domain entities. These schemas are the cross-boundary contract: the server's
 * repos parse rows through them on read, and the dashboard consumes the same types.
 */
import { z } from "zod";
import {
  ApprovalIdSchema,
  CostRecordIdSchema,
  ModelIdSchema,
  ProjectIdSchema,
  ProjectSlugSchema,
  ProviderIdSchema,
  TaskIdSchema,
  WorkItemIdSchema,
  WorkerRunIdSchema,
} from "./ids.js";
import {
  ApprovalStatusSchema,
  TaskStatusSchema,
  WorkItemStatusSchema,
  WorkerRunStatusSchema,
} from "./lifecycle.js";

/** Epoch milliseconds. SQLite stores integers; zod guards the round-trip. */
export const TimestampSchema = z.number().int().nonnegative();

export const ProviderKindSchema = z.enum(["anthropic", "openai-compat", "google"]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ProviderSchema = z.object({
  id: ProviderIdSchema,
  name: z.string().min(1),
  kind: ProviderKindSchema,
  baseUrl: z.string().url().nullable(),
  /** Env var NAME holding the key — raw keys never enter the DB. */
  apiKeyRef: z.string().min(1).nullable(),
  enabled: z.boolean(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Provider = z.infer<typeof ProviderSchema>;

export const ModelPricingSchema = z.object({
  inputPerMTok: z.number().nonnegative().nullable(),
  outputPerMTok: z.number().nonnegative().nullable(),
  cacheReadPerMTok: z.number().nonnegative().nullable(),
  cacheWritePerMTok: z.number().nonnegative().nullable(),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const ModelSchema = z.object({
  id: ModelIdSchema,
  providerId: ProviderIdSchema,
  /** The identifier sent upstream (may differ from our slug). */
  upstreamId: z.string().min(1),
  displayName: z.string().min(1),
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  pricing: ModelPricingSchema,
  modalities: z.array(z.enum(["text", "image", "audio", "video"])),
  /**
   * Tri-state on purpose: `null` is "no upstream ever said", which is the
   * common case. Most catalogs are an id list, so a boolean here would be a
   * guess wearing a fact's clothes — and both guesses cost something. A false
   * `vision` hides the one model that could have read the scan; a true `tools`
   * gets a tool-less model spawned for tier-2 work, where it fails on its
   * first tool call. Enrichment and the registry editor promote nulls to
   * booleans as evidence arrives; consumers must read `=== false`, not
   * falsiness, before ruling a model out.
   */
  supports: z.object({
    tools: z.boolean().nullable(),
    streaming: z.boolean().nullable(),
    vision: z.boolean().nullable(),
    caching: z.boolean().nullable(),
  }),
  source: z.enum(["synced", "manual"]),
  enabled: z.boolean(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Model = z.infer<typeof ModelSchema>;

/**
 * Fixed capability-tag vocabulary. Doubles as the ModelStat taskTag key so
 * learned stats (phase 2) join cleanly onto cards.
 */
export const CapabilityTagSchema = z.enum([
  "coding",
  "reasoning",
  "planning",
  "summarization",
  "extraction",
  "ocr",
  "vision",
  "translation",
  "creative_writing",
  "math",
  "web_research",
  "long_context",
  "fast_cheap",
  "tool_use",
]);
export type CapabilityTag = z.infer<typeof CapabilityTagSchema>;

export const CapabilityCardSchema = z.object({
  modelId: ModelIdSchema,
  summary: z.string(),
  strengths: z.array(CapabilityTagSchema),
  weaknesses: z.array(CapabilityTagSchema),
  bestAt: z.array(CapabilityTagSchema),
  notes: z.string().nullable(),
  /** JSON-merge patch applied over the generated card; survives regeneration. */
  userOverrides: z.record(z.unknown()).nullable(),
  generatedBy: ModelIdSchema.nullable(),
  generatedAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
});
export type CapabilityCard = z.infer<typeof CapabilityCardSchema>;

// ── Projects (phase 2) ───────────────────────────────────────────────────────
//
// A project is a durable, named container for related work: it pins resources
// (repos/dirs/docs), owns learned state by scoping (skills, memory, stats),
// carries policy (budget + approval rules), and holds model preferences. Tasks
// reference a project via a *nullable* projectId — nullable is the whole
// compatibility story: a project-less task behaves exactly like phase 1.

export const ProjectResourceSchema = z.object({
  /**
   * `dir` and `repo` are local paths; `doc` and `url` are references the
   * initiator can read/fetch. The FIRST `dir` resource is the project's primary
   * workspace — order matters, which is why resources are an array, not a set.
   */
  kind: z.enum(["dir", "repo", "doc", "url"]),
  /** Absolute path for dir/repo/doc, URL for url. */
  location: z.string().min(1),
  /** Why this resource is attached — rendered into the project block verbatim. */
  note: z.string().nullable().default(null),
});
export type ProjectResource = z.infer<typeof ProjectResourceSchema>;

export const ProjectPolicySchema = z.object({
  /**
   * Project-level counterpart of TaskSettings.autoApprove. Precedence is
   * tighten-only (see effectiveTaskSettings in projects.ts): a task inside a
   * gated project cannot turn approvals off. Defaults false because project
   * workspaces point at real repos — "inside the workspace" auto-approves
   * writes to real code, so the loosening must be an explicit owner act.
   */
  autoApprove: z.boolean().default(false),
  /** Project spending cap; tasks can tighten it, never raise it. null = uncapped. */
  maxSpendUsd: z.number().positive().nullable().default(null),
  /** null = all tools allowed; a list is an allowlist enforced at spawn time. */
  allowedTools: z.array(z.string().min(1)).nullable().default(null),
  /** null = all harnesses; a list gates tier-3 adapters (phase-2 M5). */
  allowedHarnesses: z.array(z.string().min(1)).nullable().default(null),
});
export type ProjectPolicy = z.infer<typeof ProjectPolicySchema>;

export const ProjectModelPrefsSchema = z.object({
  /** Overrides the global default initiator for tasks in this project. */
  initiatorPin: ModelIdSchema.nullable().default(null),
  /**
   * Advise-only (locked decision 4): these are rendered into the digest as
   * hints, not enforced — the initiator still decides.
   */
  prefer: z.array(ModelIdSchema).default([]),
  avoid: z.array(ModelIdSchema).default([]),
});
export type ProjectModelPrefs = z.infer<typeof ProjectModelPrefsSchema>;

export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  /** Human handle used by the header, model suffix, and skills dir — see ids.ts. */
  slug: ProjectSlugSchema,
  name: z.string().min(1),
  description: z.string().default(""),
  resources: z.array(ProjectResourceSchema).default([]),
  policy: ProjectPolicySchema.default({}),
  modelPrefs: ProjectModelPrefsSchema.default({}),
  /**
   * Archived projects are hidden from selection (header/suffix/cwd lookups
   * refuse them) but never deleted implicitly — their tasks, costs, and skills
   * remain attributed. Like provider `enabled`, this is configuration, not a
   * lifecycle: projects have no state machine.
   */
  archived: z.boolean().default(false),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const TaskSettingsSchema = z.object({
  autoApprove: z.boolean().default(false),
  maxSpendUsd: z.number().positive().nullable().default(null),
  workspaceDir: z.string().nullable().default(null),
  concurrency: z.number().int().positive().max(16).default(4),
});
export type TaskSettings = z.infer<typeof TaskSettingsSchema>;

export const TaskSchema = z.object({
  id: TaskIdSchema,
  status: TaskStatusSchema,
  title: z.string().min(1),
  initiatorModelId: ModelIdSchema,
  /**
   * Phase 2: the project this task runs inside, or null for a bare task that
   * behaves exactly as phase 1. `.default(null)` is load-bearing, not
   * convenience — `task.created` events embed the full Task, so the append-only
   * logs of existing databases hold payloads without this field, and replay
   * re-parses them through this schema.
   */
  projectId: ProjectIdSchema.nullable().default(null),
  /** Fingerprint of the originating conversation prefix, for LiveTaskIndex steering. */
  conversationFingerprint: z.string().nullable(),
  settings: TaskSettingsSchema,
  resultSummary: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
});
export type Task = z.infer<typeof TaskSchema>;

export const WorkerTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type WorkerTier = z.infer<typeof WorkerTierSchema>;

export const WorkItemSchema = z.object({
  id: WorkItemIdSchema,
  taskId: TaskIdSchema,
  /** Set when this item was spawned by a handoff — forms handoff chains. */
  parentWorkItemId: WorkItemIdSchema.nullable(),
  status: WorkItemStatusSchema,
  title: z.string().min(1),
  instructions: z.string(),
  modelId: ModelIdSchema,
  tier: WorkerTierSchema,
  /**
   * The kind of work the initiator filed this subtask under, from the same
   * vocabulary as capability cards — the key its outcome is recorded against in
   * `model_stats`. Null when the initiator did not say; such items are never
   * counted, because a guess would poison the statistic it feeds.
   */
  taskTag: CapabilityTagSchema.nullable().default(null),
  resultSummary: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;
/**
 * What a caller may hand `createWorkItem`: the same shape with the defaulted
 * fields optional. The parsed `WorkItem` is what comes back out.
 */
export type WorkItemInput = z.input<typeof WorkItemSchema>;

export const WorkerRunSchema = z.object({
  id: WorkerRunIdSchema,
  workItemId: WorkItemIdSchema,
  taskId: TaskIdSchema,
  status: WorkerRunStatusSchema,
  modelId: ModelIdSchema,
  tier: WorkerTierSchema,
  attempt: z.number().int().positive(),
  /** Phase-2: tmux/harness session identifier for tier-3 boot reconciliation. */
  harnessSessionId: z.string().nullable(),
  resultText: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
});
export type WorkerRun = z.infer<typeof WorkerRunSchema>;

export const ApprovalKindSchema = z.enum([
  "shell",
  "write_outside_workspace",
  "spawn_harness",
  "budget",
  "other",
]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalSchema = z.object({
  id: ApprovalIdSchema,
  taskId: TaskIdSchema,
  workItemId: WorkItemIdSchema.nullable(),
  workerRunId: WorkerRunIdSchema.nullable(),
  status: ApprovalStatusSchema,
  kind: ApprovalKindSchema,
  /** Human-readable description of what's being requested (the exact command, path, …). */
  summary: z.string().min(1),
  detail: z.record(z.unknown()).nullable(),
  resolvedBy: z.enum(["dashboard", "in_band", "policy", "timeout"]).nullable(),
  resolutionNote: z.string().nullable(),
  createdAt: TimestampSchema,
  resolvedAt: TimestampSchema.nullable(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const CostRecordSchema = z.object({
  id: CostRecordIdSchema,
  taskId: TaskIdSchema.nullable(),
  workerRunId: WorkerRunIdSchema.nullable(),
  modelId: ModelIdSchema,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  /** Computed at write time from the pricing snapshot below — never recomputed. */
  costUsd: z.number().nonnegative(),
  pricingSnapshot: ModelPricingSchema,
  createdAt: TimestampSchema,
});
export type CostRecord = z.infer<typeof CostRecordSchema>;

/**
 * Learned outcomes per (model, kind of work). Written by the server's stats
 * recorder from every tagged work item that reaches a verdict; read by the
 * registry digest as `stats:` facts. Means are running means over `attempts`.
 */
export const ModelStatSchema = z.object({
  modelId: ModelIdSchema,
  taskTag: CapabilityTagSchema,
  attempts: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  avgCostUsd: z.number().nonnegative().nullable(),
  avgLatencyMs: z.number().nonnegative().nullable(),
  updatedAt: TimestampSchema,
});
export type ModelStat = z.infer<typeof ModelStatSchema>;
