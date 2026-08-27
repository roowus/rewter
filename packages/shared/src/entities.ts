/**
 * Domain entities. These schemas are the cross-boundary contract: the server's
 * repos parse rows through them on read, and the dashboard consumes the same types.
 */
import { z } from "zod";
import {
  ApprovalIdSchema,
  CostRecordIdSchema,
  ModelIdSchema,
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
  supports: z.object({
    tools: z.boolean(),
    streaming: z.boolean(),
    vision: z.boolean(),
    caching: z.boolean(),
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
  resultSummary: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

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

export const ApprovalKindSchema = z.enum(["shell", "write_outside_workspace", "budget", "other"]);
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

/** Phase-2 learned stats — schema lives here from day one so the digest renderer has a seam. */
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
