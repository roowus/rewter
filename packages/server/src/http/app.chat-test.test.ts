/**
 * The one debug route that spends. Which is what these tests are about: the
 * spend has to be *visible* (usage and a cost the spend panel would agree with)
 * and *bounded* (a low ceiling the caller cannot raise past), and the failures
 * people press this button to diagnose have to come back in the upstream's own
 * words rather than as a generic 502.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { Router } from "../router/router.js";
import { FakeAdapter, end, err, text } from "../testing/fake-adapter.js";
import { PRV_A, model, provider } from "../testing/registry.js";
import { buildApp } from "./app.js";

const NOW = 1_756_252_800_000;
const GPT = "openai/gpt-5";

let db: Db;
let repos: Repos;
let app: FastifyInstance;
let adapter: FakeAdapter;

/** Wall clock advances one tick per read, so `latencyMs` is a real number. */
function tickingClock(): () => number {
  let t = NOW;
  return () => {
    t += 25;
    return t;
  };
}

beforeEach(() => {
  db = openDb(":memory:");
  const bus = new EventBus(db, () => NOW);
  repos = new Repos(db, bus, () => NOW);
  repos.upsertProvider(provider(PRV_A, { name: "OpenAI" }));
  repos.upsertModel(model(GPT, PRV_A));
});

afterEach(async () => {
  await app?.close();
});

const chatTest = (payload: object) =>
  app.inject({ method: "POST", url: "/internal/chat-test", payload });

function boot(scripts: ConstructorParameters<typeof FakeAdapter>[0]): void {
  adapter = new FakeAdapter(scripts);
  const bus = new EventBus(db, () => NOW);
  app = buildApp({
    router: new Router({ repos, maxAttempts: 1, createAdapter: () => adapter }),
    repos,
    bus,
    clock: tickingClock(),
  });
}

describe("POST /internal/chat-test", () => {
  it("returns the answer, the tokens, and what they cost", async () => {
    boot([[text("hello "), text("there"), end("stop")]]);

    const res = await chatTest({ model: GPT, prompt: "hi", maxTokens: 32 });
    expect(res.statusCode).toBe(200);
    const out = res.json();

    expect(out.modelId).toBe(GPT);
    expect(out.text).toBe("hello there");
    expect(out.finishReason).toBe("stop");
    expect(out.usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // The fixture prices input at $3/MTok and output at $15/MTok: 1000 in and
    // 500 out is 0.003 + 0.0075. Asserted exactly, because "roughly right" is
    // the failure mode a spend readout cannot have.
    expect(out.costUsd).toBeCloseTo(0.0105, 10);
    expect(out.latencyMs).toBeGreaterThan(0);
  });

  /**
   * The button's whole justification is that a real completion proves what a
   * catalog read cannot — so it has to actually go through the router, with the
   * caller's ceiling attached.
   */
  it("sends the prompt as one user message, capped at maxTokens", async () => {
    boot([[text("ok"), end("stop")]]);

    await chatTest({ model: GPT, prompt: "are you there?", maxTokens: 64, temperature: 0.2 });

    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]).toMatchObject({
      // The upstream id, not our slug — this went through resolution.
      model: "gpt-5",
      messages: [{ role: "user", content: "are you there?" }],
      maxTokens: 64,
      temperature: 0.2,
    });
  });

  it("defaults maxTokens low rather than leaving it open", async () => {
    boot([[text("ok"), end("stop")]]);

    await chatTest({ model: GPT, prompt: "hi" });

    expect(adapter.requests[0]?.maxTokens).toBe(256);
  });

  it("refuses a ceiling high enough to be a bill", async () => {
    boot([[text("ok"), end("stop")]]);

    const res = await chatTest({ model: GPT, prompt: "hi", maxTokens: 100_000 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("maxTokens");
    expect(adapter.attempts).toBe(0);
  });

  /**
   * An unpriced model must not print `$0.00`. Zero is a claim ("free"), and the
   * honest answer when a price is missing is that we do not know.
   */
  it("reports null cost — not zero — for an unpriced model", async () => {
    repos.upsertModel(
      model("local/qwen", PRV_A, {
        pricing: {
          inputPerMTok: null,
          outputPerMTok: null,
          cacheReadPerMTok: null,
          cacheWritePerMTok: null,
        },
      }),
    );
    boot([[text("ok"), end("stop")]]);

    const res = await chatTest({ model: "local/qwen", prompt: "hi" });
    expect(res.statusCode).toBe(200);
    expect(res.json().costUsd).toBeNull();
    expect(res.json().usage.outputTokens).toBe(500);
  });

  it("records the spend, so a test drive shows up in the costs panel", async () => {
    boot([[text("ok"), end("stop")]]);

    await chatTest({ model: GPT, prompt: "hi" });

    const records = repos.allCosts();
    expect(records).toHaveLength(1);
    expect(records[0]?.modelId).toBe(GPT);
    expect(records[0]?.costUsd).toBeCloseTo(0.0105, 10);
    // Not attributed to any task — this was a button press, not orchestration.
    expect(records[0]?.taskId).toBeNull();
  });

  /**
   * The failure this button exists to surface. A wrong key comes back as the
   * upstream's own 401 and its own sentence — "daemon said 502" would send the
   * user back to the logs, which is where they were before the button existed.
   */
  it("forwards an upstream refusal verbatim, at its own status", async () => {
    boot([[err("invalid x-api-key", false, 401)]]);

    const res = await chatTest({ model: GPT, prompt: "hi" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toContain("invalid x-api-key");
  });

  it("a dead upstream is a 502, not a hang", async () => {
    boot([[err("connect ECONNREFUSED", true, null)]]);

    const res = await chatTest({ model: GPT, prompt: "hi" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toContain("ECONNREFUSED");
  });

  it("an unknown model is a 404 before anything is sent", async () => {
    boot([[text("ok"), end("stop")]]);

    const res = await chatTest({ model: "nope/nothing", prompt: "hi" });
    expect(res.statusCode).toBe(404);
    expect(adapter.attempts).toBe(0);
  });

  /**
   * Testing "the orchestrator" would spend an unbounded amount answering a
   * different question than the one asked. It is refused, not attempted.
   */
  it("refuses the orchestrator pseudo-model", async () => {
    boot([[text("ok"), end("stop")]]);

    const res = await chatTest({ model: "auto/orchestrator", prompt: "hi" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("orchestration");
    expect(adapter.attempts).toBe(0);
  });

  it("rejects an empty prompt", async () => {
    boot([[text("ok"), end("stop")]]);

    const res = await chatTest({ model: GPT, prompt: "" });
    expect(res.statusCode).toBe(400);
    expect(adapter.attempts).toBe(0);
  });
});
