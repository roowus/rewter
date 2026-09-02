/**
 * The stats recorder, run against the real repos on an in-memory database so
 * the test exercises the actual bus → transition → row path, not a mock of it.
 */
import {
  type CostRecord,
  ModelIdSchema,
  type TaskId,
  type WorkItemId,
  type WorkerRunId,
  newCostRecordId,
  newWorkerRunId,
} from "@rewter/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { task, workItem } from "../testing/tasks.js";
import { recordWorkItem, wireStatsRecorder } from "./stats.js";

const MDL = ModelIdSchema.parse("zai/glm-5.3");

let db: Db;
let bus: EventBus;
let repos: Repos;
let tick: number;

beforeEach(() => {
  db = openDb(":memory:");
  tick = 1_756_252_800_000;
  const clock = () => {
    tick += 1000;
    return tick;
  };
  bus = new EventBus(db, clock);
  repos = new Repos(db, bus, clock);
});

function spawn(taskId: TaskId, tag: "coding" | "ocr" | null): WorkItemId {
  const wi = repos.createWorkItem({
    ...workItem(taskId, "sub", { modelId: MDL, createdAt: tick, updatedAt: tick }),
    taskTag: tag,
  });
  repos.transitionWorkItem(wi.id, "running");
  return wi.id;
}

function run(taskId: TaskId, workItemId: WorkItemId): WorkerRunId {
  return repos.createWorkerRun({
    id: newWorkerRunId(),
    workItemId,
    taskId,
    status: "created",
    modelId: MDL,
    tier: 1,
    attempt: 1,
    harnessSessionId: null,
    resultText: null,
    error: null,
    createdAt: tick,
    updatedAt: tick,
    finishedAt: null,
  }).id;
}

function cost(taskId: TaskId, workerRunId: WorkerRunId | null, costUsd: number): CostRecord {
  return repos.recordCost({
    id: newCostRecordId(),
    taskId,
    workerRunId,
    modelId: MDL,
    inputTokens: 10,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
    pricingSnapshot: {
      inputPerMTok: 1,
      outputPerMTok: 1,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    },
    createdAt: tick,
  });
}

describe("wireStatsRecorder", () => {
  it("records a tagged work item when it settles, summing only its own runs' costs", () => {
    wireStatsRecorder({ bus, store: repos });
    const t = repos.createTask(task());
    const wi = spawn(t.id, "coding");
    const r1 = run(t.id, wi);
    const r2 = run(t.id, wi);
    cost(t.id, r1, 0.01);
    cost(t.id, r2, 0.02);
    // The initiator's own spend on the same task is not the worker's.
    cost(t.id, null, 5);
    const other = run(t.id, spawn(t.id, null));
    cost(t.id, other, 7);

    repos.transitionWorkItem(wi, "succeeded");

    const stat = repos.getModelStat(MDL, "coding");
    expect(stat).toMatchObject({ attempts: 1, successes: 1 });
    expect(stat?.avgCostUsd).toBeCloseTo(0.03, 10);
    // created → finished, two clock ticks apart (create, then the running and
    // succeeded transitions each advance the clock).
    expect(stat?.avgLatencyMs).toBeGreaterThan(0);
  });

  it("counts failed and cancelled as attempts that did not succeed", () => {
    wireStatsRecorder({ bus, store: repos });
    const t = repos.createTask(task());
    repos.transitionWorkItem(spawn(t.id, "coding"), "failed", { error: "boom" });
    repos.transitionWorkItem(spawn(t.id, "coding"), "cancelled");
    repos.transitionWorkItem(spawn(t.id, "coding"), "succeeded");

    expect(repos.getModelStat(MDL, "coding")).toMatchObject({ attempts: 3, successes: 1 });
  });

  it("ignores untagged items, non-terminal transitions and daemon interruptions", () => {
    wireStatsRecorder({ bus, store: repos });
    const t = repos.createTask(task());
    repos.transitionWorkItem(spawn(t.id, null), "succeeded");
    // `interrupted` is the daemon dying, not the model failing.
    repos.transitionWorkItem(spawn(t.id, "ocr"), "interrupted", { error: "restart" });
    // Still running: nothing to record yet.
    spawn(t.id, "ocr");

    expect(repos.listModelStats()).toEqual([]);
  });

  it("stops recording once unsubscribed", () => {
    const { unsubscribe } = wireStatsRecorder({ bus, store: repos });
    const t = repos.createTask(task());
    const wi = spawn(t.id, "coding");
    unsubscribe();
    repos.transitionWorkItem(wi, "succeeded");
    expect(repos.listModelStats()).toEqual([]);
  });

  it("a store failure is a warning, not an exception into the write path", () => {
    const warnings: string[] = [];
    const broken = Object.create(repos) as Repos;
    broken.recordOutcome = () => {
      throw new Error("disk full");
    };
    wireStatsRecorder({ bus, store: broken, log: { warn: (_o, msg) => warnings.push(msg) } });
    const t = repos.createTask(task());
    const wi = spawn(t.id, "coding");
    expect(() => repos.transitionWorkItem(wi, "succeeded")).not.toThrow();
    expect(warnings).toEqual(["model stats: could not record outcome"]);
  });
});

describe("recordWorkItem", () => {
  it("returns undefined for an unknown, untagged or unfinished item", () => {
    const t = repos.createTask(task());
    expect(recordWorkItem(repos, "wi_nope")).toBeUndefined();
    expect(recordWorkItem(repos, spawn(t.id, null))).toBeUndefined();
    expect(recordWorkItem(repos, spawn(t.id, "coding"))).toBeUndefined();
    expect(repos.listModelStats()).toEqual([]);
  });

  it("records a null cost when the worker produced no cost rows", () => {
    const t = repos.createTask(task());
    const wi = spawn(t.id, "ocr");
    repos.transitionWorkItem(wi, "succeeded");
    // No recorder wired in this describe, so this is the first observation.
    const stat = recordWorkItem(repos, wi);
    expect(stat?.avgCostUsd).toBeNull();
    expect(stat?.attempts).toBe(1);
  });
});
