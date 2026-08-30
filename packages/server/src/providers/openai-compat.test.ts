import { describe, expect, it } from "vitest";
import { collectStream } from "./collect.js";
import { describeAdapterContract } from "./contract.js";
import {
  OPENAI_PARALLEL_TOOL_CALLS,
  OPENAI_SPLIT_TOOL_ARGS,
  OPENAI_TEXT,
  OPENAI_TRUNCATED,
  RATE_LIMIT_BODY,
  stubFetch,
  truncatedFetch,
} from "./fixtures.js";
import { OpenAICompatAdapter } from "./openai-compat.js";

const make = (fetch: typeof globalThis.fetch) =>
  new OpenAICompatAdapter({ apiKey: "test", baseUrl: "https://upstream.test/v1", fetch });

describeAdapterContract("openai-compat", {
  text: { adapter: () => make(stubFetch(OPENAI_TEXT)) },
  splitToolArgs: { adapter: () => make(stubFetch(OPENAI_SPLIT_TOOL_ARGS)) },
  parallelToolCalls: { adapter: () => make(stubFetch(OPENAI_PARALLEL_TOOL_CALLS)) },
  httpError: { adapter: () => make(stubFetch(RATE_LIMIT_BODY, { status: 429 })) },
  truncated: { adapter: () => make(truncatedFetch(OPENAI_TRUNCATED)) },
});

describe("openai-compat specifics", () => {
  /** Capture the outgoing request body so wire-shape assertions are possible. */
  function recordingFetch(responseBody: string) {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return stubFetch(responseBody)(url as string, init);
    }) as unknown as typeof globalThis.fetch;
    return { seen, fetch };
  }

  it("sends max_tokens by default and max_completion_tokens under the quirk", async () => {
    const plain = recordingFetch(OPENAI_TEXT);
    await collectStream(
      new OpenAICompatAdapter({
        apiKey: "k",
        baseUrl: "https://upstream.test/v1",
        fetch: plain.fetch,
      }).stream({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 }),
    );
    expect(plain.seen[0]?.body.max_tokens).toBe(100);
    expect(plain.seen[0]?.body.max_completion_tokens).toBeUndefined();

    const quirked = recordingFetch(OPENAI_TEXT);
    await collectStream(
      new OpenAICompatAdapter({
        apiKey: "k",
        baseUrl: "https://upstream.test/v1",
        quirks: { maxCompletionTokens: true },
        fetch: quirked.fetch,
      }).stream({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 }),
    );
    expect(quirked.seen[0]?.body.max_completion_tokens).toBe(100);
    expect(quirked.seen[0]?.body.max_tokens).toBeUndefined();
  });

  it("omits stream_options for upstreams that reject it", async () => {
    const withOptions = recordingFetch(OPENAI_TEXT);
    await collectStream(
      new OpenAICompatAdapter({
        apiKey: "k",
        baseUrl: "https://upstream.test/v1",
        fetch: withOptions.fetch,
      }).stream({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(withOptions.seen[0]?.body.stream_options).toEqual({ include_usage: true });

    const without = recordingFetch(OPENAI_TEXT);
    await collectStream(
      new OpenAICompatAdapter({
        apiKey: "k",
        baseUrl: "https://upstream.test/v1",
        quirks: { noStreamOptions: true },
        fetch: without.fetch,
      }).stream({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(without.seen[0]?.body.stream_options).toBeUndefined();
  });

  it("maps tool and assistant messages onto the OpenAI wire shape", async () => {
    const rec = recordingFetch(OPENAI_TEXT);
    await collectStream(
      new OpenAICompatAdapter({
        apiKey: "k",
        baseUrl: "https://upstream.test/v1",
        fetch: rec.fetch,
      }).stream({
        model: "m",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            toolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' }],
          },
          { role: "tool", content: "18C", toolCallId: "call_1" },
        ],
        tools: [{ name: "get_weather", description: "look up weather", parameters: {} }],
      }),
    );

    const messages = rec.seen[0]?.body.messages as Record<string, unknown>[];
    // System stays a message here (unlike Anthropic/Google).
    expect(messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(messages[2]?.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      },
    ]);
    expect(messages[3]).toEqual({ role: "tool", content: "18C", tool_call_id: "call_1" });
    expect((rec.seen[0]?.body.tools as unknown[])?.[0]).toMatchObject({ type: "function" });
  });

  it("reports cached prompt tokens as cacheReadTokens", async () => {
    const response = await collectStream(
      make(stubFetch(OPENAI_TEXT)).stream({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(response.usage.cacheReadTokens).toBe(4);
    expect(response.usage.inputTokens).toBe(12);
  });

  it("local runtimes may omit usage entirely (usageOptional quirk)", async () => {
    // Same fixture minus the trailing usage-only chunk.
    const noUsage = `${OPENAI_TEXT.split("data: {").slice(0, -1).join("data: {")}data: [DONE]\n\n`;
    const adapter = new OpenAICompatAdapter({
      apiKey: null,
      baseUrl: "http://localhost:11434/v1",
      quirks: { usageOptional: true, noStreamOptions: true },
      fetch: stubFetch(noUsage),
    });
    const response = await collectStream(
      adapter.stream({ model: "llama", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(response.message.content).toBe("Hello world");
    expect(response.usage.inputTokens).toBe(0);
  });

  it("without the quirk, a missing usage block is a retryable error", async () => {
    const noUsage = `${OPENAI_TEXT.split("data: {").slice(0, -1).join("data: {")}data: [DONE]\n\n`;
    const chunks = [];
    for await (const c of make(stubFetch(noUsage)).stream({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(c);
    }
    const last = chunks.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type !== "error") throw new Error("unreachable");
    expect(last.retryable).toBe(true);
  });

  /**
   * The anti-drift check the dialect panel rests on. Everything else asserts
   * that `describeRequest` is *shaped* right; this asserts it is the *same
   * bytes* the upstream received. If the two ever diverge, the panel becomes a
   * confident description of a request nobody sent — the worst possible
   * outcome for a debugging tool.
   */
  it("describeRequest matches the body that actually went on the wire", async () => {
    const rec = recordingFetch(OPENAI_TEXT);
    const adapter = new OpenAICompatAdapter({
      apiKey: "k",
      baseUrl: "https://upstream.test/v1",
      fetch: rec.fetch,
    });
    const req = {
      model: "m",
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
    };

    const described = adapter.describeRequest(req);
    await collectStream(adapter.stream(req));

    expect(described.body).toEqual(rec.seen[0]?.body);
    // The path is relative to the configured base URL, not a second guess at it.
    expect(rec.seen[0]?.url).toBe(`https://upstream.test/v1${described.path}`);
  });
});
