/**
 * `GET /internal/failures`.
 *
 * `summarizeFailures` is tested in `shared`; these tests cover what only the
 * route can get wrong: the query-string window, and reading both tables — the
 * failures and the cost records that stand in for successes — over the same
 * window, so the rate the dashboard shows is a rate and not two unrelated
 * counts.
 */
import {
  type FailureSummary,
  FailureSummarySchema,
  newCostRecordId,
  newFailureRecordId,
} from "@rewter/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { Router } from "../router/router.js";
import { FakeAdapter, end, err, text } from "../testing/fake-adapter.js";
import { PRV_A, model, provider } from "../testing/registry.js";
import { buildApp } from "./app.js";

const SONNET = "anthropic/claude-sonnet-5";
const GLM = "zai/glm-5.3";
const CREATED_MS = 1_756_252_800_000;
const noon = Date.UTC(2026, 8, 2, 12, 0, 0);

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
  // Every upstream call in this file fails once, then succeeds: the shape the
  // endpoint exists to make visible.
  const adapter = new FakeAdapter([[err("503 upstream", true, 503)], [text("ok"), end()]]);
  app = buildApp({
    router: new Router({
      repos,
      createAdapter: () => adapter,
      clock,
      sleep: async () => {},
    }),
    repos,
    bus,
    clock: () => CREATED_MS,
    sse: { heartbeatMs: 0 },
  });
});

afterEach(async () => {
  await app?.close();
});

function failure(over: {
  modelId?: string;
  phase?: "before_output" | "mid_stream";
  statusCode?: number | null;
  createdAt?: number;
}): void {
  repos.recordFailure({
    id: newFailureRecordId(),
    taskId: null,
    workerRunId: null,
    modelId: (over.modelId ?? SONNET) as never,
    providerId: PRV_A as never,
    attempt: 1,
    phase: over.phase ?? "before_output",
    retried: over.phase !== "mid_stream",
    retryable: true,
    statusCode: over.statusCode === undefined ? 503 : over.statusCode,
    message: "503 upstream unavailable",
    createdAt: over.createdAt ?? noon,
  });
}

function success(over: { modelId?: string; createdAt?: number }): void {
  repos.recordCost({
    id: newCostRecordId(),
    taskId: null,
    workerRunId: null,
    modelId: (over.modelId ?? SONNET) as never,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.01,
    pricingSnapshot: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    },
    createdAt: over.createdAt ?? noon,
  });
}

const get = async (url: string) => app.inject({ method: "GET", url });
const summary = async (url: string): Promise<FailureSummary> =>
  FailureSummarySchema.parse((await get(url)).json());

describe("GET /internal/failures", () => {
  it("answers an empty table with zeroes, not an error", async () => {
    const body = await summary("/internal/failures");
    expect(body.buckets).toEqual([]);
    expect(body.totals.failures).toBe(0);
  });

  it("puts failures and successes from both tables side by side", async () => {
    failure({ phase: "mid_stream" });
    failure({ modelId: GLM });
    success({});
    success({});
    success({ modelId: GLM });
    const body = await summary("/internal/failures");
    expect(body.totals).toMatchObject({
      failures: 2,
      midStream: 1,
      beforeOutput: 1,
      successes: 3,
    });
    expect(body.buckets.find((b) => b.key === SONNET)).toMatchObject({
      failures: 1,
      midStream: 1,
      successes: 2,
    });
  });

  it("applies one window to both record kinds", async () => {
    failure({ createdAt: 1000 });
    failure({ createdAt: 2000 });
    success({ createdAt: 1000 });
    success({ createdAt: 2000 });
    const body = await summary("/internal/failures?since=1000&until=2000");
    expect(body.totals).toMatchObject({ failures: 1, successes: 1 });
    expect(body).toMatchObject({ since: 1000, until: 2000 });
  });

  it("rejects a non-numeric window", async () => {
    expect((await get("/internal/failures?since=yesterday")).statusCode).toBe(400);
  });

  it("shows a retry the /v1 client never saw", async () => {
    // End to end: the pass-through call succeeds from the client's point of
    // view, and the endpoint still knows the first attempt failed.
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: SONNET, messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);

    const body = await summary("/internal/failures");
    expect(body.totals).toMatchObject({
      failures: 1,
      retried: 1,
      beforeOutput: 1,
      successes: 1,
      byStatus: { "503": 1 },
    });
    expect(body.buckets[0]).toMatchObject({ key: SONNET, lastMessage: "503 upstream" });
  });
});
