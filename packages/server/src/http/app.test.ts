/**
 * Wire-format tests through `app.inject()` — no ports, no sockets, no keys.
 * These are the tests that say "an OpenAI client will actually work against
 * this", so they assert on raw bytes for the streaming path rather than on
 * parsed objects.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { Router } from "../router/router.js";
import { FakeAdapter, end, err, text, toolDelta, toolStart } from "../testing/fake-adapter.js";
import { PRV_A, PRV_B, model, provider } from "../testing/registry.js";
import { buildApp } from "./app.js";

const MODEL_ID = "anthropic/claude-sonnet-5";
const CREATED_MS = 1_756_252_800_000;

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
  repos.upsertModel(model(MODEL_ID));
});

afterEach(async () => {
  await app?.close();
});

/** Builds the app around a scripted adapter. Returns both for assertions. */
function setup(
  scripts: ConstructorParameters<typeof FakeAdapter>[0],
  opts: { apiKey?: string } = {},
) {
  const adapter = new FakeAdapter(scripts);
  const router = new Router({
    repos,
    createAdapter: () => adapter,
    sleep: async () => undefined,
  });
  app = buildApp({
    router,
    repos,
    bus,
    clock: () => CREATED_MS,
    // Heartbeats would inject `: ping` lines into byte-exact assertions.
    sse: { heartbeatMs: 0 },
    ...(opts.apiKey !== undefined && { apiKey: opts.apiKey }),
  });
  return { adapter, router };
}

const chatBody = (over: Record<string, unknown> = {}) => ({
  model: MODEL_ID,
  messages: [{ role: "user", content: "hi" }],
  ...over,
});

/** Parse an SSE body into its `data:` payloads, `[DONE]` included as a marker. */
function sseFrames(body: string): unknown[] {
  return body
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => {
      const payload = block.slice("data: ".length);
      return payload === "[DONE]" ? "[DONE]" : JSON.parse(payload);
    });
}

describe("GET /v1/models", () => {
  it("lists enabled models in OpenAI's shape", async () => {
    setup([[text("hi"), end()]]);
    const res = await app.inject({ method: "GET", url: "/v1/models" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ object: string; data: Array<Record<string, unknown>> }>();
    expect(body.object).toBe("list");
    expect(body.data).toContainEqual(
      expect.objectContaining({ id: MODEL_ID, object: "model", owned_by: PRV_A }),
    );
  });

  it("puts the orchestrator first so it is visible in every model picker", async () => {
    setup([[]]);
    const body = (await app.inject({ method: "GET", url: "/v1/models" })).json<{
      data: Array<{ id: string; owned_by: string }>;
    }>();
    expect(body.data[0]).toMatchObject({ id: "auto/orchestrator", owned_by: "rewter" });
  });

  it("hides disabled models", async () => {
    repos.upsertModel(model("anthropic/retired", PRV_A, { enabled: false }));
    setup([[]]);
    const body = (await app.inject({ method: "GET", url: "/v1/models" })).json<{
      data: Array<{ id: string }>;
    }>();
    expect(body.data.map((m) => m.id)).not.toContain("anthropic/retired");
  });
});

describe("POST /v1/chat/completions — non-streaming", () => {
  it("returns an OpenAI completion envelope", async () => {
    setup([[text("hello "), text("world"), end()]]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      object: "chat.completion",
      model: MODEL_ID,
      created: Math.floor(CREATED_MS / 1000),
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello world" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1_000, completion_tokens: 500, total_tokens: 1_500 },
    });
    expect(res.json<{ id: string }>().id).toMatch(/^chatcmpl-/);
  });

  it("returns tool calls in OpenAI's function shape", async () => {
    setup([
      [toolStart(0, "call_1", "read_file"), toolDelta(0, '{"path":"a.ts"}'), end("tool_calls")],
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody(),
    });
    expect(
      res.json<{ choices: Array<{ message: Record<string, unknown> }> }>().choices[0]?.message,
    ).toMatchObject({
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"a.ts"}' },
        },
      ],
    });
  });

  it("accepts the multi-part content array Claude Code sends", async () => {
    const { adapter } = setup([[text("ok"), end()]]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "part one " },
              { type: "text", text: "part two" },
            ],
          },
        ],
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(adapter.requests[0]?.messages[0]?.content).toBe("part one part two");
  });

  it("normalizes the `developer` role to `system` at the edge", async () => {
    // No upstream other than OpenAI has heard of it.
    const { adapter } = setup([[text("ok"), end()]]);
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody({
        messages: [
          { role: "developer", content: "be terse" },
          { role: "user", content: "hi" },
        ],
      }),
    });
    expect(adapter.requests[0]?.messages[0]?.role).toBe("system");
  });

  it("forwards tools, max_tokens and temperature", async () => {
    const { adapter } = setup([[text("ok"), end()]]);
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody({
        max_tokens: 256,
        temperature: 0.2,
        tools: [
          {
            type: "function",
            function: { name: "grep", description: "search", parameters: { type: "object" } },
          },
        ],
      }),
    });
    expect(adapter.requests[0]).toMatchObject({
      maxTokens: 256,
      temperature: 0.2,
      tools: [{ name: "grep", description: "search" }],
    });
  });

  it("accepts max_completion_tokens from newer clients", async () => {
    const { adapter } = setup([[text("ok"), end()]]);
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody({ max_completion_tokens: 128 }),
    });
    expect(adapter.requests[0]?.maxTokens).toBe(128);
  });

  it("ignores unknown knobs rather than rejecting the request", async () => {
    // 400-ing on `top_p` would break clients over a parameter we simply don't
    // forward yet.
    setup([[text("ok"), end()]]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody({ top_p: 0.9, seed: 7, presence_penalty: 0.1 }),
    });
    expect(res.statusCode).toBe(200);
  });

  it("surfaces an upstream failure as a 502", async () => {
    // We are the gateway; the vendor's 500 is our 502.
    setup([[err("upstream exploded", false, 500)]]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody(),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: { type: string } }>().error.type).toBe("upstream_error");
  });

  it("forwards an upstream status that describes the caller's own request", async () => {
    // A rate limit or a rejected key is actionable by the client; burying it
    // under a generic 502 would hide the one thing they can fix.
    setup([[err("rate limited", false, 429)]]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody(),
    });
    expect(res.statusCode).toBe(429);
  });
});

describe("POST /v1/chat/completions — streaming", () => {
  it("emits role, content, finish and [DONE] in order", async () => {
    setup([[text("hel"), text("lo"), end()]]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody({ stream: true }),
    });

    expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    const frames = sseFrames(res.body);
    expect(frames.at(-1)).toBe("[DONE]");
    expect(
      frames.slice(0, -1).map((f) => (f as { choices: [{ delta: unknown }] }).choices[0].delta),
    ).toEqual([{ role: "assistant" }, { content: "hel" }, { content: "lo" }, {}]);
  });

  it("frames every payload as `data: …` followed by a blank line", async () => {
    setup([[text("x"), end()]]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody({ stream: true }),
    });
    // Byte-exact: strict clients reject anything else.
    expect(res.body.endsWith("data: [DONE]\n\n")).toBe(true);
    for (const block of res.body.split("\n\n").filter((b) => b !== "")) {
      expect(block.startsWith("data: ")).toBe(true);
    }
  });

  it("omits usage unless stream_options asks for it", async () => {
    setup([[text("x"), end()]]);
    const plain = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody({ stream: true }),
    });
    expect(sseFrames(plain.body).some((f) => (f as { usage?: unknown }).usage !== undefined)).toBe(
      false,
    );

    setup([[text("x"), end()]]);
    const withUsage = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody({ stream: true, stream_options: { include_usage: true } }),
    });
    const final = sseFrames(withUsage.body).at(-2) as { usage: { total_tokens: number } };
    expect(final.usage.total_tokens).toBe(1_500);
  });

  it("delivers a mid-stream failure as a terminal frame plus [DONE]", async () => {
    // Headers are already out; a hang would be the alternative.
    setup([[text("partial"), err("connection reset", true, null)]]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody({ stream: true }),
    });
    expect(res.statusCode).toBe(200);
    const frames = sseFrames(res.body);
    expect(frames.at(-1)).toBe("[DONE]");
    const last = frames.at(-2) as {
      error?: { message: string };
      choices: [{ finish_reason: string }];
    };
    expect(last.error?.message).toBe("connection reset");
    expect(last.choices[0].finish_reason).toBe("stop");
  });

  it("still 404s a bad model name — before any SSE headers go out", async () => {
    setup([[text("x"), end()]]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody({ model: "does-not-exist", stream: true }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
  });
});

describe("POST /v1/chat/completions — request errors", () => {
  it("400s a request with no messages", async () => {
    setup([[]]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: MODEL_ID, messages: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { type: string } }>().error.type).toBe("invalid_request_error");
  });

  it("404s an unknown model", async () => {
    setup([[]]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody({ model: "nope" }),
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s an ambiguous model rather than guessing a provider", async () => {
    repos.upsertProvider(provider(PRV_B, { name: "Second" }));
    repos.upsertModel(model("bedrock/claude-sonnet-5", PRV_B));
    setup([[]]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody({ model: "claude-sonnet-5" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(/ambiguous/);
  });

  it("503s when the model's provider is switched off", async () => {
    repos.upsertProvider(provider(PRV_A, { enabled: false }));
    setup([[]]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody(),
    });
    expect(res.statusCode).toBe(503);
  });

  it("501s the orchestrator pseudo-model when no engine is wired", async () => {
    // Honest, rather than silently routing to some arbitrary concrete model.
    // The daemon always supplies an engine; this path is for tests that only
    // exercise plain routing, and for a daemon built without one.
    setup([[text("x"), end()]]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chatBody({ model: "auto/orchestrator" }),
    });
    expect(res.statusCode).toBe(501);
    expect(res.json<{ error: { type: string } }>().error.type).toBe("not_implemented");
  });
});

describe("bearer auth", () => {
  it("rejects /v1 without the configured key", async () => {
    setup([[text("x"), end()]], { apiKey: "sk-test" });
    const res = await app.inject({ method: "GET", url: "/v1/models" });
    expect(res.statusCode).toBe(401);
  });

  it("accepts /v1 with the configured key", async () => {
    setup([[text("x"), end()]], { apiKey: "sk-test" });
    const res = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer sk-test" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("leaves /internal open — it is localhost-bound, and the dashboard has no key", async () => {
    setup([[text("x"), end()]], { apiKey: "sk-test" });
    const res = await app.inject({ method: "GET", url: "/internal/health" });
    expect(res.statusCode).toBe(200);
  });

  it("is open when no key is configured", async () => {
    setup([[text("x"), end()]]);
    expect((await app.inject({ method: "GET", url: "/v1/models" })).statusCode).toBe(200);
  });
});

describe("/internal", () => {
  it("reports health with registry counts", async () => {
    setup([[]]);
    expect((await app.inject({ method: "GET", url: "/internal/health" })).json()).toMatchObject({
      status: "ok",
      models: 1,
      providers: 1,
    });
  });

  it("serves providers without leaking secrets — only env var names are stored", async () => {
    setup([[]]);
    const body = (await app.inject({ method: "GET", url: "/internal/providers" })).json<{
      providers: Array<{ apiKeyRef: string }>;
    }>();
    expect(body.providers[0]?.apiKeyRef).toBe("TEST_API_KEY");
    expect(JSON.stringify(body)).not.toContain("sk-");
  });

  it("lists models including disabled ones, unlike /v1/models", async () => {
    repos.upsertModel(model("anthropic/retired", PRV_A, { enabled: false }));
    setup([[]]);
    const body = (await app.inject({ method: "GET", url: "/internal/models" })).json<{
      models: Array<{ id: string }>;
    }>();
    expect(body.models.map((m) => m.id)).toContain("anthropic/retired");
  });

  it("replays events after a sequence number", async () => {
    setup([[text("x"), end()]]);
    await app.inject({ method: "POST", url: "/v1/chat/completions", payload: chatBody() });
    const all = (await app.inject({ method: "GET", url: "/internal/events" })).json<{
      events: Array<{ seq: number; type: string }>;
    }>();
    expect(all.events.length).toBeGreaterThan(0);

    const after = (
      await app.inject({ method: "GET", url: `/internal/events?afterSeq=${all.events[0]?.seq}` })
    ).json<{ events: unknown[] }>();
    expect(after.events).toHaveLength(all.events.length - 1);
  });

  it("treats a non-numeric afterSeq as 0 rather than erroring", async () => {
    setup([[]]);
    const res = await app.inject({ method: "GET", url: "/internal/events?afterSeq=banana" });
    expect(res.statusCode).toBe(200);
  });
});
