/**
 * Recorded upstream wire bytes, replayed through a stub `fetch`. Fixtures are
 * hand-trimmed captures of real responses — the point is that the adapters
 * parse what the upstreams *actually* send, including the awkward cases
 * (arguments split mid-token, a stream that just stops).
 *
 * Test-only module; nothing here is exported from the package entrypoint.
 */

/** Build an SSE body from pre-serialized `data:` lines. */
export function sse(lines: readonly string[], { done = true } = {}): string {
  const body = lines.map((l) => `data: ${l}\n\n`).join("");
  return done ? `${body}data: [DONE]\n\n` : body;
}

/** Anthropic frames events with a `event:` line before the data line. */
export function anthropicSse(events: readonly (readonly [string, string])[]): string {
  return events.map(([type, data]) => `event: ${type}\ndata: ${data}\n\n`).join("");
}

/**
 * A `fetch` that always answers with the given body. Streaming bodies are
 * chunked byte-wise at the boundaries the fixture defines, so parsers can't
 * accidentally rely on whole events arriving in one read.
 */
export function stubFetch(
  body: string,
  { status = 200, headers }: { status?: number; headers?: Record<string, string> } = {},
): typeof globalThis.fetch {
  return (async () => {
    const isSse = body.startsWith("event:") || body.startsWith("data:");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        // Split on event boundaries to exercise incremental parsing.
        const parts = isSse ? body.split(/(?<=\n\n)/) : [body];
        for (const part of parts) {
          if (part !== "") controller.enqueue(encoder.encode(part));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status,
      headers: {
        "content-type": isSse ? "text/event-stream" : "application/json",
        ...headers,
      },
    });
  }) as unknown as typeof globalThis.fetch;
}

/** A fetch whose body ends abruptly: bytes, then a reader error. */
export function truncatedFetch(body: string): typeof globalThis.fetch {
  return (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.error(new Error("socket hang up"));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof globalThis.fetch;
}

// ── OpenAI-compatible fixtures ───────────────────────────────────────────────

const oaiChunk = (delta: unknown, finish: string | null = null) =>
  JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

const oaiUsage = JSON.stringify({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "test-model",
  choices: [],
  usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } },
});

export const OPENAI_TEXT = sse([
  oaiChunk({ role: "assistant", content: "" }),
  oaiChunk({ content: "Hello" }),
  oaiChunk({ content: " world" }),
  oaiChunk({}, "stop"),
  oaiUsage,
]);

export const OPENAI_SPLIT_TOOL_ARGS = sse([
  oaiChunk({
    tool_calls: [
      {
        index: 0,
        id: "call_abc",
        type: "function",
        function: { name: "get_weather", arguments: "" },
      },
    ],
  }),
  // The classic trap: JSON split mid-key and mid-value.
  oaiChunk({ tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] }),
  oaiChunk({ tool_calls: [{ index: 0, function: { arguments: 'ty": "Par' } }] }),
  oaiChunk({ tool_calls: [{ index: 0, function: { arguments: 'is", "units": "cel' } }] }),
  oaiChunk({ tool_calls: [{ index: 0, function: { arguments: 'sius"}' } }] }),
  oaiChunk({}, "tool_calls"),
  oaiUsage,
]);

export const OPENAI_PARALLEL_TOOL_CALLS = sse([
  oaiChunk({
    tool_calls: [
      {
        index: 0,
        id: "call_a",
        type: "function",
        function: { name: "get_weather", arguments: "" },
      },
    ],
  }),
  oaiChunk({
    tool_calls: [
      { index: 1, id: "call_b", type: "function", function: { name: "get_time", arguments: "" } },
    ],
  }),
  oaiChunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
  oaiChunk({ tool_calls: [{ index: 1, function: { arguments: '{"tz":' } }] }),
  oaiChunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
  oaiChunk({ tool_calls: [{ index: 1, function: { arguments: '"UTC"}' } }] }),
  oaiChunk({}, "tool_calls"),
  oaiUsage,
]);

/** Stops after two text deltas — no finish_reason, no usage, no [DONE]. */
export const OPENAI_TRUNCATED = sse(
  [oaiChunk({ role: "assistant", content: "Hel" }), oaiChunk({ content: "lo" })],
  { done: false },
);

export const RATE_LIMIT_BODY = JSON.stringify({
  error: { message: "Rate limit reached", type: "rate_limit_error", code: "rate_limit_exceeded" },
});

// ── Anthropic fixtures ───────────────────────────────────────────────────────

const anthropicStart = (input = 12) =>
  JSON.stringify({
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [],
      stop_reason: null,
      usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: 4 },
    },
  });

export const ANTHROPIC_TEXT = anthropicSse([
  ["message_start", anthropicStart()],
  [
    "content_block_start",
    JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  ],
  [
    "content_block_delta",
    JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    }),
  ],
  [
    "content_block_delta",
    JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: " world" },
    }),
  ],
  ["content_block_stop", JSON.stringify({ type: "content_block_stop", index: 0 })],
  [
    "message_delta",
    JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 5 },
    }),
  ],
  ["message_stop", JSON.stringify({ type: "message_stop" })],
]);

export const ANTHROPIC_SPLIT_TOOL_ARGS = anthropicSse([
  ["message_start", anthropicStart()],
  [
    "content_block_start",
    JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_abc", name: "get_weather", input: {} },
    }),
  ],
  ...(['{"ci', 'ty": "Par', 'is", "units": "cel', 'sius"}'] as const).map(
    (partial) =>
      [
        "content_block_delta",
        JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: partial },
        }),
      ] as const,
  ),
  ["content_block_stop", JSON.stringify({ type: "content_block_stop", index: 0 })],
  [
    "message_delta",
    JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 5 },
    }),
  ],
  ["message_stop", JSON.stringify({ type: "message_stop" })],
]);

export const ANTHROPIC_PARALLEL_TOOL_CALLS = anthropicSse([
  ["message_start", anthropicStart()],
  [
    "content_block_start",
    JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_a", name: "get_weather", input: {} },
    }),
  ],
  [
    "content_block_delta",
    JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"city": "Paris"}' },
    }),
  ],
  ["content_block_stop", JSON.stringify({ type: "content_block_stop", index: 0 })],
  [
    "content_block_start",
    JSON.stringify({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_b", name: "get_time", input: {} },
    }),
  ],
  [
    "content_block_delta",
    JSON.stringify({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"tz": "UTC"}' },
    }),
  ],
  ["content_block_stop", JSON.stringify({ type: "content_block_stop", index: 1 })],
  [
    "message_delta",
    JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 7 },
    }),
  ],
  ["message_stop", JSON.stringify({ type: "message_stop" })],
]);

/** message_start plus one delta, then the socket dies — no message_stop. */
export const ANTHROPIC_TRUNCATED = anthropicSse([
  ["message_start", anthropicStart()],
  [
    "content_block_start",
    JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  ],
  [
    "content_block_delta",
    JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hel" },
    }),
  ],
]);

export const ANTHROPIC_RATE_LIMIT_BODY = JSON.stringify({
  type: "error",
  error: { type: "rate_limit_error", message: "Number of requests has exceeded your rate limit" },
});

// ── Google (Gemini) fixtures ─────────────────────────────────────────────────

/**
 * Gemini streams `?alt=sse` with plain `data:` lines and no `event:` framing.
 * Usage rides on the final chunk; unlike the other two upstreams there is no
 * `[DONE]` sentinel — the body simply ends.
 */
const geminiChunk = (
  parts: unknown[],
  { finishReason = null, usage = false }: { finishReason?: string | null; usage?: boolean } = {},
) =>
  JSON.stringify({
    candidates: [
      {
        content: { role: "model", parts },
        ...(finishReason !== null && { finishReason }),
      },
    ],
    ...(usage && {
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 5,
        cachedContentTokenCount: 4,
      },
    }),
  });

export const GOOGLE_TEXT = sse(
  [
    geminiChunk([{ text: "Hello" }]),
    geminiChunk([{ text: " world" }], { finishReason: "STOP", usage: true }),
  ],
  { done: false },
);

/**
 * Gemini never splits function-call arguments — `args` arrives as one parsed
 * object. The adapter synthesizes a single tool_call_delta from it, which is
 * exactly the case the contract's reassembly assertion has to cover too.
 */
export const GOOGLE_SPLIT_TOOL_ARGS = sse(
  [
    geminiChunk(
      [{ functionCall: { name: "get_weather", args: { city: "Paris", units: "celsius" } } }],
      { finishReason: "STOP", usage: true },
    ),
  ],
  { done: false },
);

export const GOOGLE_PARALLEL_TOOL_CALLS = sse(
  [
    geminiChunk([{ functionCall: { name: "get_weather", args: { city: "Paris" } } }]),
    geminiChunk([{ functionCall: { name: "get_time", args: { tz: "UTC" } } }], {
      finishReason: "STOP",
      usage: true,
    }),
  ],
  { done: false },
);

/** One text delta, then the socket dies — no finishReason, no usage. */
export const GOOGLE_TRUNCATED = sse([geminiChunk([{ text: "Hel" }])], { done: false });

export const GOOGLE_RATE_LIMIT_BODY = JSON.stringify({
  error: { code: 429, message: "Resource has been exhausted", status: "RESOURCE_EXHAUSTED" },
});
