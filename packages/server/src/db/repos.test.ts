import {
  type EventEnvelope,
  EventPayloadSchema,
  IllegalTransitionError,
  ModelIdSchema,
  ProjectSchema,
  TaskSettingsSchema,
  newApprovalId,
  newCostRecordId,
  newProjectId,
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
    projectId: null,
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

  it("task: settings patch merges over the row and emits from → to", () => {
    const task = makeTask();
    const updated = repos.updateTaskSettings(task.id, { maxSpendUsd: 5 });

    expect(updated.settings.maxSpendUsd).toBe(5);
    // A caller that knows only about the cap must not silently reset the rest to
    // the schema defaults — this is why it takes a patch, not a whole object.
    expect(updated.settings.concurrency).toBe(task.settings.concurrency);
    expect(updated.settings.autoApprove).toBe(task.settings.autoApprove);
    expect(repos.getTask(task.id)).toEqual(updated);

    const events = bus.eventsAfter(0).map((e: EventEnvelope) => e.payload);
    const change = events.find((p) => p.type === "task.settings_changed");
    if (change?.type !== "task.settings_changed") throw new Error("no settings event");
    // `from` is what makes the log read as a change rather than a restatement.
    expect(change.from.maxSpendUsd).toBeNull();
    expect(change.to.maxSpendUsd).toBe(5);
  });

  it("task: settings can remove a cap, which is not a cap of zero", () => {
    const task = makeTask();
    repos.updateTaskSettings(task.id, { maxSpendUsd: 2 });
    const cleared = repos.updateTaskSettings(task.id, { maxSpendUsd: null });
    expect(cleared.settings.maxSpendUsd).toBeNull();
    // Zero is not a legal cap; the schema is the one contract, not a second
    // check at the route.
    expect(() => repos.updateTaskSettings(task.id, { maxSpendUsd: 0 })).toThrow();
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

  it("allCosts returns un-attributed spend, which listCosts structurally cannot", () => {
    // A pass-through through `/v1` has no task. Reporting daemon spend from
    // `listCosts` alone would show those calls as costing nothing.
    const task = makeTask();
    const priced = (taskId: string | null, createdAt: number) =>
      repos.recordCost({
        id: newCostRecordId(),
        taskId: taskId as never,
        workerRunId: null,
        modelId: mdl,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.01,
        pricingSnapshot: {
          inputPerMTok: 3,
          outputPerMTok: 15,
          cacheReadPerMTok: 0.3,
          cacheWritePerMTok: 3.75,
        },
        createdAt,
      });

    priced(task.id, 1000);
    priced(null, 2000);
    priced(null, 3000);

    expect(repos.allCosts()).toHaveLength(3);
    // Oldest first, so a caller charting a window reads it forward.
    expect(repos.allCosts().map((c) => c.createdAt)).toEqual([1000, 2000, 3000]);
    // Half-open: `since` included, `until` excluded, so windows tile.
    expect(repos.allCosts({ since: 2000, until: 3000 }).map((c) => c.createdAt)).toEqual([2000]);
    expect(repos.allCosts({ since: 3000 }).map((c) => c.createdAt)).toEqual([3000]);
    expect(repos.allCosts({ until: 2000 }).map((c) => c.createdAt)).toEqual([1000]);
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

describe("Projects (configuration, not lifecycle)", () => {
  function makeProject(slug: string, over: Record<string, unknown> = {}) {
    return ProjectSchema.parse({
      id: newProjectId(),
      slug,
      name: `Project ${slug}`,
      createdAt: tick,
      updatedAt: tick,
      ...over,
    });
  }

  it("upsert → read back identical; JSON columns survive the round-trip", () => {
    const p = makeProject("rewter", {
      description: "the router itself",
      resources: [
        { kind: "repo", location: "/Users/x/projects/rewter", note: "main checkout" },
        { kind: "url", location: "https://example.com/spec", note: null },
      ],
      policy: {
        autoApprove: true,
        maxSpendUsd: 2.5,
        allowedTools: ["shell"],
        allowedHarnesses: null,
      },
      modelPrefs: { initiatorPin: mdl, prefer: [mdl], avoid: [] },
    });
    repos.upsertProject(p);
    expect(repos.getProject(p.id)).toEqual(p);
    expect(repos.getProjectBySlug("rewter")).toEqual(p);
  });

  it("upsert on the same id updates in place — settings edits are idempotent", () => {
    const p = makeProject("proj-a");
    repos.upsertProject(p);
    const renamed = { ...p, name: "Renamed", updatedAt: tick + 1 };
    repos.upsertProject(renamed);
    expect(repos.listProjects()).toHaveLength(1);
    expect(repos.getProject(p.id)?.name).toBe("Renamed");
  });

  it("slug is UNIQUE at the DB layer — a second project cannot take a taken name", () => {
    repos.upsertProject(makeProject("taken"));
    // Different id, same slug: the selection key would become ambiguous, so the
    // constraint (not application code) refuses it.
    expect(() => repos.upsertProject(makeProject("taken"))).toThrow(/UNIQUE/i);
  });

  it("slug rename frees the old name for reuse (ids never change, slugs may)", () => {
    const p = makeProject("old-name");
    repos.upsertProject(p);
    repos.upsertProject({ ...p, slug: ProjectSchema.shape.slug.parse("new-name") });
    expect(repos.getProjectBySlug("old-name")).toBeUndefined();
    expect(repos.getProjectBySlug("new-name")?.id).toBe(p.id);
    repos.upsertProject(makeProject("old-name"));
    expect(repos.listProjects()).toHaveLength(2);
  });

  it("listProjects hides archived by default, includes them on request, sorts by slug", () => {
    repos.upsertProject(makeProject("zebra"));
    repos.upsertProject(makeProject("alpha"));
    repos.upsertProject(makeProject("shelved", { archived: true }));

    expect(repos.listProjects().map((p) => p.slug)).toEqual(["alpha", "zebra"]);
    expect(repos.listProjects({ includeArchived: true }).map((p) => p.slug)).toEqual([
      "alpha",
      "shelved",
      "zebra",
    ]);
    // Archived projects still load directly — the dashboard un-archives via id.
    const shelved = repos.getProjectBySlug("shelved");
    expect(shelved?.archived).toBe(true);
  });

  it("emits NO events — old event logs must replay without knowing projects exist", () => {
    const before = bus.eventsAfter(0).length;
    const p = makeProject("silent");
    repos.upsertProject(p);
    repos.deleteProject(p.id);
    expect(bus.eventsAfter(0)).toHaveLength(before);
  });

  it("task keeps its projectId across the round-trip; deleting the project does not touch the task", () => {
    const p = makeProject("owner");
    repos.upsertProject(p);
    const now = tick;
    const task = repos.createTask({
      id: newTaskId(),
      status: "pending",
      title: "scoped task",
      initiatorModelId: mdl,
      projectId: p.id,
      conversationFingerprint: "fp_proj",
      settings: TaskSettingsSchema.parse({}),
      resultSummary: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    });
    expect(repos.getTask(task.id)?.projectId).toBe(p.id);

    // No FK on purpose: history stays attributed to an id that no longer
    // resolves, rather than blocking the delete or nulling the column.
    repos.deleteProject(p.id);
    expect(repos.getTask(task.id)?.projectId).toBe(p.id);
    expect(repos.getProject(p.id)).toBeUndefined();
  });

  it("pre-phase-2 task.created payloads (no projectId key) still parse", () => {
    // Events persisted before the projects milestone embed a Task without the
    // field at all. Replay must default it, not reject the whole log.
    const legacy = {
      type: "task.created",
      task: {
        id: newTaskId(),
        status: "pending",
        title: "from an old log",
        initiatorModelId: "anthropic/claude-sonnet-5",
        conversationFingerprint: null,
        settings: TaskSettingsSchema.parse({}),
        resultSummary: null,
        error: null,
        createdAt: 1,
        updatedAt: 1,
        finishedAt: null,
      },
    };
    const parsed = EventPayloadSchema.parse(legacy);
    if (parsed.type !== "task.created") throw new Error("wrong branch");
    expect(parsed.task.projectId).toBeNull();
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
