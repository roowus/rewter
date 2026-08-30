import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "./anthropic.js";
import { collectStream } from "./collect.js";
import { describeAdapterContract } from "./contract.js";
import {
  ANTHROPIC_PARALLEL_TOOL_CALLS,
  ANTHROPIC_RATE_LIMIT_BODY,
  ANTHROPIC_SPLIT_TOOL_ARGS,
  ANTHROPIC_TEXT,
  ANTHROPIC_TRUNCATED,
  stubFetch,
  truncatedFetch,
} from "./fixtures.js";

const make = (fetch: typeof globalThis.fetch) =>
  new AnthropicAdapter({ apiKey: "test", baseUrl: "https://upstream.test", fetch });

describeAdapterContract("anthropic", {
  text: { adapter: () => make(stubFetch(ANTHROPIC_TEXT)) },
  splitToolArgs: { adapter: () => make(stubFetch(ANTHROPIC_SPLIT_TOOL_ARGS)) },
  parallelToolCalls: { adapter: () => make(stubFetch(ANTHROPIC_PARALLEL_TOOL_CALLS)) },
  httpError: { adapter: () => make(stubFetch(ANTHROPIC_RATE_LIMIT_BODY, { status: 429 })) },
  truncated: { adapter: () => make(truncatedFetch(ANTHROPIC_TRUNCATED)) },
});

describe("anthropic specifics", () => {
  function recordingFetch(responseBody: string) {
    const seen: { body: Record<string, unknown> }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return stubFetch(responseBody)(url as string, init);
    }) as unknown as typeof globalThis.fetch;
    return { seen, fetch };
  }

  it("hoists leading system messages into the top-level system parameter", async () => {
    const rec = recordingFetch(ANTHROPIC_TEXT);
    await collectStream(
      new AnthropicAdapter({
        apiKey: "k",
        baseUrl: "https://upstream.test",
        fetch: rec.fetch,
      }).stream({
        model: "claude",
        messages: [
          { role: "system", content: "static core" },
          { role: "system", content: "registry digest" },
          { role: "user", content: "hi" },
        ],
      }),
    );
    const body = rec.seen[0]?.body;
    expect(body?.system).toEqual([
      { type: "text", text: "static core" },
      { type: "text", text: "registry digest" },
    ]);
    // System messages must NOT also appear in messages.
    expect(body?.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("tags a mid-conversation system message rather than demoting it silently", async () => {
    const rec = recordingFetch(ANTHROPIC_TEXT);
    await collectStream(
      new AnthropicAdapter({
        apiKey: "k",
        baseUrl: "https://upstream.test",
        fetch: rec.fetch,
      }).stream({
        model: "claude",
        messages: [
          { role: "system", content: "static core" },
          { role: "user", content: "hi" },
          // Legal in the OpenAI dialect this router accepts, and Claude Code is
          // one of the clients that injects one.
          { role: "system", content: "respond only in JSON from here on" },
          { role: "user", content: "go" },
        ],
      }),
    );
    const body = rec.seen[0]?.body;
    // Only the leading one is hoistable — the API's `system` slot is positional.
    expect(body?.system).toEqual([{ type: "text", text: "static core" }]);
    // The later one rides as a user turn because there is no other slot, but it
    // says what it is: an instruction the model should follow, not a request it
    // can negotiate with.
    expect(body?.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "[SYSTEM] respond only in JSON from here on" },
      { role: "user", content: "go" },
    ]);
  });

  it("cacheUpToMessage puts a cache_control breakpoint on the last system block", async () => {
    const rec = recordingFetch(ANTHROPIC_TEXT);
    await collectStream(
      new AnthropicAdapter({
        apiKey: "k",
        baseUrl: "https://upstream.test",
        fetch: rec.fetch,
      }).stream({
        model: "claude",
        messages: [
          { role: "system", content: "static core" },
          { role: "system", content: "registry digest" },
          { role: "user", content: "hi" },
        ],
        cacheUpToMessage: 1,
      }),
    );
    const system = rec.seen[0]?.body.system as Record<string, unknown>[];
    expect(system[0]?.cache_control).toBeUndefined();
    // The digest is the expensive, stable prefix — that's the breakpoint.
    expect(system[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("converts tool results into user-role tool_result blocks, merging consecutive ones", async () => {
    const rec = recordingFetch(ANTHROPIC_TEXT);
    await collectStream(
      new AnthropicAdapter({
        apiKey: "k",
        baseUrl: "https://upstream.test",
        fetch: rec.fetch,
      }).stream({
        model: "claude",
        messages: [
          { role: "user", content: "weather and time?" },
          {
            role: "assistant",
            content: null,
            toolCalls: [
              { id: "toolu_a", name: "get_weather", arguments: '{"city":"Paris"}' },
              { id: "toolu_b", name: "get_time", arguments: '{"tz":"UTC"}' },
            ],
          },
          { role: "tool", content: "18C", toolCallId: "toolu_a" },
          { role: "tool", content: "12:00", toolCallId: "toolu_b" },
        ],
      }),
    );
    const messages = rec.seen[0]?.body.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(3);
    expect(messages[1]?.content).toEqual([
      { type: "tool_use", id: "toolu_a", name: "get_weather", input: { city: "Paris" } },
      { type: "tool_use", id: "toolu_b", name: "get_time", input: { tz: "UTC" } },
    ]);
    // Anthropic requires consecutive tool results in ONE user turn.
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_a", content: "18C" },
        { type: "tool_result", tool_use_id: "toolu_b", content: "12:00" },
      ],
    });
  });

  it("malformed model-authored tool arguments degrade to {} instead of throwing", async () => {
    const rec = recordingFetch(ANTHROPIC_TEXT);
    await collectStream(
      new AnthropicAdapter({
        apiKey: "k",
        baseUrl: "https://upstream.test",
        fetch: rec.fetch,
      }).stream({
        model: "claude",
        messages: [
          {
            role: "assistant",
            content: null,
            toolCalls: [{ id: "toolu_a", name: "f", arguments: "{not json" }],
          },
        ],
      }),
    );
    const messages = rec.seen[0]?.body.messages as Record<string, unknown>[];
    expect((messages[0]?.content as Record<string, unknown>[])[0]?.input).toEqual({});
  });

  it("reports cache read/write tokens separately", async () => {
    const response = await collectStream(
      make(stubFetch(ANTHROPIC_TEXT)).stream({
        model: "claude",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(response.usage.inputTokens).toBe(12);
    expect(response.usage.cacheReadTokens).toBe(4);
    expect(response.usage.outputTokens).toBe(5);
  });

  it("requires max_tokens upstream — a default is supplied when the caller omits it", async () => {
    const rec = recordingFetch(ANTHROPIC_TEXT);
    await collectStream(
      new AnthropicAdapter({
        apiKey: "k",
        baseUrl: "https://upstream.test",
        fetch: rec.fetch,
      }).stream({
        model: "claude",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(rec.seen[0]?.body.max_tokens).toBeGreaterThan(0);
  });

  /**
   * The anti-drift check the dialect panel rests on. Everything else asserts
   * that `describeRequest` is *shaped* right; this asserts it is the *same
   * bytes* the upstream received. If the two ever diverge, the panel becomes a
   * confident description of a request nobody sent — the worst possible
   * outcome for a debugging tool.
   */
  it("describeRequest matches the body that actually went on the wire", async () => {
    const rec = recordingFetch(ANTHROPIC_TEXT);
    const adapter = new AnthropicAdapter({
      apiKey: "k",
      baseUrl: "https://upstream.test",
      fetch: rec.fetch,
    });
    const req = {
      model: "claude",
      messages: [
        { role: "system" as const, content: "core" },
        { role: "user" as const, content: "hi" },
        {
          role: "assistant" as const,
          content: null,
          toolCalls: [{ id: "t1", name: "f", arguments: '{"a":1}' }],
        },
        { role: "tool" as const, content: "42", toolCallId: "t1" },
      ],
      tools: [{ name: "f", description: "d", parameters: { type: "object" } }],
      maxTokens: 100,
      temperature: 0.5,
      cacheUpToMessage: 0,
    };

    const described = adapter.describeRequest(req);
    await collectStream(adapter.stream(req));

    expect(described.body).toEqual(rec.seen[0]?.body);
  });
});
