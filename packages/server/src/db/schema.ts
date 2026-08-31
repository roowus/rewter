/**
 * Drizzle schema. Column shapes mirror the zod entities in @rewter/shared —
 * repos parse every row through those schemas on read, so drift fails loudly.
 * JSON-ish fields (settings, pricing, payloads) are TEXT with JSON.parse in the repo.
 */
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  baseUrl: text("base_url"),
  // Env var NAME only — raw keys never enter the DB.
  apiKeyRef: text("api_key_ref"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const models = sqliteTable("models", {
  id: text("id").primaryKey(),
  providerId: text("provider_id")
    .notNull()
    .references(() => providers.id),
  upstreamId: text("upstream_id").notNull(),
  displayName: text("display_name").notNull(),
  contextWindow: integer("context_window"),
  maxOutputTokens: integer("max_output_tokens"),
  pricingJson: text("pricing_json").notNull(),
  modalitiesJson: text("modalities_json").notNull(),
  supportsJson: text("supports_json").notNull(),
  source: text("source").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const capabilityCards = sqliteTable("capability_cards", {
  modelId: text("model_id")
    .primaryKey()
    .references(() => models.id),
  summary: text("summary").notNull(),
  strengthsJson: text("strengths_json").notNull(),
  weaknessesJson: text("weaknesses_json").notNull(),
  bestAtJson: text("best_at_json").notNull(),
  notes: text("notes"),
  userOverridesJson: text("user_overrides_json"),
  generatedBy: text("generated_by"),
  generatedAt: integer("generated_at"),
  updatedAt: integer("updated_at").notNull(),
});

// Phase-2 projects. Like providers/models these are configuration, not task
// history: no lifecycle status, no events. `archived` hides a project from
// selection without orphaning the tasks that reference it.
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    resourcesJson: text("resources_json").notNull(),
    policyJson: text("policy_json").notNull(),
    modelPrefsJson: text("model_prefs_json").notNull(),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_projects_slug").on(t.slug)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull(),
    title: text("title").notNull(),
    initiatorModelId: text("initiator_model_id").notNull(),
    // Nullable on purpose: a project-less task is the phase-1 behaviour.
    // No FK — a deleted project must not orphan-block its historical tasks.
    projectId: text("project_id"),
    conversationFingerprint: text("conversation_fingerprint"),
    settingsJson: text("settings_json").notNull(),
    resultSummary: text("result_summary"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("idx_tasks_status").on(t.status),
    index("idx_tasks_fingerprint").on(t.conversationFingerprint),
  ],
);

export const workItems = sqliteTable(
  "work_items",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    parentWorkItemId: text("parent_work_item_id"),
    status: text("status").notNull(),
    title: text("title").notNull(),
    instructions: text("instructions").notNull(),
    modelId: text("model_id").notNull(),
    tier: integer("tier").notNull(),
    resultSummary: text("result_summary"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("idx_work_items_task").on(t.taskId)],
);

export const workerRuns = sqliteTable(
  "worker_runs",
  {
    id: text("id").primaryKey(),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => workItems.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    status: text("status").notNull(),
    modelId: text("model_id").notNull(),
    tier: integer("tier").notNull(),
    attempt: integer("attempt").notNull(),
    // Phase-2: tmux session id for tier-3 boot reconciliation.
    harnessSessionId: text("harness_session_id"),
    resultText: text("result_text"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("idx_worker_runs_work_item").on(t.workItemId),
    index("idx_worker_runs_task").on(t.taskId),
  ],
);

export const events = sqliteTable(
  "events",
  {
    // AUTOINCREMENT guarantees monotonic, never-reused seq — the replay cursor.
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    taskId: text("task_id"),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
  },
  (t) => [index("idx_events_task").on(t.taskId), index("idx_events_type").on(t.type)],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    workItemId: text("work_item_id"),
    workerRunId: text("worker_run_id"),
    status: text("status").notNull(),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    detailJson: text("detail_json"),
    resolvedBy: text("resolved_by"),
    resolutionNote: text("resolution_note"),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [index("idx_approvals_task").on(t.taskId), index("idx_approvals_status").on(t.status)],
);

export const costRecords = sqliteTable(
  "cost_records",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id"),
    workerRunId: text("worker_run_id"),
    modelId: text("model_id").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull(),
    pricingSnapshotJson: text("pricing_snapshot_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_cost_records_task").on(t.taskId)],
);

// Phase-2 learned stats — schema present from day one per the plan.
export const modelStats = sqliteTable(
  "model_stats",
  {
    modelId: text("model_id").notNull(),
    taskTag: text("task_tag").notNull(),
    attempts: integer("attempts").notNull().default(0),
    successes: integer("successes").notNull().default(0),
    avgCostUsd: real("avg_cost_usd"),
    avgLatencyMs: real("avg_latency_ms"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.modelId, t.taskTag] })],
);
