/**
 * Lifecycle-guarded repositories. Every status write goes through the shared
 * assertTransition guards AND emits the corresponding status_changed event via
 * the bus — no ad-hoc status writes exist anywhere else (CLAUDE.md rule).
 *
 * Rows are parsed through the shared zod schemas on read, so schema drift
 * between drizzle columns and the contract fails loudly at the boundary.
 */
import {
  type Approval,
  ApprovalSchema,
  type ApprovalStatus,
  type CapabilityCard,
  CapabilityCardSchema,
  type CostRecord,
  CostRecordSchema,
  type Model,
  ModelSchema,
  type Project,
  ProjectSchema,
  type Provider,
  ProviderSchema,
  type Skill,
  SkillSchema,
  TASK_TRANSITIONS,
  type Task,
  TaskSchema,
  type TaskSettings,
  TaskSettingsSchema,
  type TaskStatus,
  WORKER_RUN_TRANSITIONS,
  WORK_ITEM_TRANSITIONS,
  type WorkItem,
  WorkItemSchema,
  type WorkItemStatus,
  type WorkerRun,
  WorkerRunSchema,
  type WorkerRunStatus,
  assertApprovalTransition,
  assertTaskTransition,
  assertWorkItemTransition,
  assertWorkerRunTransition,
  isTerminal,
} from "@rewter/shared";
import { and, asc, desc, eq, gte, isNotNull, lt } from "drizzle-orm";
import type { EventBus } from "../events/bus.js";
import type { Db } from "./connection.js";
import {
  approvals,
  capabilityCards,
  costRecords,
  models,
  projects,
  providers,
  skills,
  tasks,
  workItems,
  workerRuns,
} from "./schema.js";

// Terminality is read off the lifecycle maps, never re-listed here: a hand-kept
// copy is one enum member away from disagreeing with `shared` about whether a
// row is finished, and the symptom would be a `finishedAt` that never gets set.

/**
 * One resumable tier-3 session, as `listResumableHarnessSessions` reports it.
 *
 * Server-internal rather than a `shared` contract: this shape feeds the
 * initiator's prompt header and nothing else — it never crosses to the
 * dashboard or the API surface.
 */
export interface ResumableHarnessSession {
  sessionId: string;
  taskId: string;
  /** The interrupted work item's title — what the session was doing. */
  title: string;
  /** When reconciliation closed the run; null if somehow still open. */
  interruptedAt: number | null;
  /** The owning task's workspaceDir; null means its default per-task dir. */
  workspaceDir: string | null;
}

export class Repos {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly clock: () => number = Date.now,
  ) {}

  // ── Providers ────────────────────────────────────────────────────────────
  //
  // Registry rows (providers, models) carry no lifecycle status and emit no
  // events: they are configuration, not task history. Upserts are idempotent so
  // `sync-models` (M4) can re-run without churning ids.

  upsertProvider(provider: Provider): Provider {
    const p = ProviderSchema.parse(provider);
    this.db
      .insert(providers)
      .values(p)
      .onConflictDoUpdate({
        target: providers.id,
        set: {
          name: p.name,
          kind: p.kind,
          baseUrl: p.baseUrl,
          apiKeyRef: p.apiKeyRef,
          enabled: p.enabled,
          updatedAt: p.updatedAt,
        },
      })
      .run();
    return p;
  }

  getProvider(id: string): Provider | undefined {
    const row = this.db.select().from(providers).where(eq(providers.id, id)).get();
    return row === undefined ? undefined : ProviderSchema.parse(row);
  }

  listProviders(opts: { enabledOnly?: boolean } = {}): Provider[] {
    const rows = this.db
      .select()
      .from(providers)
      .orderBy(asc(providers.name))
      .all()
      .map((r) => ProviderSchema.parse(r));
    return opts.enabledOnly === true ? rows.filter((p) => p.enabled) : rows;
  }

  deleteProvider(id: string): void {
    this.db.delete(providers).where(eq(providers.id, id)).run();
  }

  // ── Models ───────────────────────────────────────────────────────────────

  upsertModel(model: Model): Model {
    const m = ModelSchema.parse(model);
    const values = modelToRow(m);
    this.db
      .insert(models)
      .values(values)
      .onConflictDoUpdate({
        target: models.id,
        set: {
          providerId: values.providerId,
          upstreamId: values.upstreamId,
          displayName: values.displayName,
          contextWindow: values.contextWindow,
          maxOutputTokens: values.maxOutputTokens,
          pricingJson: values.pricingJson,
          modalitiesJson: values.modalitiesJson,
          supportsJson: values.supportsJson,
          source: values.source,
          enabled: values.enabled,
          updatedAt: values.updatedAt,
        },
      })
      .run();
    return m;
  }

  getModel(id: string): Model | undefined {
    const row = this.db.select().from(models).where(eq(models.id, id)).get();
    return row === undefined ? undefined : rowToModel(row);
  }

  listModels(opts: { enabledOnly?: boolean; providerId?: string } = {}): Model[] {
    const rows = this.db
      .select()
      .from(models)
      .orderBy(asc(models.id))
      .all()
      .map(rowToModel)
      .filter((m) => opts.providerId === undefined || m.providerId === opts.providerId);
    return opts.enabledOnly === true ? rows.filter((m) => m.enabled) : rows;
  }

  deleteModel(id: string): void {
    this.db.delete(models).where(eq(models.id, id)).run();
  }

  // ── Capability cards ─────────────────────────────────────────────────────
  //
  // Cards are read *merged*: generated content underneath, the user's overrides
  // on top. Writes never touch the other half — `upsertCard` regenerates the
  // generated fields and leaves overrides alone, `setCardOverrides` the reverse.
  // That split is the whole point: a regenerated card must not silently discard
  // a correction the user made by hand.

  upsertCard(card: CapabilityCard): CapabilityCard {
    const c = CapabilityCardSchema.parse(card);
    const values = cardToRow(c);
    this.db
      .insert(capabilityCards)
      .values(values)
      .onConflictDoUpdate({
        target: capabilityCards.modelId,
        set: {
          summary: values.summary,
          strengthsJson: values.strengthsJson,
          weaknessesJson: values.weaknessesJson,
          bestAtJson: values.bestAtJson,
          notes: values.notes,
          generatedBy: values.generatedBy,
          generatedAt: values.generatedAt,
          updatedAt: values.updatedAt,
          // userOverridesJson deliberately absent: a re-sync must not clobber
          // hand corrections. Use setCardOverrides to change them.
        },
      })
      .run();
    return this.getCard(c.modelId) ?? c;
  }

  /** Merged view: generated fields with `userOverrides` applied over them. */
  getCard(modelId: string): CapabilityCard | undefined {
    const raw = this.getRawCard(modelId);
    return raw === undefined ? undefined : mergeCardOverrides(raw);
  }

  /** Unmerged, as stored — for the editor, which must show what it can change. */
  getRawCard(modelId: string): CapabilityCard | undefined {
    const row = this.db
      .select()
      .from(capabilityCards)
      .where(eq(capabilityCards.modelId, modelId))
      .get();
    return row === undefined ? undefined : rowToCard(row);
  }

  listCards(): CapabilityCard[] {
    return this.db
      .select()
      .from(capabilityCards)
      .orderBy(asc(capabilityCards.modelId))
      .all()
      .map((r) => mergeCardOverrides(rowToCard(r)));
  }

  /**
   * Unmerged, as stored — the list counterpart of `getRawCard`.
   *
   * Export uses this rather than `listCards` for the same reason the editor
   * uses `getRawCard`: merging is lossy in the direction that matters. Once
   * `userOverrides` is folded into the generated text there is no way to tell
   * what a person corrected from what a model wrote, and the next regeneration
   * on the far machine discards the correction without a trace.
   */
  listRawCards(): CapabilityCard[] {
    return this.db
      .select()
      .from(capabilityCards)
      .orderBy(asc(capabilityCards.modelId))
      .all()
      .map(rowToCard);
  }

  /** Replace the override patch. `null` clears it, restoring the generated card. */
  setCardOverrides(modelId: string, overrides: Record<string, unknown> | null): CapabilityCard {
    const existing = this.getRawCard(modelId);
    if (existing === undefined) throw new Error(`no capability card for model ${modelId}`);
    this.db
      .update(capabilityCards)
      .set({
        userOverridesJson: overrides === null ? null : JSON.stringify(overrides),
        updatedAt: this.clock(),
      })
      .where(eq(capabilityCards.modelId, modelId))
      .run();
    // Non-null assertion is safe: we just proved the row exists.
    return this.getCard(modelId) as CapabilityCard;
  }

  deleteCard(modelId: string): void {
    this.db.delete(capabilityCards).where(eq(capabilityCards.modelId, modelId)).run();
  }

  // ── Projects ─────────────────────────────────────────────────────────────
  //
  // Configuration like providers/models: no lifecycle, no events. The slug is
  // UNIQUE at the DB layer because it is the selection key (header, model
  // suffix, cwd match) — two projects answering to one name would make
  // selection ambiguous in a way no amount of application code can repair.

  upsertProject(project: Project): Project {
    const p = ProjectSchema.parse(project);
    const values = projectToRow(p);
    this.db
      .insert(projects)
      .values(values)
      .onConflictDoUpdate({
        target: projects.id,
        set: {
          slug: values.slug,
          name: values.name,
          description: values.description,
          resourcesJson: values.resourcesJson,
          policyJson: values.policyJson,
          modelPrefsJson: values.modelPrefsJson,
          archived: values.archived,
          updatedAt: values.updatedAt,
        },
      })
      .run();
    return p;
  }

  getProject(id: string): Project | undefined {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    return row === undefined ? undefined : rowToProject(row);
  }

  /**
   * Selection lookup — header, model suffix, and cwd resolution all land here.
   * Archived projects are refused by selection at the CALLER (routes/engine),
   * not here: the dashboard still needs to load an archived project to show and
   * un-archive it.
   */
  getProjectBySlug(slug: string): Project | undefined {
    const row = this.db.select().from(projects).where(eq(projects.slug, slug)).get();
    return row === undefined ? undefined : rowToProject(row);
  }

  listProjects(opts: { includeArchived?: boolean } = {}): Project[] {
    const rows = this.db
      .select()
      .from(projects)
      .orderBy(asc(projects.slug))
      .all()
      .map(rowToProject);
    return opts.includeArchived === true ? rows : rows.filter((p) => !p.archived);
  }

  deleteProject(id: string): void {
    // Tasks keep their projectId (no FK on purpose) — history stays attributed
    // to an id that no longer resolves, which readers already handle as null-ish.
    this.db.delete(projects).where(eq(projects.id, id)).run();
  }

  // ── Skills index ─────────────────────────────────────────────────────────
  //
  // The SKILL.md files are the source of truth; these rows are a rebuildable
  // cache of their frontmatter (phase-2 M4). Hence no upsert/patch surface —
  // the only write is wholesale replacement from a fresh tree scan, inside one
  // transaction so no reader ever sees a half-rebuilt index.

  replaceSkillsIndex(all: Skill[]): void {
    const parsed = all.map((s) => SkillSchema.parse(s));
    this.db.transaction((tx) => {
      tx.delete(skills).run();
      for (const s of parsed) {
        tx.insert(skills).values(s).run();
      }
    });
  }

  listSkills(): Skill[] {
    return this.db
      .select()
      .from(skills)
      .orderBy(asc(skills.slug), asc(skills.path))
      .all()
      .map((r) => SkillSchema.parse(r));
  }

  // ── Tasks ────────────────────────────────────────────────────────────────

  createTask(task: Task): Task {
    const t = TaskSchema.parse(task);
    this.db
      .insert(tasks)
      .values({
        id: t.id,
        status: t.status,
        title: t.title,
        initiatorModelId: t.initiatorModelId,
        projectId: t.projectId,
        conversationFingerprint: t.conversationFingerprint,
        settingsJson: JSON.stringify(t.settings),
        resultSummary: t.resultSummary,
        error: t.error,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        finishedAt: t.finishedAt,
      })
      .run();
    this.bus.append({ taskId: t.id, payload: { type: "task.created", task: t } });
    return t;
  }

  getTask(id: string): Task | undefined {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    return row === undefined ? undefined : rowToTask(row);
  }

  /**
   * Tasks in a non-terminal state, oldest first.
   *
   * Exists for boot reconciliation, which needs exactly this set and nothing
   * else: after an unclean shutdown these are the rows whose in-memory half died
   * with the process. Filtered in TypeScript against the lifecycle map rather
   * than by a hard-coded `status NOT IN (...)`, so adding a terminal state to
   * `shared` cannot leave a stale list here saying otherwise.
   */
  listUnfinishedTasks(): Task[] {
    return this.db
      .select()
      .from(tasks)
      .orderBy(asc(tasks.createdAt))
      .all()
      .map(rowToTask)
      .filter((t) => !isTerminal(TASK_TRANSITIONS, t.status));
  }

  /**
   * Change a task's settings after creation.
   *
   * Takes a partial and merges it over what is stored, so a caller that only
   * knows about the spending cap cannot silently reset auto-approve to the
   * schema default. Re-parsed through `TaskSettingsSchema` on the way in, since
   * the merged object is the thing the engine will read.
   *
   * No lifecycle guard, because settings are not a state machine — but a
   * terminal task is refused by the caller, not here: writing a cap onto a
   * finished task is a write nothing will ever read.
   */
  updateTaskSettings(id: string, patch: Partial<TaskSettings>): Task {
    const current = this.getTask(id);
    if (current === undefined) throw new Error(`task not found: ${id}`);
    const settings = TaskSettingsSchema.parse({ ...current.settings, ...patch });
    const now = this.clock();
    this.db
      .update(tasks)
      .set({ settingsJson: JSON.stringify(settings), updatedAt: now })
      .where(eq(tasks.id, id))
      .run();
    this.bus.append({
      taskId: current.id,
      payload: {
        type: "task.settings_changed",
        taskId: current.id,
        from: current.settings,
        to: settings,
      },
    });
    return this.getTask(id) as Task;
  }

  transitionTask(
    id: string,
    to: TaskStatus,
    patch?: Partial<Pick<Task, "resultSummary" | "error">>,
  ): Task {
    const current = this.getTask(id);
    if (current === undefined) throw new Error(`task not found: ${id}`);
    assertTaskTransition(current.status, to);
    const now = this.clock();
    const finishedAt = isTerminal(TASK_TRANSITIONS, to) ? now : current.finishedAt;
    this.db
      .update(tasks)
      .set({
        status: to,
        updatedAt: now,
        finishedAt,
        ...(patch?.resultSummary !== undefined && { resultSummary: patch.resultSummary }),
        ...(patch?.error !== undefined && { error: patch.error }),
      })
      .where(eq(tasks.id, id))
      .run();
    this.bus.append({
      taskId: current.id,
      payload: { type: "task.status_changed", taskId: current.id, from: current.status, to },
    });
    return this.getTask(id) as Task;
  }

  // ── WorkItems ────────────────────────────────────────────────────────────

  createWorkItem(item: WorkItem): WorkItem {
    const wi = WorkItemSchema.parse(item);
    this.db.insert(workItems).values(wi).run();
    this.bus.append({ taskId: wi.taskId, payload: { type: "work_item.created", workItem: wi } });
    return wi;
  }

  getWorkItem(id: string): WorkItem | undefined {
    const row = this.db.select().from(workItems).where(eq(workItems.id, id)).get();
    return row === undefined ? undefined : WorkItemSchema.parse(row);
  }

  listWorkItems(taskId: string): WorkItem[] {
    return this.db
      .select()
      .from(workItems)
      .where(eq(workItems.taskId, taskId))
      .all()
      .map((r) => WorkItemSchema.parse(r));
  }

  transitionWorkItem(
    id: string,
    to: WorkItemStatus,
    patch?: Partial<Pick<WorkItem, "resultSummary" | "error">>,
  ): WorkItem {
    const current = this.getWorkItem(id);
    if (current === undefined) throw new Error(`work item not found: ${id}`);
    assertWorkItemTransition(current.status, to);
    const now = this.clock();
    this.db
      .update(workItems)
      .set({
        status: to,
        updatedAt: now,
        finishedAt: isTerminal(WORK_ITEM_TRANSITIONS, to) ? now : current.finishedAt,
        ...(patch?.resultSummary !== undefined && { resultSummary: patch.resultSummary }),
        ...(patch?.error !== undefined && { error: patch.error }),
      })
      .where(eq(workItems.id, id))
      .run();
    this.bus.append({
      taskId: current.taskId,
      payload: {
        type: "work_item.status_changed",
        workItemId: current.id,
        from: current.status,
        to,
      },
    });
    return this.getWorkItem(id) as WorkItem;
  }

  // ── WorkerRuns ───────────────────────────────────────────────────────────

  createWorkerRun(run: WorkerRun): WorkerRun {
    const r = WorkerRunSchema.parse(run);
    this.db.insert(workerRuns).values(r).run();
    this.bus.append({ taskId: r.taskId, payload: { type: "worker_run.created", workerRun: r } });
    return r;
  }

  getWorkerRun(id: string): WorkerRun | undefined {
    const row = this.db.select().from(workerRuns).where(eq(workerRuns.id, id)).get();
    return row === undefined ? undefined : WorkerRunSchema.parse(row);
  }

  /** Every attempt at one work item, oldest first — attempt 1, then the retries. */
  listWorkerRuns(workItemId: string): WorkerRun[] {
    return this.db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.workItemId, workItemId))
      .orderBy(asc(workerRuns.attempt))
      .all()
      .map((r) => WorkerRunSchema.parse(r));
  }

  transitionWorkerRun(
    id: string,
    to: WorkerRunStatus,
    patch?: Partial<Pick<WorkerRun, "resultText" | "error" | "harnessSessionId">>,
  ): WorkerRun {
    const current = this.getWorkerRun(id);
    if (current === undefined) throw new Error(`worker run not found: ${id}`);
    assertWorkerRunTransition(current.status, to);
    const now = this.clock();
    this.db
      .update(workerRuns)
      .set({
        status: to,
        updatedAt: now,
        finishedAt: isTerminal(WORKER_RUN_TRANSITIONS, to) ? now : current.finishedAt,
        ...(patch?.resultText !== undefined && { resultText: patch.resultText }),
        ...(patch?.error !== undefined && { error: patch.error }),
        ...(patch?.harnessSessionId !== undefined && { harnessSessionId: patch.harnessSessionId }),
      })
      .where(eq(workerRuns.id, id))
      .run();
    this.bus.append({
      taskId: current.taskId,
      payload: {
        type: "worker_run.status_changed",
        workerRunId: current.id,
        from: current.status,
        to,
      },
    });
    return this.getWorkerRun(id) as WorkerRun;
  }

  /**
   * Attach a harness's resumable session handle to its run.
   *
   * Not a transition — the run is already `streaming` when the harness
   * announces itself, and `streaming → streaming` is rightly not an edge the
   * lifecycle allows. This is bookkeeping for the next slice's boot
   * reconciliation (re-adopting a session that survived a daemon restart), so
   * it also emits no event: nothing user-visible changed.
   */
  setHarnessSessionId(id: string, harnessSessionId: string): WorkerRun {
    const current = this.getWorkerRun(id);
    if (current === undefined) throw new Error(`worker run not found: ${id}`);
    this.db
      .update(workerRuns)
      .set({ harnessSessionId, updatedAt: this.clock() })
      .where(eq(workerRuns.id, id))
      .run();
    return this.getWorkerRun(id) as WorkerRun;
  }

  /**
   * Harness sessions a daemon restart cut short: interrupted tier-3 runs that
   * had announced a `harnessSessionId` before the process died.
   *
   * These are the sessions `claude --resume` can reload — the conversation
   * lives in the harness's own storage on disk, which is exactly the part of a
   * run that does not die with the daemon. Only `interrupted` qualifies: a
   * `failed` run's session is a conversation that ended in an error the
   * harness already reported, and a `cancelled` one was stopped on purpose.
   *
   * Each row carries what an initiator needs to write a good "continue"
   * instruction (the work item's title and instructions preview) and what the
   * engine needs to say where the session worked (the owning task's
   * `workspaceDir`, null when the task used its default per-taskId workspace).
   * Most recent first, bounded — the header block this feeds is prompt space.
   */
  listResumableHarnessSessions(limit = 5): ResumableHarnessSession[] {
    const rows = this.db
      .select({
        sessionId: workerRuns.harnessSessionId,
        taskId: workerRuns.taskId,
        title: workItems.title,
        interruptedAt: workerRuns.finishedAt,
        settingsJson: tasks.settingsJson,
      })
      .from(workerRuns)
      .innerJoin(workItems, eq(workerRuns.workItemId, workItems.id))
      .innerJoin(tasks, eq(workerRuns.taskId, tasks.id))
      .where(and(eq(workerRuns.status, "interrupted"), isNotNull(workerRuns.harnessSessionId)))
      .orderBy(desc(workerRuns.updatedAt))
      .limit(limit)
      .all();
    return rows.map((r) => ({
      // isNotNull in the WHERE guarantees this; the assertion is for the types.
      sessionId: r.sessionId as string,
      taskId: r.taskId,
      title: r.title,
      interruptedAt: r.interruptedAt,
      workspaceDir: TaskSettingsSchema.parse(JSON.parse(r.settingsJson)).workspaceDir,
    }));
  }

  // ── Approvals ────────────────────────────────────────────────────────────

  createApproval(approval: Approval): Approval {
    const a = ApprovalSchema.parse(approval);
    this.db
      .insert(approvals)
      .values({
        ...a,
        detailJson: a.detail === null ? null : JSON.stringify(a.detail),
      })
      .run();
    this.bus.append({ taskId: a.taskId, payload: { type: "approval.requested", approval: a } });
    return a;
  }

  getApproval(id: string): Approval | undefined {
    const row = this.db.select().from(approvals).where(eq(approvals.id, id)).get();
    return row === undefined ? undefined : rowToApproval(row);
  }

  listPendingApprovals(taskId?: string): Approval[] {
    const where =
      taskId === undefined ? eq(approvals.status, "pending") : eq(approvals.taskId, taskId);
    return this.db
      .select()
      .from(approvals)
      .where(where)
      .all()
      .map(rowToApproval)
      .filter((a) => a.status === "pending");
  }

  resolveApproval(
    id: string,
    to: ApprovalStatus,
    resolvedBy: NonNullable<Approval["resolvedBy"]>,
    note: string | null = null,
  ): Approval {
    const current = this.getApproval(id);
    if (current === undefined) throw new Error(`approval not found: ${id}`);
    assertApprovalTransition(current.status, to);
    this.db
      .update(approvals)
      .set({ status: to, resolvedBy, resolutionNote: note, resolvedAt: this.clock() })
      .where(eq(approvals.id, id))
      .run();
    this.bus.append({
      taskId: current.taskId,
      payload: { type: "approval.resolved", approvalId: current.id, status: to, resolvedBy, note },
    });
    return this.getApproval(id) as Approval;
  }

  // ── Costs ────────────────────────────────────────────────────────────────

  recordCost(cost: CostRecord): CostRecord {
    const c = CostRecordSchema.parse(cost);
    this.db
      .insert(costRecords)
      .values({ ...c, pricingSnapshotJson: JSON.stringify(c.pricingSnapshot) })
      .run();
    this.bus.append({ taskId: c.taskId, payload: { type: "cost.recorded", cost: c } });
    return c;
  }

  listCosts(taskId: string): CostRecord[] {
    return this.db
      .select()
      .from(costRecords)
      .where(eq(costRecords.taskId, taskId))
      .orderBy(desc(costRecords.createdAt))
      .all()
      .map(toCostRecord);
  }

  /**
   * Every cost row in a time window, oldest first.
   *
   * The aggregation itself lives in `summarizeCosts` in `shared`, not in SQL:
   * the dashboard receives `cost.recorded` over the socket and can bucket what
   * it already has, so keeping one implementation means the page and the
   * endpoint cannot disagree. This is the row supply for it. The window is
   * half-open (`since <= t < until`) to match.
   */
  allCosts(window: { since?: number | null; until?: number | null } = {}): CostRecord[] {
    const clauses = [];
    if (window.since !== undefined && window.since !== null) {
      clauses.push(gte(costRecords.createdAt, window.since));
    }
    if (window.until !== undefined && window.until !== null) {
      clauses.push(lt(costRecords.createdAt, window.until));
    }
    const query = this.db.select().from(costRecords);
    const filtered = clauses.length === 0 ? query : query.where(and(...clauses));
    return filtered.orderBy(asc(costRecords.createdAt)).all().map(toCostRecord);
  }
}

function toCostRecord(r: typeof costRecords.$inferSelect): CostRecord {
  return CostRecordSchema.parse({ ...r, pricingSnapshot: JSON.parse(r.pricingSnapshotJson) });
}

function modelToRow(m: Model): typeof models.$inferInsert {
  return {
    id: m.id,
    providerId: m.providerId,
    upstreamId: m.upstreamId,
    displayName: m.displayName,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    pricingJson: JSON.stringify(m.pricing),
    modalitiesJson: JSON.stringify(m.modalities),
    supportsJson: JSON.stringify(m.supports),
    source: m.source,
    enabled: m.enabled,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

function rowToModel(row: typeof models.$inferSelect): Model {
  return ModelSchema.parse({
    ...row,
    pricing: JSON.parse(row.pricingJson),
    modalities: JSON.parse(row.modalitiesJson),
    supports: JSON.parse(row.supportsJson),
  });
}

function cardToRow(c: CapabilityCard): typeof capabilityCards.$inferInsert {
  return {
    modelId: c.modelId,
    summary: c.summary,
    strengthsJson: JSON.stringify(c.strengths),
    weaknessesJson: JSON.stringify(c.weaknesses),
    bestAtJson: JSON.stringify(c.bestAt),
    notes: c.notes,
    userOverridesJson: c.userOverrides === null ? null : JSON.stringify(c.userOverrides),
    generatedBy: c.generatedBy,
    generatedAt: c.generatedAt,
    updatedAt: c.updatedAt,
  };
}

function rowToCard(row: typeof capabilityCards.$inferSelect): CapabilityCard {
  return CapabilityCardSchema.parse({
    ...row,
    strengths: JSON.parse(row.strengthsJson),
    weaknesses: JSON.parse(row.weaknessesJson),
    bestAt: JSON.parse(row.bestAtJson),
    userOverrides: row.userOverridesJson === null ? null : JSON.parse(row.userOverridesJson),
  });
}

/**
 * Apply the user's patch over the generated card — a shallow field-level merge,
 * not a deep one. `strengths: [...]` *replaces* the generated list rather than
 * appending, because the common correction is "this list is wrong", and there
 * would be no way to express a deletion under an append.
 *
 * Identity fields (`modelId`, `generatedBy`, `generatedAt`, `userOverrides`) are
 * not overridable: they describe the card's provenance, and letting a patch
 * rewrite them would make the record lie about where it came from. An override
 * that fails to parse is discarded, and the generated card is returned intact —
 * a bad hand-edit must not take a model out of the registry.
 */
export function mergeCardOverrides(card: CapabilityCard): CapabilityCard {
  if (card.userOverrides === null) return card;
  const { modelId, generatedBy, generatedAt, userOverrides, ...patchable } =
    card.userOverrides as Record<string, unknown>;
  const merged = CapabilityCardSchema.safeParse({ ...card, ...patchable });
  return merged.success ? merged.data : card;
}

function rowToTask(row: typeof tasks.$inferSelect): Task {
  return TaskSchema.parse({ ...row, settings: JSON.parse(row.settingsJson) });
}

function projectToRow(p: Project): typeof projects.$inferInsert {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    resourcesJson: JSON.stringify(p.resources),
    policyJson: JSON.stringify(p.policy),
    modelPrefsJson: JSON.stringify(p.modelPrefs),
    archived: p.archived,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function rowToProject(row: typeof projects.$inferSelect): Project {
  return ProjectSchema.parse({
    ...row,
    resources: JSON.parse(row.resourcesJson),
    policy: JSON.parse(row.policyJson),
    modelPrefs: JSON.parse(row.modelPrefsJson),
  });
}

function rowToApproval(row: typeof approvals.$inferSelect): Approval {
  return ApprovalSchema.parse({
    ...row,
    detail: row.detailJson === null ? null : JSON.parse(row.detailJson),
  });
}
