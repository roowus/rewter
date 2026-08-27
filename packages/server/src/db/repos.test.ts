import {
  type EventEnvelope,
  IllegalTransitionError,
  ModelIdSchema,
  TaskSettingsSchema,
  newApprovalId,
  newCostRecordId,
  newTaskId,
  newWorkItemId,
  newWorkerRunId,
} from "@rewter/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../events/bus.js";
import { type Db, openDb } from "./connection.js";
import { Repos } from "./repos.js";

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
  const now = tick;
  return repos.createTask({
    id: newTaskId(),
    status: "pending",
    title: "test task",
    initiatorModelId: mdl,
    conversationFingerprint: "fp_abc",
    settings: TaskSettingsSchema.parse({}),
    resultSummary: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  });
}

describe("Repos round-trips (in-memory SQLite)", () => {
  it("task: create → read back identical; JSON settings survive", () => {
    const task = makeTask();
    const loaded = repos.getTask(task.id);
    expect(loaded).toEqual(task);
    expect(loaded?.settings.concurrency).toBe(4);
  });

  it("task: legal transitions update status/finishedAt; illegal throw untouched", () => {
    const task = makeTask();
    const running = repos.transitionTask(task.id, "running");
    expect(running.status).toBe("running");
    expect(running.finishedAt).toBeNull();

    const done = repos.transitionTask(task.id, "succeeded", { resultSummary: "all good" });
    expect(done.status).toBe("succeeded");
    expect(done.resultSummary).toBe("all good");
    expect(done.finishedAt).not.toBeNull();

    // Terminal — any further transition throws and leaves the row alone.
    expect(() => repos.transitionTask(task.id, "running")).toThrow(IllegalTransitionError);
    expect(repos.getTask(task.id)).toEqual(done);
  });

  it("task: waiting_approval pause/resume round-trip", () => {
    const task = makeTask();
    repos.transitionTask(task.id, "running");
    repos.transitionTask(task.id, "waiting_approval");
    expect(repos.getTask(task.id)?.status).toBe("waiting_approval");
    repos.transitionTask(task.id, "running");
    expect(repos.getTask(task.id)?.status).toBe("running");
  });

  it("work item + worker run: full ladder with handoff chain columns", () => {
    const task = makeTask();
    const wi = repos.createWorkItem({
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
    expect(repos.listWorkItems(task.id)).toEqual([wi]);

    const run = repos.createWorkerRun({
      id: newWorkerRunId(),
      workItemId: wi.id,
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

    repos.transitionWorkerRun(run.id, "streaming");
    repos.transitionWorkerRun(run.id, "tool_pending");
    repos.transitionWorkerRun(run.id, "streaming");
    const finished = repos.transitionWorkerRun(run.id, "succeeded", { resultText: "REPORT: ok" });
    expect(finished.resultText).toBe("REPORT: ok");
    expect(() => repos.transitionWorkerRun(run.id, "streaming")).toThrow(IllegalTransitionError);

    repos.transitionWorkItem(wi.id, "running");
    const handed = repos.transitionWorkItem(wi.id, "handed_off");
    expect(handed.finishedAt).not.toBeNull();
  });

  it("worker run: harnessSessionId patch persists (tier-3 seam)", () => {
    const task = makeTask();
    const wi = repos.createWorkItem({
      id: newWorkItemId(),
      taskId: task.id,
      parentWorkItemId: null,
      status: "pending",
      title: "harness subtask",
      instructions: "x",
      modelId: mdl,
      tier: 3,
      resultSummary: null,
      error: null,
      createdAt: tick,
      updatedAt: tick,
      finishedAt: null,
    });
    const run = repos.createWorkerRun({
      id: newWorkerRunId(),
      workItemId: wi.id,
      taskId: task.id,
      status: "created",
      modelId: mdl,
      tier: 3,
      attempt: 1,
      harnessSessionId: null,
      resultText: null,
      error: null,
      createdAt: tick,
      updatedAt: tick,
      finishedAt: null,
    });
    const updated = repos.transitionWorkerRun(run.id, "streaming", {
      harnessSessionId: "rwtr_abc123",
    });
    expect(updated.harnessSessionId).toBe("rwtr_abc123");
  });

  it("approval: pending → approved via resolveApproval; illegal double-resolve throws", () => {
    const task = makeTask();
    const apr = repos.createApproval({
      id: newApprovalId(),
      taskId: task.id,
      workItemId: null,
      workerRunId: null,
      status: "pending",
      kind: "shell",
      summary: "run `rm -rf dist`",
      detail: { command: "rm -rf dist" },
      resolvedBy: null,
      resolutionNote: null,
      createdAt: tick,
      resolvedAt: null,
    });
    expect(repos.listPendingApprovals(task.id)).toHaveLength(1);

    const resolved = repos.resolveApproval(apr.id, "approved", "dashboard", "lgtm");
    expect(resolved.status).toBe("approved");
    expect(resolved.resolvedAt).not.toBeNull();
    expect(repos.listPendingApprovals(task.id)).toHaveLength(0);
    expect(() => repos.resolveApproval(apr.id, "denied", "in_band")).toThrow(
      IllegalTransitionError,
    );
  });

  it("cost records round-trip with pricing snapshot", () => {
    const task = makeTask();
    const cost = repos.recordCost({
      id: newCostRecordId(),
      taskId: task.id,
      workerRunId: null,
      modelId: mdl,
      inputTokens: 5000,
      outputTokens: 800,
      cacheReadTokens: 4000,
      cacheWriteTokens: 0,
      costUsd: 0.0282,
      pricingSnapshot: {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
      },
      createdAt: tick,
    });
    expect(repos.listCosts(task.id)).toEqual([cost]);
  });

  it("foreign keys are enforced (work item without task rejected)", () => {
    expect(() =>
      repos.createWorkItem({
        id: newWorkItemId(),
        taskId: newTaskId(), // no such task row
        parentWorkItemId: null,
        status: "pending",
        title: "orphan",
        instructions: "x",
        modelId: mdl,
        tier: 1,
        resultSummary: null,
        error: null,
        createdAt: tick,
        updatedAt: tick,
        finishedAt: null,
      }),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe("EventBus", () => {
  it("append assigns monotonic seq; replay ordered by seq with afterSeq cursor", () => {
    const task = makeTask(); // emits task.created (seq 1)
    repos.transitionTask(task.id, "running"); // seq 2
    bus.append({
      taskId: task.id,
      payload: { type: "task.plan_note", taskId: task.id, note: "n1" },
    }); // 3
    repos.transitionTask(task.id, "succeeded"); // 4

    const all = bus.eventsAfter(0);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(all.map((e) => e.payload.type)).toEqual([
      "task.created",
      "task.status_changed",
      "task.plan_note",
      "task.status_changed",
    ]);

    const tail = bus.eventsAfter(2);
    expect(tail.map((e) => e.seq)).toEqual([3, 4]);

    const scoped = bus.eventsAfter(0, task.id);
    expect(scoped).toHaveLength(4);
    expect(bus.eventsAfter(0, "task_nonexistent1")).toHaveLength(0);
  });

  it("notifies subscribers synchronously after persist; broken subscriber isolated", () => {
    const seen: EventEnvelope[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    const unsub = bus.subscribe((e) => seen.push(e));

    const task = makeTask();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.payload.type).toBe("task.created");
    // The event was durably persisted before/despite the broken subscriber.
    expect(bus.eventsAfter(0, task.id)).toHaveLength(1);

    unsub();
    repos.transitionTask(task.id, "running");
    expect(seen).toHaveLength(1);
  });

  it("rejects malformed payloads before persisting", () => {
    expect(() =>
      bus.append({
        taskId: null,
        // @ts-expect-error deliberately malformed
        payload: { type: "task.plan_note", note: 42 },
      }),
    ).toThrow();
    expect(bus.eventsAfter(0)).toHaveLength(0);
  });
});
