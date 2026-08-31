import {
  type EventEnvelope,
  ModelIdSchema,
  type TaskId,
  TaskSettingsSchema,
  type WorkItemId,
  newApprovalId,
  newTaskId,
  newWorkItemId,
  newWorkerRunId,
} from "@rewter/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "./db/connection.js";
import { Repos } from "./db/repos.js";
import { EventBus } from "./events/bus.js";
import { INTERRUPTED_REASON, reconcileOnBoot, reconcileSummary } from "./reconcile.js";

const mdl = ModelIdSchema.parse("anthropic/claude-sonnet-5");

let db: Db;
let bus: EventBus;
let repos: Repos;
let tick: number;

beforeEach(() => {
  db = openDb(":memory:");
  tick = 1_724_800_000_000;
  const clock = () => ++tick;
  bus = new EventBus(db, clock);
  repos = new Repos(db, bus, clock);
});

function makeTask() {
  return repos.createTask({
    id: newTaskId(),
    status: "pending",
    title: "test task",
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
}

function makeWorkItem(taskId: TaskId) {
  return repos.createWorkItem({
    id: newWorkItemId(),
    taskId,
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
}

function makeRun(taskId: TaskId, workItemId: WorkItemId, attempt = 1) {
  return repos.createWorkerRun({
    id: newWorkerRunId(),
    workItemId,
    taskId,
    status: "created",
    modelId: mdl,
    tier: 2,
    attempt,
    harnessSessionId: null,
    resultText: null,
    error: null,
    createdAt: tick,
    updatedAt: tick,
    finishedAt: null,
  });
}

/** A task, item and run all left mid-flight, as `kill -9` would leave them. */
function midFlight() {
  const task = makeTask();
  repos.transitionTask(task.id, "running");
  const item = makeWorkItem(task.id);
  repos.transitionWorkItem(item.id, "running");
  const run = makeRun(task.id, item.id);
  repos.transitionWorkerRun(run.id, "streaming");
  return { task, item, run };
}

describe("reconcileOnBoot", () => {
  it("marks a task, its work items and its runs interrupted", () => {
    const { task, item, run } = midFlight();

    const result = reconcileOnBoot(repos);

    expect(result).toEqual({ tasks: [task.id], workItems: [item.id], workerRuns: [run.id] });
    expect(repos.getTask(task.id)?.status).toBe("interrupted");
    expect(repos.getWorkItem(item.id)?.status).toBe("interrupted");
    expect(repos.getWorkerRun(run.id)?.status).toBe("interrupted");
  });

  it("records why, and stamps finishedAt", () => {
    // "interrupted" alone reads as a status; the reason is what tells whoever
    // finds the row six weeks later that the machine went away.
    const { task } = midFlight();
    reconcileOnBoot(repos);

    const closed = repos.getTask(task.id);
    expect(closed?.error).toBe(INTERRUPTED_REASON);
    expect(closed?.finishedAt).not.toBeNull();
  });

  it("does not touch tasks that finished cleanly", () => {
    const task = makeTask();
    repos.transitionTask(task.id, "running");
    const done = repos.transitionTask(task.id, "succeeded", { resultSummary: "ok" });

    expect(reconcileOnBoot(repos).tasks).toEqual([]);
    expect(repos.getTask(task.id)).toEqual(done);
  });

  it("is idempotent — a second boot finds nothing left to close", () => {
    // This runs on *every* boot, including the ones right after a clean stop.
    // If it were not a no-op the second time, it would throw on the terminal
    // row rather than starting the daemon.
    midFlight();
    expect(reconcileOnBoot(repos).tasks).toHaveLength(1);
    expect(reconcileOnBoot(repos)).toEqual({ tasks: [], workItems: [], workerRuns: [] });
  });

  it("closes a task parked on an approval, and expires the approval with it", () => {
    // The promise that was waiting on this approval died with the process.
    // Left pending it would sit in the dashboard inviting a click that resolves
    // a row nobody is listening to.
    const task = makeTask();
    repos.transitionTask(task.id, "running");
    repos.transitionTask(task.id, "waiting_approval");
    const approval = repos.createApproval({
      id: newApprovalId(),
      taskId: task.id,
      workItemId: null,
      workerRunId: null,
      status: "pending",
      kind: "shell",
      summary: "rm -rf build",
      detail: null,
      resolvedBy: null,
      resolutionNote: null,
      createdAt: tick,
      resolvedAt: null,
    });

    reconcileOnBoot(repos);

    expect(repos.getTask(task.id)?.status).toBe("interrupted");
    expect(repos.getApproval(approval.id)?.status).toBe("expired");
    expect(repos.listPendingApprovals(task.id)).toEqual([]);
  });

  it("emits a status_changed event per row, so the dashboard fold sees it", () => {
    // Reconciliation goes through the ordinary repo methods precisely so that a
    // task does not simply stop updating in the event log: the interruption is
    // part of the history, replayable like everything else.
    const { task, item, run } = midFlight();
    const seen: EventEnvelope[] = [];
    bus.subscribe((e) => seen.push(e));

    reconcileOnBoot(repos);

    const transitions = seen.filter((e) => e.payload.type.endsWith("status_changed"));
    expect(transitions.map((e) => (e.payload as { to: string }).to)).toEqual([
      "interrupted",
      "interrupted",
      "interrupted",
    ]);
    expect(transitions.every((e) => e.taskId === task.id)).toBe(true);
    // Deepest first: the run closes before its item, the item before the task.
    expect(transitions.map((e) => e.payload.type)).toEqual([
      "worker_run.status_changed",
      "work_item.status_changed",
      "task.status_changed",
    ]);
    expect(item.id).not.toBe(run.id);
  });

  it("leaves finished children alone while closing their unfinished siblings", () => {
    const task = makeTask();
    repos.transitionTask(task.id, "running");
    const done = makeWorkItem(task.id);
    repos.transitionWorkItem(done.id, "running");
    const finished = repos.transitionWorkItem(done.id, "succeeded", { resultSummary: "done" });
    const open = makeWorkItem(task.id);
    repos.transitionWorkItem(open.id, "running");

    const result = reconcileOnBoot(repos);

    expect(result.workItems).toEqual([open.id]);
    expect(repos.getWorkItem(done.id)).toEqual(finished);
  });

  it("closes every attempt at a retried work item", () => {
    // A retry ladder leaves more than one run row; only the last is live, but a
    // crash between attempts can leave an earlier one open too.
    const task = makeTask();
    repos.transitionTask(task.id, "running");
    const item = makeWorkItem(task.id);
    repos.transitionWorkItem(item.id, "running");
    const first = makeRun(task.id, item.id, 1);
    repos.transitionWorkerRun(first.id, "streaming");
    const second = makeRun(task.id, item.id, 2);
    repos.transitionWorkerRun(second.id, "streaming");

    expect(reconcileOnBoot(repos).workerRuns).toEqual([first.id, second.id]);
  });

  it("closes several interrupted tasks in one sweep, oldest first", () => {
    const first = midFlight();
    const second = midFlight();
    expect(reconcileOnBoot(repos).tasks).toEqual([first.task.id, second.task.id]);
  });
});

describe("reconcileSummary", () => {
  it("is empty when a clean shutdown left nothing to close", () => {
    // The boot log should say nothing at all in the ordinary case, not "0 tasks".
    expect(reconcileSummary({ tasks: [], workItems: [], workerRuns: [] })).toBe("");
  });

  it("counts what it closed", () => {
    const line = reconcileSummary({ tasks: ["t"], workItems: ["a", "b"], workerRuns: ["r"] });
    expect(line).toContain("1 task(s)");
    expect(line).toContain("2 work item(s)");
    expect(line).toContain("1 run(s)");
  });
});
