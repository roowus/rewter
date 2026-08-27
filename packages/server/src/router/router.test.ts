import {
  type ChatMessage,
  ModelIdSchema,
  type Task,
  TaskSettingsSchema,
  newTaskId,
} from "@rewter/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { costRecords } from "../db/schema.js";
import { EventBus } from "../events/bus.js";
import { FakeAdapter, end, err, text } from "../testing/fake-adapter.js";
import { PRV_A, model, provider } from "../testing/registry.js";
import { Router, type RouterOptions } from "./router.js";

const MODEL_ID = "anthropic/claude-sonnet-5";
const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];
/** 1M input @ $3 + 2M output @ $15 — round numbers make the arithmetic visible. */
const BILLABLE = { inputTokens: 1_000_000, outputTokens: 2_000_000 };

let db: Db;
let repos: Repos;
let tick: number;
/** Backoffs the router asked for — proves retries waited, without waiting. */
let slept: number[];

beforeEach(() => {
  db = openDb(":memory:");
  tick = 1_756_252_800_000;
  const clock = () => ++tick;
  repos = new Repos(db, new EventBus(db, clock), clock);
  slept = [];
});

/** Seeds one enabled provider + model and wires the router to `adapter`. */
function makeRouter(adapter: FakeAdapter, over: Partial<RouterOptions> = {}): Router {
  repos.upsertProvider(provider());
  repos.upsertModel(model(MODEL_ID, PRV_A, { upstreamId: "claude-sonnet-5-20260101" }));
  return new Router({
    repos,
    createAdapter: () => adapter,
    clock: () => ++tick,
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...over,
  });
}

function makeTask(): Task {
  return repos.createTask({
    id: newTaskId(),
    status: "pending",
    title: "cost attribution",
    initiatorModelId: ModelIdSchema.parse(MODEL_ID),
    conversationFingerprint: "fp_test",
    settings: TaskSettingsSchema.parse({}),
    resultSummary: null,
    error: null,
    createdAt: tick,
    updatedAt: tick,
    finishedAt: null,
  });
}

/** Every cost row regardless of task — `listCosts` is scoped to one task. */
function allCostRows() {
  return db.select().from(costRecords).all();
}

async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe("Router.stream", () => {
  it("passes the upstream id, not our slug, to the adapter", async () => {
    const adapter = new FakeAdapter([[text("hi"), end()]]);
    await drain(makeRouter(adapter).stream({ model: MODEL_ID, messages: MESSAGES }));
    expect(adapter.requests[0]?.model).toBe("claude-sonnet-5-20260101");
  });

  it("resolves loose names before dispatching", async () => {
    const adapter = new FakeAdapter([[text("hi"), end()]]);
    const chunks = await drain(
      makeRouter(adapter).stream({ model: "claude-sonnet-5", messages: MESSAGES }),
    );
    expect(chunks).toEqual([text("hi"), end()]);
  });

  it("retries a retryable failure that arrives before any output", async () => {
    const adapter = new FakeAdapter([[err("503 upstream", true, 503)], [text("ok"), end()]]);
    const chunks = await drain(makeRouter(adapter).stream({ model: MODEL_ID, messages: MESSAGES }));
    // The caller never learns the first attempt happened.
    expect(chunks).toEqual([text("ok"), end()]);
    expect(adapter.attempts).toBe(2);
    expect(slept).toEqual([250]);
  });

  it("does not retry once a chunk has escaped", async () => {
    // Replaying here would duplicate text the client already rendered.
    const adapter = new FakeAdapter([
      [text("half"), err("connection reset", true, null)],
      [text("full"), end()],
    ]);
    const chunks = await drain(makeRouter(adapter).stream({ model: MODEL_ID, messages: MESSAGES }));
    expect(chunks).toEqual([text("half"), err("connection reset", true, null)]);
    expect(adapter.attempts).toBe(1);
  });

  it("does not retry a non-retryable failure", async () => {
    const adapter = new FakeAdapter([[err("400 bad request", false, 400)], [text("ok"), end()]]);
    const chunks = await drain(makeRouter(adapter).stream({ model: MODEL_ID, messages: MESSAGES }));
    expect(chunks).toEqual([err("400 bad request", false, 400)]);
    expect(adapter.attempts).toBe(1);
  });

  it("gives up after maxAttempts with a terminal error chunk", async () => {
    const adapter = new FakeAdapter([[err("503 upstream unavailable", true, 503)]]);
    const chunks = await drain(makeRouter(adapter).stream({ model: MODEL_ID, messages: MESSAGES }));
    expect(adapter.attempts).toBe(3);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: "error",
      // The upstream's own words are what a user can act on; how hard we tried
      // is the part they cannot see from the outside.
      message: "503 upstream unavailable (after 3 attempts)",
      statusCode: 503,
    });
    // Exponential, and no sleep after the final attempt.
    expect(slept).toEqual([250, 500]);
  });

  it("does not annotate a first-attempt failure with an attempt count", async () => {
    const adapter = new FakeAdapter([[err("400 bad request", false, 400)]]);
    const chunks = await drain(makeRouter(adapter).stream({ model: MODEL_ID, messages: MESSAGES }));
    expect(chunks[0]).toMatchObject({ message: "400 bad request" });
  });

  it("reports a silent stream rather than hanging on it", async () => {
    // An adapter that yields nothing at all is a contract violation, but the
    // caller still needs a terminal chunk.
    const adapter = new FakeAdapter([[]]);
    const chunks = await drain(makeRouter(adapter).stream({ model: MODEL_ID, messages: MESSAGES }));
    expect(adapter.attempts).toBe(3);
    expect(chunks[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("no output"),
    });
  });

  it("turns an adapter that throws into a terminal error chunk", async () => {
    // A throwing adapter is a bug, but the client must not hang on it.
    const adapter = new FakeAdapter([[]], { throwOnAttempt: 1 });
    const chunks = await drain(
      makeRouter(adapter, { maxAttempts: 1 }).stream({ model: MODEL_ID, messages: MESSAGES }),
    );
    expect(chunks).toEqual([
      { type: "error", message: "adapter exploded", retryable: false, statusCode: null },
    ]);
  });

  it("retries a throwing adapter while nothing has been emitted", async () => {
    const adapter = new FakeAdapter([[], [text("ok"), end()]], { throwOnAttempt: 1 });
    const chunks = await drain(makeRouter(adapter).stream({ model: MODEL_ID, messages: MESSAGES }));
    expect(chunks).toEqual([text("ok"), end()]);
  });

  it("propagates a resolve failure as a throw, before any chunk", async () => {
    const router = makeRouter(new FakeAdapter([[text("hi"), end()]]));
    // Must reject rather than yield: the HTTP layer still has a status code here.
    await expect(drain(router.stream({ model: "nope", messages: MESSAGES }))).rejects.toThrow(
      /unknown model/,
    );
  });

  it("stops when the caller aborts", async () => {
    const adapter = new FakeAdapter([[text("a"), text("b"), end()]]);
    const abort = new AbortController();
    abort.abort();
    const chunks = await drain(
      makeRouter(adapter).stream({ model: MODEL_ID, messages: MESSAGES }, abort.signal),
    );
    expect(chunks).toEqual([err("request aborted", false, null)]);
    // An abort is the user's decision — retrying would resurrect a killed call.
    expect(adapter.attempts).toBe(1);
  });
});

describe("Router cost recording", () => {
  it("records a cost row computed from a pricing snapshot", async () => {
    const task = makeTask();
    const adapter = new FakeAdapter([[text("hi"), end("stop", BILLABLE)]]);
    await drain(
      makeRouter(adapter).stream({ model: MODEL_ID, messages: MESSAGES, taskId: task.id }),
    );

    const costs = repos.listCosts(task.id);
    expect(costs).toHaveLength(1);
    expect(costs[0]?.costUsd).toBeCloseTo(3 + 30, 6);
    expect(costs[0]?.modelId).toBe(MODEL_ID);
    expect(costs[0]?.pricingSnapshot.inputPerMTok).toBe(3);
  });

  it("records untasked pass-through calls with a null taskId", async () => {
    const adapter = new FakeAdapter([[text("hi"), end("stop", BILLABLE)]]);
    await drain(makeRouter(adapter).stream({ model: MODEL_ID, messages: MESSAGES }));

    const rows = allCostRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.taskId).toBeNull();
    expect(rows[0]?.costUsd).toBeCloseTo(33, 6);
  });

  it("snapshots pricing so a later price change cannot rewrite history", async () => {
    const adapter = new FakeAdapter([[text("hi"), end("stop", BILLABLE)]]);
    const router = makeRouter(adapter);
    await drain(router.stream({ model: MODEL_ID, messages: MESSAGES }));

    // The vendor doubles its price; the recorded row must not move.
    repos.upsertModel(
      model(MODEL_ID, PRV_A, {
        upstreamId: "claude-sonnet-5-20260101",
        pricing: {
          inputPerMTok: 6,
          outputPerMTok: 30,
          cacheReadPerMTok: 0.6,
          cacheWritePerMTok: 7.5,
        },
      }),
    );

    const rows = allCostRows();
    expect(rows[0]?.costUsd).toBeCloseTo(33, 6);
    expect(JSON.parse(rows[0]?.pricingSnapshotJson ?? "{}").inputPerMTok).toBe(3);
  });

  it("records nothing when the stream dies before reporting usage", async () => {
    const adapter = new FakeAdapter([[text("hi"), err("died", false, 500)]]);
    await drain(makeRouter(adapter).stream({ model: MODEL_ID, messages: MESSAGES }));
    expect(allCostRows()).toHaveLength(0);
  });

  it("records once, not per attempt, when a retry succeeds", async () => {
    const adapter = new FakeAdapter([[err("503", true, 503)], [text("ok"), end("stop", BILLABLE)]]);
    await drain(makeRouter(adapter).stream({ model: MODEL_ID, messages: MESSAGES }));
    expect(allCostRows()).toHaveLength(1);
  });
});

describe("Router.complete", () => {
  it("folds the stream into a single response", async () => {
    const adapter = new FakeAdapter([[text("hello "), text("world"), end()]]);
    const res = await makeRouter(adapter).complete({ model: MODEL_ID, messages: MESSAGES });
    expect(res.message.content).toBe("hello world");
    expect(res.finishReason).toBe("stop");
    expect(res.usage.inputTokens).toBe(1_000);
  });

  it("inherits the same retry policy as streaming", async () => {
    const adapter = new FakeAdapter([[err("503", true, 503)], [text("ok"), end()]]);
    const res = await makeRouter(adapter).complete({ model: MODEL_ID, messages: MESSAGES });
    expect(res.message.content).toBe("ok");
    expect(adapter.attempts).toBe(2);
  });

  it("records cost exactly once, like the streaming path", async () => {
    const adapter = new FakeAdapter([[text("hi"), end("stop", BILLABLE)]]);
    await makeRouter(adapter).complete({ model: MODEL_ID, messages: MESSAGES });
    expect(allCostRows()).toHaveLength(1);
  });

  it("throws when the stream terminates in an error", async () => {
    const adapter = new FakeAdapter([[err("400 bad", false, 400)]]);
    await expect(
      makeRouter(adapter).complete({ model: MODEL_ID, messages: MESSAGES }),
    ).rejects.toThrow(/400 bad/);
  });
});
