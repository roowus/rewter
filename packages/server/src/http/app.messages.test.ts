/**
 * Wire-format tests for `POST /v1/messages` — the Anthropic-native surface
 * Claude Code actually speaks. Same discipline as `app.test.ts`: raw-byte
 * assertions on the streaming path, because "an Anthropic client will work
 * against this" is a claim about bytes, not about parsed objects.
 *
 * The framing difference from OpenAI is the thing most worth pinning: every
 * frame carries a named `event:` line, and there is no `[DONE]` sentinel.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { Router } from "../router/router.js";
import { FakeAdapter, end, err, text, toolDelta, toolStart } from "../testing/fake-adapter.js";
import { model, provider } from "../testing/registry.js";
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

function setup(
  scripts: ConstructorParameters<typeof FakeAdapter>[0],
  opts: { apiKey?: string } = {},
) {
  const adapter = new FakeAdapter(scripts);
  const router = new Router({ repos, createAdapter: () => adapter, sleep: async () => undefined });
  app = buildApp({
    router,
    repos,
    bus,
    clock: () => CREATED_MS,
    sse: { heartbeatMs: 0 },
    ...(opts.apiKey !== undefined && { apiKey: opts.apiKey }),
  });
  return { adapter, router };
}

const messagesBody = (over: Record<string, unknown> = {}) => ({
  model: MODEL_ID,
  max_tokens: 1024,
  messages: [{ role: "user", content: "hi" }],
  ...over,
});

/** Parse an Anthropic SSE body into `[eventName, payload]` pairs. */
function sseEvents(body: string): [string, Record<string, unknown>][] {
  return body
    .split("\n\n")
    .filter((block) => block.startsWith("event: "))
    .map((block) => {
      const [eventLine, dataLine] = block.split("\n");
      return [
        (eventLine as string).slice("event: ".length),
        JSON.parse((dataLine as string).slice("data: ".length)),
      ];
    });
}

describe("POST /v1/messages — non-streaming", () => {
  it("returns Anthropic's message envelope", async () => {
    setup([[text("hello"), end("stop", { inputTokens: 12, outputTokens: 4 })]]);

    const res = await app.inject({ method: "POST", url: "/v1/messages", payload: messagesBody() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: expect.stringMatching(/^msg_/),
      type: "message",
      role: "assistant",
      model: MODEL_ID,
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 4 },
    });
  });

  it("emits tool_use blocks with parsed input objects", async () => {
    setup([
      [
        text("checking"),
        toolStart(0, "toolu_1", "get_weather"),
        toolDelta(0, '{"city":'),
        toolDelta(0, '"Paris"}'),
        end("tool_calls"),
      ],
    ]);

    const res = await app.inject({ method: "POST", url: "/v1/messages", payload: messagesBody() });
    const body = res.json();

    expect(body.stop_reason).toBe("tool_use");
    expect(body.content).toEqual([
      { type: "text", text: "checking" },
      // Arguments cross our internal format as a string; the wire wants an object.
      { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
    ]);
  });

  it("degrades malformed tool JSON to an empty object rather than 500ing", async () => {
    setup([[toolStart(0, "toolu_1", "f"), toolDelta(0, "{not json"), end("tool_calls")]]);

    const res = await app.inject({ method: "POST", url: "/v1/messages", payload: messagesBody() });

    expect(res.statusCode).toBe(200);
    expect(res.json().content[0].input).toEqual({});
  });

  it("omits an empty text block from content", async () => {
    setup([[toolStart(0, "toolu_1", "f"), toolDelta(0, "{}"), end("tool_calls")]]);

    const res = await app.inject({ method: "POST", url: "/v1/messages", payload: messagesBody() });

    expect(res.json().content).toHaveLength(1);
    expect(res.json().content[0].type).toBe("tool_use");
  });

  it("passes system, tools and the conversation through to the adapter", async () => {
    const { adapter } = setup([[text("ok"), end()]]);

    await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: messagesBody({
        system: "be terse",
        tools: [{ name: "get_weather", description: "look up weather", input_schema: {} }],
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "17C" }],
          },
        ],
      }),
    });

    const req = adapter.requests[0];
    expect(req?.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(req?.tools?.[0]?.name).toBe("get_weather");
    expect(req?.maxTokens).toBe(1024);
  });
});

describe("POST /v1/messages — streaming", () => {
  it("frames every event with a named event line and no [DONE]", async () => {
    setup([[text("hi"), end()]]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: messagesBody({ stream: true }),
    });

    expect(res.headers["content-type"]).toContain("text/event-stream");
    // Every frame is `event: … \n data: … \n\n` — a data-only frame is invisible
    // to an Anthropic client, and `[DONE]` is an unparseable frame to it.
    for (const block of res.body.split("\n\n").filter((b) => b !== "")) {
      expect(block).toMatch(/^event: [a-z_]+\ndata: \{/);
    }
    expect(res.body).not.toContain("[DONE]");
    expect(res.body.endsWith("\n\n")).toBe(true);
  });

  it("streams the full message_start → message_stop sequence", async () => {
    setup([[text("hello"), text(" world"), end("stop", { inputTokens: 9, outputTokens: 2 })]]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: messagesBody({ stream: true }),
    });
    const events = sseEvents(res.body);

    expect(events.map(([name]) => name)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    // The event name and the payload's own `type` must agree — clients dispatch
    // on one and validate against the other.
    for (const [name, payload] of events) expect(payload.type).toBe(name);
  });

  it("reassembles to the original text", async () => {
    setup([[text("hello"), text(" world"), end()]]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: messagesBody({ stream: true }),
    });

    const assembled = sseEvents(res.body)
      .filter(([name]) => name === "content_block_delta")
      .map(([, p]) => (p.delta as { text?: string }).text ?? "")
      .join("");
    expect(assembled).toBe("hello world");
  });

  it("carries the model and a msg_ id on message_start", async () => {
    setup([[text("hi"), end()]]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: messagesBody({ stream: true }),
    });
    const [, start] = sseEvents(res.body)[0] as [string, { message: Record<string, unknown> }];

    expect(start.message.model).toBe(MODEL_ID);
    expect(start.message.id).toMatch(/^msg_/);
    expect(start.message.content).toEqual([]);
  });

  it("reports usage on message_delta", async () => {
    setup([[text("hi"), end("stop", { inputTokens: 100, outputTokens: 7 })]]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: messagesBody({ stream: true }),
    });
    const delta = sseEvents(res.body).find(([name]) => name === "message_delta");

    expect(delta?.[1].usage).toEqual({ input_tokens: 100, output_tokens: 7 });
    expect(delta?.[1].delta).toEqual({ stop_reason: "end_turn", stop_sequence: null });
  });

  it("streams tool calls as their own indexed blocks", async () => {
    setup([
      [
        text("looking"),
        toolStart(0, "toolu_1", "get_weather"),
        toolDelta(0, '{"city":"Paris"}'),
        end("tool_calls"),
      ],
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: messagesBody({ stream: true }),
    });
    const events = sseEvents(res.body);

    const toolStartEvent = events.find(
      ([name, p]) =>
        name === "content_block_start" && (p.content_block as { type: string }).type === "tool_use",
    );
    expect(toolStartEvent?.[1].index).toBe(1);
    expect(toolStartEvent?.[1].content_block).toEqual({
      type: "tool_use",
      id: "toolu_1",
      name: "get_weather",
      input: {},
    });

    const jsonDelta = events.find(
      ([name, p]) =>
        name === "content_block_delta" && (p.delta as { type: string }).type === "input_json_delta",
    );
    expect((jsonDelta?.[1].delta as { partial_json: string }).partial_json).toBe(
      '{"city":"Paris"}',
    );
  });

  it("delivers a mid-stream failure as an error event and still closes the message", async () => {
    // Headers are already out, so there is no status code left. A client that
    // ignores the error event must still see message_stop rather than hang.
    setup([[text("partial"), err("upstream exploded", false, 500)]]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: messagesBody({ stream: true }),
    });
    const names = sseEvents(res.body).map(([name]) => name);

    expect(res.statusCode).toBe(200);
    expect(names).toContain("error");
    expect(names.at(-1)).toBe("message_stop");
  });
});

describe("POST /v1/messages — errors and auth", () => {
  it("400s a request missing max_tokens, in Anthropic's error shape", async () => {
    setup([[text("hi"), end()]]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { model: MODEL_ID, messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: expect.stringContaining("max_tokens") },
    });
  });

  it("404s an unknown model before any bytes go out", async () => {
    setup([[text("hi"), end()]]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: messagesBody({ model: "nope/nope", stream: true }),
    });

    // Resolution happens before headers precisely so this is a status code and
    // not an SSE error frame the client has to dig out of a 200.
    expect(res.statusCode).toBe(404);
    expect(res.json().type).toBe("error");
  });

  it("501s the orchestrator pseudo-model until M5", async () => {
    setup([[text("hi"), end()]]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: messagesBody({ model: "auto/orchestrator" }),
    });

    expect(res.statusCode).toBe(501);
    expect(res.json().error.type).toBe("not_implemented");
  });

  it("forwards an upstream 429 rather than burying it in a 502", async () => {
    setup([[err("slow down", false, 429)]]);

    const res = await app.inject({ method: "POST", url: "/v1/messages", payload: messagesBody() });

    expect(res.statusCode).toBe(429);
  });

  it("accepts x-api-key, which is the only auth header Anthropic clients send", async () => {
    setup([[text("hi"), end()]], { apiKey: "sekrit" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": "sekrit" },
      payload: messagesBody(),
    });

    expect(res.statusCode).toBe(200);
  });

  it("still accepts Authorization: Bearer on the same key", async () => {
    setup([[text("hi"), end()]], { apiKey: "sekrit" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: "Bearer sekrit" },
      payload: messagesBody(),
    });

    expect(res.statusCode).toBe(200);
  });

  it("401s a wrong x-api-key in Anthropic's error shape", async () => {
    setup([[text("hi"), end()]], { apiKey: "sekrit" });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": "wrong" },
      payload: messagesBody(),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "invalid api key" },
    });
  });
});
