import { afterEach, describe, expect, it } from "vitest";
import { collectStream } from "./collect.js";
import { describeAdapterContract } from "./contract.js";
import {
  GOOGLE_PARALLEL_TOOL_CALLS,
  GOOGLE_RATE_LIMIT_BODY,
  GOOGLE_SPLIT_TOOL_ARGS,
  GOOGLE_TEXT,
  GOOGLE_TRUNCATED,
  stubFetch,
  truncatedFetch,
} from "./fixtures.js";
import { GoogleAdapter } from "./google.js";

/**
 * Unlike the OpenAI and Anthropic SDKs, `@google/genai` calls the global
 * `fetch` directly — there is no transport to inject. So the fixture is
 * installed globally and restored after each test.
 */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const make = (fetch: typeof globalThis.fetch) => {
  globalThis.fetch = fetch;
  return new GoogleAdapter({ apiKey: "test", baseUrl: "https://upstream.test" });
};

describeAdapterContract("google", {
  text: { adapter: () => make(stubFetch(GOOGLE_TEXT)) },
  splitToolArgs: { adapter: () => make(stubFetch(GOOGLE_SPLIT_TOOL_ARGS)) },
  parallelToolCalls: { adapter: () => make(stubFetch(GOOGLE_PARALLEL_TOOL_CALLS)) },
  httpError: { adapter: () => make(stubFetch(GOOGLE_RATE_LIMIT_BODY, { status: 429 })) },
  truncated: { adapter: () => make(truncatedFetch(GOOGLE_TRUNCATED)) },
});

describe("google specifics", () => {
  /** Capture the outgoing request body so wire-shape assertions are possible. */
  function recording(responseBody: string) {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return stubFetch(responseBody)(url as string, init);
    }) as unknown as typeof globalThis.fetch;
    return {
      seen,
      adapter: new GoogleAdapter({ apiKey: "k", baseUrl: "https://upstream.test" }),
    };
  }

  it("hoists leading system messages into systemInstruction, joined", async () => {
    const rec = recording(GOOGLE_TEXT);
    await collectStream(
      rec.adapter.stream({
        model: "gemini",
        messages: [
          { role: "system", content: "static core" },
          { role: "system", content: "registry digest" },
          { role: "user", content: "hi" },
        ],
      }),
    );
    const body = rec.seen[0]?.body;
    // Gemini has no system role; the two blocks become one instruction, which
    // the SDK then wraps in its own Content envelope.
    expect(body?.systemInstruction).toEqual({
      role: "user",
      parts: [{ text: "static core\n\nregistry digest" }],
    });
    expect(body?.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("uses the model role for assistant turns and folds tool results into user parts", async () => {
    const rec = recording(GOOGLE_TEXT);
    await collectStream(
      rec.adapter.stream({
        model: "gemini",
        messages: [
          { role: "user", content: "weather and time?" },
          {
            role: "assistant",
            content: null,
            toolCalls: [
              { id: "c_a", name: "get_weather", arguments: '{"city":"Paris"}' },
              { id: "c_b", name: "get_time", arguments: '{"tz":"UTC"}' },
            ],
          },
          { role: "tool", name: "get_weather", content: "18C", toolCallId: "c_a" },
          { role: "tool", name: "get_time", content: "12:00", toolCallId: "c_b" },
        ],
      }),
    );
    const contents = rec.seen[0]?.body.contents as Record<string, unknown>[];
    expect(contents).toHaveLength(3);
    expect(contents[1]).toEqual({
      role: "model",
      parts: [
        { functionCall: { name: "get_weather", args: { city: "Paris" } } },
        { functionCall: { name: "get_time", args: { tz: "UTC" } } },
      ],
    });
    // Both responses belong to one user turn, keyed by function *name*.
    expect(contents[2]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { name: "get_weather", response: { output: "18C" } } },
        { functionResponse: { name: "get_time", response: { output: "12:00" } } },
      ],
    });
  });

  it("synthesizes call ids — Gemini does not send them", async () => {
    globalThis.fetch = stubFetch(GOOGLE_PARALLEL_TOOL_CALLS);
    const response = await collectStream(
      new GoogleAdapter({ apiKey: "k", baseUrl: "https://upstream.test" }).stream({
        model: "gemini",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const ids = (response.message.toolCalls ?? []).map((c) => c.id);
    expect(ids).toEqual(["gemini_call_0", "gemini_call_1"]);
  });

  it("maps a function-call turn to tool_calls despite Gemini reporting STOP", async () => {
    globalThis.fetch = stubFetch(GOOGLE_SPLIT_TOOL_ARGS);
    const response = await collectStream(
      new GoogleAdapter({ apiKey: "k", baseUrl: "https://upstream.test" }).stream({
        model: "gemini",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    // The wire says finishReason STOP; the caller still has tools to run.
    expect(response.finishReason).toBe("tool_calls");
  });

  it("reports cachedContentTokenCount as cacheReadTokens", async () => {
    globalThis.fetch = stubFetch(GOOGLE_TEXT);
    const response = await collectStream(
      new GoogleAdapter({ apiKey: "k", baseUrl: "https://upstream.test" }).stream({
        model: "gemini",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(response.usage.inputTokens).toBe(12);
    expect(response.usage.outputTokens).toBe(5);
    expect(response.usage.cacheReadTokens).toBe(4);
  });

  it("malformed model-authored tool arguments degrade to {} instead of throwing", async () => {
    const rec = recording(GOOGLE_TEXT);
    await collectStream(
      rec.adapter.stream({
        model: "gemini",
        messages: [
          {
            role: "assistant",
            content: null,
            toolCalls: [{ id: "c_a", name: "f", arguments: "{not json" }],
          },
        ],
      }),
    );
    const contents = rec.seen[0]?.body.contents as Record<string, unknown>[];
    const parts = contents[0]?.parts as Record<string, Record<string, unknown>>[];
    expect(parts[0]?.functionCall?.args).toEqual({});
  });

  /**
   * The anti-drift check, weakened to what is true here. Anthropic and
   * openai-compat send the params object verbatim, so their tests can assert
   * byte equality. `@google/genai` does not: it lifts `config` apart into
   * `generationConfig` / `systemInstruction` / `tools`, moves the model id into
   * the URL, and uppercases JSON Schema types (`object` → `OBJECT`). So the
   * panel shows the *call as this adapter makes it* — the SDK's own input —
   * and this asserts the contents survive that reshaping, field by field,
   * rather than pretending to a deep equality that would be a lie.
   */
  it("describeRequest carries the same content the wire body ends up with", async () => {
    const rec = recording(GOOGLE_TEXT);
    const req = {
      model: "gemini",
      messages: [
        { role: "system" as const, content: "core" },
        { role: "user" as const, content: "hi" },
      ],
      tools: [{ name: "f", description: "d", parameters: { type: "object" } }],
      maxTokens: 100,
      temperature: 0.5,
    };

    const described = rec.adapter.describeRequest(req);
    await collectStream(rec.adapter.stream(req));
    const wire = rec.seen[0];

    const config = described.body.config as Record<string, unknown>;
    expect(described.body.contents).toEqual(wire?.body.contents);
    // The SDK wraps the instruction string in a Content envelope.
    expect(wire?.body.systemInstruction).toEqual({
      role: "user",
      parts: [{ text: config.systemInstruction }],
    });
    expect(wire?.body.generationConfig).toEqual({
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
    });
    // The model rides in the URL for Gemini, which is why `path` interpolates
    // it where the other two adapters use a fixed string.
    expect(described.path).toContain(String(described.body.model));
    expect(wire?.url).toContain(described.path);
    // Same declared tools, modulo the SDK's schema-type uppercasing.
    const declared = (config.tools as { functionDeclarations: { name: string }[] }[])[0];
    const sent = (wire?.body.tools as { functionDeclarations: { name: string }[] }[])[0];
    expect(sent?.functionDeclarations.map((d) => d.name)).toEqual(
      declared?.functionDeclarations.map((d) => d.name),
    );
  });
});
