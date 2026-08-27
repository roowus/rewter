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
  type CostRecord,
  CostRecordSchema,
  type Task,
  TaskSchema,
  type TaskStatus,
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
} from "@rewter/shared";
import { desc, eq } from "drizzle-orm";
import type { EventBus } from "../events/bus.js";
import type { Db } from "./connection.js";
import { approvals, costRecords, tasks, workItems, workerRuns } from "./schema.js";

const TERMINAL_TASK: readonly TaskStatus[] = ["succeeded", "failed", "cancelled"];

export class Repos {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly clock: () => number = Date.now,
  ) {}

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

  transitionTask(
    id: string,
    to: TaskStatus,
    patch?: Partial<Pick<Task, "resultSummary" | "error">>,
  ): Task {
    const current = this.getTask(id);
    if (current === undefined) throw new Error(`task not found: ${id}`);
    assertTaskTransition(current.status, to);
    const now = this.clock();
    const finishedAt = TERMINAL_TASK.includes(to) ? now : current.finishedAt;
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
    const terminal: readonly WorkItemStatus[] = ["succeeded", "failed", "cancelled", "handed_off"];
    this.db
      .update(workItems)
      .set({
        status: to,
        updatedAt: now,
        finishedAt: terminal.includes(to) ? now : current.finishedAt,
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

  transitionWorkerRun(
    id: string,
    to: WorkerRunStatus,
    patch?: Partial<Pick<WorkerRun, "resultText" | "error" | "harnessSessionId">>,
  ): WorkerRun {
    const current = this.getWorkerRun(id);
    if (current === undefined) throw new Error(`worker run not found: ${id}`);
    assertWorkerRunTransition(current.status, to);
    const now = this.clock();
    const terminal: readonly WorkerRunStatus[] = ["succeeded", "failed", "cancelled"];
    this.db
      .update(workerRuns)
      .set({
        status: to,
        updatedAt: now,
        finishedAt: terminal.includes(to) ? now : current.finishedAt,
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
      .map((r) =>
        CostRecordSchema.parse({ ...r, pricingSnapshot: JSON.parse(r.pricingSnapshotJson) }),
      );
  }
}

function rowToTask(row: typeof tasks.$inferSelect): Task {
  return TaskSchema.parse({ ...row, settings: JSON.parse(row.settingsJson) });
}

function rowToApproval(row: typeof approvals.$inferSelect): Approval {
  return ApprovalSchema.parse({
    ...row,
    detail: row.detailJson === null ? null : JSON.parse(row.detailJson),
  });
}
