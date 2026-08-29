/**
 * `GET /internal/costs`.
 *
 * `summarizeCosts` is tested exhaustively in `shared`, so these tests are not
 * about the arithmetic. They are about the two things only the route can get
 * wrong: turning a query string into options (and rejecting the ones that would
 * otherwise become a 500 or, worse, a silently different answer), and pulling
 * the right rows out of SQLite — including the un-attributed ones, which
 * `listCosts` cannot see because it is scoped to a task.
 */
import {
  type CostSummary,
  CostSummarySchema,
  newCostRecordId,
  newTaskId,
  newWorkerRunId,
} from "@rewter/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { Router } from "../router/router.js";
import { FakeAdapter } from "../testing/fake-adapter.js";
import { PRV_A, model, provider } from "../testing/registry.js";
import { buildApp } from "./app.js";

const SONNET = "anthropic/claude-sonnet-5";
const GLM = "zai/glm-5.3";
const CREATED_MS = 1_756_252_800_000;
const noon = Date.UTC(2026, 7, 28, 12, 0, 0);

let db: Db;
let repos: Repos;
let bus: EventBus;
let app: FastifyInstance;

beforeEach(() => {
  db = openDb(":memory:");
  let tick = CREATED_MS;
  const clock = () => ++tick;
  bus = new EventBus(db, clock);
  repos = new Repos(db, bus, clock);
  repos.upsertProvider(provider());
  repos.upsertModel(model(SONNET));
  repos.upsertModel(model(GLM, PRV_A));
  app = buildApp({
    router: new Router({ repos, createAdapter: () => new FakeAdapter([]) }),
    repos,
    bus,
    clock: () => CREATED_MS,
    sse: { heartbeatMs: 0 },
  });
});

afterEach(async () => {
  await app?.close();
});

/**
 * Costs are written with no task on purpose in most of these: un-attributed
 * spend is the case `listCosts` structurally cannot return, so it is the one
 * that proves the endpoint reads the whole table.
 */
function cost(over: {
  modelId?: string;
  taskId?: string | null;
  workerRunId?: string | null;
  costUsd?: number;
  createdAt?: number;
}): void {
  repos.recordCost({
    id: newCostRecordId(),
    taskId: (over.taskId ?? null) as never,
    workerRunId: (over.workerRunId ?? null) as never,
    modelId: (over.modelId ?? SONNET) as never,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: over.costUsd ?? 0.01,
    pricingSnapshot: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    },
    createdAt: over.createdAt ?? noon,
  });
}

const get = async (url: string) => app.inject({ method: "GET", url });
const summary = async (url: string): Promise<CostSummary> =>
  CostSummarySchema.parse((await get(url)).json());

describe("GET /internal/costs", () => {
  it("defaults to grouping by model", async () => {
    cost({ modelId: SONNET, costUsd: 0.5 });
    cost({ modelId: GLM, costUsd: 0.02 });
    const body = await summary("/internal/costs");
    expect(body.groupBy).toBe("model");
    expect(body.buckets.map((b) => b.key)).toEqual([SONNET, GLM]);
    expect(body.totals.costUsd).toBeCloseTo(0.52);
  });

  it("returns rows with no task — the ones listCosts cannot reach", async () => {
    // A plain `/v1` pass-through has no task id. Scoping the endpoint the way
    // `listCosts` is scoped would report a daemon's real spend as zero.
    cost({ taskId: null, costUsd: 0.25 });
    expect((await summary("/internal/costs")).totals.costUsd).toBeCloseTo(0.25);
  });

  it("keeps the initiator/worker split across the SQL boundary", async () => {
    const task = repos.createTask({
      id: newTaskId(),
      status: "running",
      title: "t",
      initiatorModelId: SONNET as never,
      conversationFingerprint: "fp",
      settings: { autoApprove: false, maxSpendUsd: null, workspaceDir: null, concurrency: 4 },
      resultSummary: null,
      error: null,
      createdAt: CREATED_MS,
      updatedAt: CREATED_MS,
      finishedAt: null,
    });
    const run = newWorkerRunId();
    cost({ taskId: task.id, workerRunId: null, costUsd: 0.4 });
    cost({ taskId: task.id, workerRunId: run, costUsd: 0.1 });

    const body = await summary("/internal/costs?groupBy=task");
    const bucket = body.buckets.find((b) => b.key === task.id);
    expect(bucket?.initiatorCostUsd).toBeCloseTo(0.4);
    expect(bucket?.workerCostUsd).toBeCloseTo(0.1);
  });

  it("groups by day in UTC unless a zone is asked for", async () => {
    // 04:00 UTC is the previous day in Los Angeles; the zone is the answer.
    cost({ createdAt: Date.UTC(2026, 7, 28, 4, 0, 0) });
    expect((await summary("/internal/costs?groupBy=day")).buckets[0]?.key).toBe("2026-08-28");
    const la = await summary("/internal/costs?groupBy=day&tz=America/Los_Angeles");
    expect(la.buckets[0]?.key).toBe("2026-08-27");
    expect(la.timeZone).toBe("America/Los_Angeles");
  });

  it("filters to a window, half-open at the top", async () => {
    cost({ createdAt: 1000, costUsd: 1 });
    cost({ createdAt: 2000, costUsd: 2 });
    const body = await summary("/internal/costs?since=1000&until=2000");
    expect(body.totals.costUsd).toBe(1);
    expect(body).toMatchObject({ since: 1000, until: 2000 });
  });

  it("rejects an unknown groupBy instead of silently defaulting", async () => {
    // Defaulting would answer a question the caller did not ask, and the
    // numbers would look plausible.
    const res = await get("/internal/costs?groupBy=provider");
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain("groupBy");
  });

  it("rejects a non-numeric window", async () => {
    expect((await get("/internal/costs?since=yesterday")).statusCode).toBe(400);
  });

  it("rejects an unknown time zone rather than 500ing from inside Intl", async () => {
    const res = await get("/internal/costs?groupBy=day&tz=Mars/Olympus");
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain("time zone");
  });

  it("answers an empty table with zeroes, not an error", async () => {
    const body = await summary("/internal/costs?groupBy=day");
    expect(body.buckets).toEqual([]);
    expect(body.totals.calls).toBe(0);
  });
});
