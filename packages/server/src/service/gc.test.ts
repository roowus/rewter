import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelIdSchema,
  type TaskId,
  TaskSettingsSchema,
  type TaskStatus,
  newApprovalId,
  newCostRecordId,
  newFailureRecordId,
  newProviderId,
  newTaskId,
  newWorkItemId,
  newWorkerRunId,
} from "@rewter/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { DEFAULT_RETENTION_DAYS, collectGarbage, formatGcResult, vacuum } from "./gc.js";

const mdl = ModelIdSchema.parse("anthropic/claude-sonnet-5");
const prv = newProviderId();
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

let db: Db;
let repos: Repos;
let tick: number;
let dir: string;

beforeEach(() => {
  db = openDb(":memory:");
  tick = NOW - 400 * DAY;
  const clock = () => ++tick;
  repos = new Repos(db, new EventBus(db, clock), clock);
  dir = mkdtempSync(join(tmpdir(), "rewter-gc-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A task with one work item, one run, one approval and one cost record, driven
 * to `status` and stamped as having finished `daysAgo` days ago.
 *
 * The timestamps are written directly rather than by advancing the clock: gc
 * reads `finishedAt`, and a test that has to simulate 90 days of wall time to
 * exercise a 30-day cutoff is a test nobody runs.
 */
function makeTask(opts: { status: TaskStatus; daysAgo: number }): TaskId {
  const task = repos.createTask({
    id: newTaskId(),
    status: "pending",
    title: `task ${opts.status}`,
    initiatorModelId: mdl,
    projectId: null,
    conversationFingerprint: null,
    settings: TaskSettingsSchema.parse({}),
    resultSummary: null,
    error: null,
    createdAt: tick,
    updatedAt: tick,
    finishedAt: null,
  });

  const item = repos.createWorkItem({
    id: newWorkItemId(),
    taskId: task.id,
    parentWorkItemId: null,
    status: "pending",
    title: "subtask",
    instructions: "do the thing",
    modelId: mdl,
    tier: 2,
    resultSummary: null,
    error: null,
    createdAt: tick,
    updatedAt: tick,
    finishedAt: null,
  });

  repos.createWorkerRun({
    id: newWorkerRunId(),
    workItemId: item.id,
    taskId: task.id,
    status: "created",
    modelId: mdl,
    tier: 2,
    attempt: 1,
    harnessSessionId: null,
    resultText: null,
    error: null,
    createdAt: tick,
    updatedAt: tick,
    finishedAt: null,
  });

  repos.createApproval({
    id: newApprovalId(),
    taskId: task.id,
    workItemId: item.id,
    workerRunId: null,
    status: "pending",
    kind: "shell",
    summary: "rm -rf /",
    detail: null,
    resolvedBy: null,
    resolutionNote: null,
    createdAt: tick,
    resolvedAt: null,
  });

  repos.recordCost({
    id: newCostRecordId(),
    taskId: task.id,
    workerRunId: null,
    modelId: mdl,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.42,
    pricingSnapshot: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    },
    createdAt: tick,
  });

  repos.recordFailure({
    id: newFailureRecordId(),
    taskId: task.id,
    workerRunId: null,
    modelId: mdl,
    providerId: prv,
    attempt: 1,
    phase: "before_output",
    retried: true,
    retryable: true,
    statusCode: 503,
    message: "overloaded",
    createdAt: tick,
  });

  if (opts.status !== "pending") {
    repos.transitionTask(task.id, "running");
    if (opts.status !== "running") repos.transitionTask(task.id, opts.status);
  }

  // Stamp the age directly — see the note above.
  const at = NOW - opts.daysAgo * DAY;
  const finished = ["succeeded", "failed", "cancelled", "interrupted"].includes(opts.status);
  db.$client
    .prepare("UPDATE tasks SET updated_at = ?, finished_at = ? WHERE id = ?")
    .run(at, finished ? at : null, String(task.id));

  return task.id;
}

/** Counts straight out of SQLite, so the assertions do not trust gc's own report. */
function rows(table: string, taskId: string): number {
  const r = db.$client
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id = ?`)
    .get(taskId) as { n: number };
  return r.n;
}

describe("collectGarbage", () => {
  it("collects a finished task and everything hanging off it", () => {
    const id = makeTask({ status: "succeeded", daysAgo: 90 });

    const result = collectGarbage(db, { now: NOW });

    expect(result.taskIds).toEqual([String(id)]);
    expect(result.deleted.tasks).toBe(1);
    expect(result.deleted.workItems).toBe(1);
    expect(result.deleted.workerRuns).toBe(1);
    expect(result.deleted.approvals).toBe(1);
    expect(result.deleted.events).toBeGreaterThan(0);

    expect(repos.getTask(String(id))).toBeUndefined();
    expect(rows("work_items", String(id))).toBe(0);
    expect(rows("worker_runs", String(id))).toBe(0);
    expect(rows("approvals", String(id))).toBe(0);
    expect(rows("events", String(id))).toBe(0);
  });

  it("keeps cost records — spend history outlives the transcript", () => {
    // The whole reason cost_records has a nullable taskId and no foreign key:
    // "what did I spend in March" must survive collecting March.
    const id = makeTask({ status: "succeeded", daysAgo: 90 });
    collectGarbage(db, { now: NOW });

    expect(rows("cost_records", String(id))).toBe(1);
    expect(repos.listCosts(String(id))).toHaveLength(1);
  });

  it("keeps failure records — reliability history is about the model, not the task", () => {
    // Same reasoning as cost records: a retried 503 is evidence about the
    // upstream, and issue #9's question outlives any one transcript.
    const id = makeTask({ status: "succeeded", daysAgo: 90 });
    collectGarbage(db, { now: NOW });

    expect(rows("failure_records", String(id))).toBe(1);
    expect(repos.allFailures({})).toHaveLength(1);
  });

  it("leaves a task that has not finished, however old", () => {
    // Either genuinely in flight, or the next boot's reconciliation will close
    // it out. Neither wants its history deleted from under it.
    const id = makeTask({ status: "running", daysAgo: 400 });

    const result = collectGarbage(db, { now: NOW });

    expect(result.taskIds).toEqual([]);
    expect(result.unfinishedSkipped).toBe(1);
    expect(repos.getTask(String(id))).toBeDefined();
  });

  it("counts pending and waiting_approval as unfinished too", () => {
    makeTask({ status: "pending", daysAgo: 400 });
    makeTask({ status: "running", daysAgo: 400 });

    expect(collectGarbage(db, { now: NOW }).unfinishedSkipped).toBe(2);
  });

  it("leaves a finished task inside the retention window", () => {
    const id = makeTask({ status: "succeeded", daysAgo: 5 });

    expect(collectGarbage(db, { now: NOW }).taskIds).toEqual([]);
    expect(repos.getTask(String(id))).toBeDefined();
  });

  it("measures age from finishedAt, not createdAt", () => {
    // A task created a year ago that only finished yesterday is a task that ran
    // for a year — collecting it would delete a transcript still being read.
    const task = repos.createTask({
      id: newTaskId(),
      status: "pending",
      title: "the long one",
      initiatorModelId: mdl,
      projectId: null,
      conversationFingerprint: null,
      settings: TaskSettingsSchema.parse({}),
      resultSummary: null,
      error: null,
      createdAt: NOW - 365 * DAY,
      updatedAt: NOW - 365 * DAY,
      finishedAt: null,
    });
    repos.transitionTask(task.id, "running");
    repos.transitionTask(task.id, "succeeded");
    db.$client
      .prepare("UPDATE tasks SET created_at = ?, updated_at = ?, finished_at = ? WHERE id = ?")
      .run(NOW - 365 * DAY, NOW - DAY, NOW - DAY, String(task.id));

    expect(collectGarbage(db, { now: NOW }).taskIds).toEqual([]);
  });

  it("collects every terminal status, not just succeeded", () => {
    makeTask({ status: "succeeded", daysAgo: 90 });
    makeTask({ status: "failed", daysAgo: 90 });
    makeTask({ status: "cancelled", daysAgo: 90 });
    makeTask({ status: "interrupted", daysAgo: 90 });

    expect(collectGarbage(db, { now: NOW }).deleted.tasks).toBe(4);
  });

  it("falls back to updatedAt when a terminal task has no finishedAt", () => {
    const id = makeTask({ status: "failed", daysAgo: 90 });
    db.$client.prepare("UPDATE tasks SET finished_at = NULL WHERE id = ?").run(String(id));

    // Without the fallback these rows would never be collectable at all.
    expect(collectGarbage(db, { now: NOW }).taskIds).toEqual([String(id)]);
  });

  it("honours olderThanDays", () => {
    makeTask({ status: "succeeded", daysAgo: 10 });

    expect(collectGarbage(db, { now: NOW, olderThanDays: 30 }).taskIds).toEqual([]);
    expect(collectGarbage(db, { now: NOW, olderThanDays: 7 }).taskIds).toHaveLength(1);
  });

  it("reports the cutoff it used", () => {
    const result = collectGarbage(db, { now: NOW, olderThanDays: 10 });
    expect(result.cutoff).toBe(NOW - 10 * DAY);
  });

  it("defaults to a 30-day window", () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
    makeTask({ status: "succeeded", daysAgo: 31 });
    makeTask({ status: "succeeded", daysAgo: 29 });

    expect(collectGarbage(db, { now: NOW }).deleted.tasks).toBe(1);
  });

  it("is a no-op on an empty database", () => {
    const result = collectGarbage(db, { now: NOW });
    expect(result.taskIds).toEqual([]);
    expect(result.deleted).toEqual({
      tasks: 0,
      workItems: 0,
      workerRuns: 0,
      approvals: 0,
      events: 0,
      workspaces: 0,
    });
  });
});

describe("collectGarbage dry run", () => {
  it("reports the same numbers the real run produces, and deletes nothing", () => {
    // A dry run whose output does not match the real run is worse than none.
    const id = makeTask({ status: "succeeded", daysAgo: 90 });

    const dry = collectGarbage(db, { now: NOW, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(repos.getTask(String(id))).toBeDefined();

    const real = collectGarbage(db, { now: NOW });
    expect(real.deleted).toEqual({ ...dry.deleted });
    expect(real.taskIds).toEqual(dry.taskIds);
  });

  it("leaves the workspace directory alone", () => {
    const id = makeTask({ status: "succeeded", daysAgo: 90 });
    const ws = join(dir, String(id));
    mkdirSync(ws, { recursive: true });

    collectGarbage(db, { now: NOW, dryRun: true, workspacesDir: dir });

    expect(existsSync(ws)).toBe(true);
  });
});

describe("collectGarbage workspaces", () => {
  it("removes the collected task's workspace directory", () => {
    const id = makeTask({ status: "succeeded", daysAgo: 90 });
    const ws = join(dir, String(id));
    mkdirSync(join(ws, "nested"), { recursive: true });
    writeFileSync(join(ws, "nested", "checkout.txt"), "a repo a worker cloned");

    const result = collectGarbage(db, { now: NOW, workspacesDir: dir });

    expect(result.deleted.workspaces).toBe(1);
    expect(existsSync(ws)).toBe(false);
  });

  it("does not touch a workspace whose task survives", () => {
    const kept = makeTask({ status: "running", daysAgo: 400 });
    mkdirSync(join(dir, String(kept)), { recursive: true });

    collectGarbage(db, { now: NOW, workspacesDir: dir });

    expect(existsSync(join(dir, String(kept)))).toBe(true);
  });

  it("tolerates a task whose workspace was never created", () => {
    // Tier-1-only tasks never call openWorkspace, so most tasks have no directory.
    makeTask({ status: "succeeded", daysAgo: 90 });
    expect(() => collectGarbage(db, { now: NOW, workspacesDir: dir })).not.toThrow();
  });

  it("leaves directories alone entirely when no workspacesDir is given", () => {
    const id = makeTask({ status: "succeeded", daysAgo: 90 });
    const ws = join(dir, String(id));
    mkdirSync(ws, { recursive: true });

    const result = collectGarbage(db, { now: NOW });

    expect(result.deleted.workspaces).toBe(0);
    expect(existsSync(ws)).toBe(true);
  });
});

describe("vacuum", () => {
  it("runs and leaves the database usable", () => {
    makeTask({ status: "succeeded", daysAgo: 90 });
    collectGarbage(db, { now: NOW });

    expect(() => vacuum(db)).not.toThrow();
    expect(repos.listPendingApprovals()).toEqual([]);
  });
});

describe("formatGcResult", () => {
  it("says nothing was there to collect", () => {
    const text = formatGcResult(collectGarbage(db, { now: NOW }));
    expect(text).toContain("nothing to collect");
  });

  it("mentions kept unfinished tasks even when nothing was collected", () => {
    makeTask({ status: "running", daysAgo: 400 });
    const text = formatGcResult(collectGarbage(db, { now: NOW }));
    expect(text).toContain("nothing to collect");
    expect(text).toContain("1 unfinished task(s) kept");
  });

  it("names what went and states that costs stayed", () => {
    makeTask({ status: "succeeded", daysAgo: 90 });
    const text = formatGcResult(collectGarbage(db, { now: NOW }));

    expect(text).toContain("removed 1 task(s)");
    expect(text).toContain("work item(s)");
    expect(text).toContain("cost and failure records kept");
  });

  it("marks a dry run as one, in both the verb and a trailing note", () => {
    makeTask({ status: "succeeded", daysAgo: 90 });
    const text = formatGcResult(collectGarbage(db, { now: NOW, dryRun: true }));

    expect(text).toContain("would remove");
    expect(text).toContain("nothing was deleted");
    expect(text).not.toContain("removed 1 task");
  });

  it("mentions workspaces only when it removed some", () => {
    makeTask({ status: "succeeded", daysAgo: 90 });
    expect(formatGcResult(collectGarbage(db, { now: NOW }))).not.toContain("workspace");
  });
});
