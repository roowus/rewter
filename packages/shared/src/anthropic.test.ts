import { describe, expect, it } from "vitest";
import {
  AnthropicMessagesRequestSchema,
  fromAnthropicMessages,
  fromAnthropicTools,
  toAnthropicStopReason,
  toAnthropicUsage,
} from "./anthropic.js";

describe("AnthropicMessagesRequestSchema", () => {
  const base = { model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 100 };

  it("accepts a minimal request and defaults stream to false", () => {
    const parsed = AnthropicMessagesRequestSchema.parse(base);
    expect(parsed.stream).toBe(false);
  });

  it("requires max_tokens, unlike OpenAI", () => {
    const { max_tokens: _omitted, ...withoutMax } = base;
    expect(AnthropicMessagesRequestSchema.safeParse(withoutMax).success).toBe(false);
  });

  it("rejects an empty message list", () => {
    expect(AnthropicMessagesRequestSchema.safeParse({ ...base, messages: [] }).success).toBe(false);
  });

  it("passes through knobs we do not forward rather than rejecting them", () => {
    // A client sending top_k or thinking must not get a 400 over a parameter we
    // merely don't use yet.
    const parsed = AnthropicMessagesRequestSchema.safeParse({
      ...base,
      top_k: 40,
      stop_sequences: ["\n"],
      thinking: { type: "enabled", budget_tokens: 1024 },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts unknown content block types instead of failing the request", () => {
    // Images and documents are dropped downstream (vision routing is M4), but
    // dropping is very different from 400-ing the whole conversation.
    const parsed = AnthropicMessagesRequestSchema.safeParse({
      ...base,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
            { type: "text", text: "what is this" },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("fromAnthropicMessages", () => {
  it("converts a plain string turn", () => {
    expect(fromAnthropicMessages([{ role: "user", content: "hi" }])).toEqual([
      { role: "user", content: "hi" },
    ]);
  });

  it("hoists a string system prompt to a leading system message", () => {
    const out = fromAnthropicMessages([{ role: "user", content: "hi" }], "be terse");
    expect(out[0]).toEqual({ role: "system", content: "be terse" });
  });

  it("joins system blocks with blank lines", () => {
    const out = fromAnthropicMessages(
      [{ role: "user", content: "hi" }],
      [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
    );
    expect(out[0]).toEqual({ role: "system", content: "one\n\ntwo" });
  });

  it("omits an empty system prompt rather than emitting a blank message", () => {
    expect(fromAnthropicMessages([{ role: "user", content: "hi" }], "")).toHaveLength(1);
  });

  it("concatenates multiple text blocks in one turn", () => {
    const out = fromAnthropicMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ]);
    expect(out).toEqual([{ role: "user", content: "ab" }]);
  });

  it("drops image blocks but keeps the rest of the turn", () => {
    const out = fromAnthropicMessages([
      {
        role: "user",
        content: [
          { type: "image", source: { data: "x" } },
          { type: "text", text: "describe it" },
        ],
      },
    ]);
    expect(out).toEqual([{ role: "user", content: "describe it" }]);
  });

  it("converts tool_use blocks to internal tool calls with stringified args", () => {
    const out = fromAnthropicMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
        ],
      },
    ]);
    expect(out).toEqual([
      {
        role: "assistant",
        content: "checking",
        toolCalls: [{ id: "toolu_1", name: "get_weather", arguments: '{"city":"Paris"}' }],
      },
    ]);
  });

  it("represents a tool-only assistant turn with null content", () => {
    const out = fromAnthropicMessages([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "f", input: {} }],
      },
    ]);
    expect(out[0]?.content).toBeNull();
  });

  it("explodes several tool_results in one user turn into separate messages", () => {
    // The shape mismatch that makes this a flatMap rather than a map: Anthropic
    // batches tool results into a single user turn, our format gives each one
    // its own message.
    const out = fromAnthropicMessages([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "sunny" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "17C" },
        ],
      },
    ]);
    expect(out).toEqual([
      { role: "tool", content: "sunny", toolCallId: "toolu_1" },
      { role: "tool", content: "17C", toolCallId: "toolu_2" },
    ]);
  });

  it("emits no user message for a turn that is only tool results", () => {
    const out = fromAnthropicMessages([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] },
    ]);
    expect(out.every((m) => m.role === "tool")).toBe(true);
  });

  it("orders tool results before the turn's own text", () => {
    // They answer the *previous* assistant turn; upstreams that pair calls to
    // results need them adjacent to the call, not after the new user text.
    const out = fromAnthropicMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "and now this" },
          { type: "tool_result", tool_use_id: "toolu_1", content: "sunny" },
        ],
      },
    ]);
    expect(out.map((m) => m.role)).toEqual(["tool", "user"]);
  });

  it("flattens a block-array tool_result to text", () => {
    const out = fromAnthropicMessages([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "line one " },
              { type: "text", text: "line two" },
            ],
          },
        ],
      },
    ]);
    expect(out[0]?.content).toBe("line one line two");
  });

  it("treats a tool_result with no content as empty rather than dropping it", () => {
    const out = fromAnthropicMessages([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1" }] },
    ]);
    expect(out).toEqual([{ role: "tool", content: "", toolCallId: "toolu_1" }]);
  });

  it("round-trips a full agent-loop conversation in order", () => {
    const out = fromAnthropicMessages(
      [
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { c: "Paris" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "17C" }],
        },
      ],
      "be terse",
    );
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
  });
});

describe("fromAnthropicTools", () => {
  it("returns undefined for absent or empty tool lists", () => {
    expect(fromAnthropicTools(undefined)).toBeUndefined();
    expect(fromAnthropicTools([])).toBeUndefined();
  });

  it("maps input_schema to parameters and defaults a missing description", () => {
    expect(
      fromAnthropicTools([{ name: "f", input_schema: { type: "object", properties: {} } }]),
    ).toEqual([{ name: "f", description: "", parameters: { type: "object", properties: {} } }]);
  });
});

describe("toAnthropicStopReason", () => {
  it("maps every internal finish reason", () => {
    expect(toAnthropicStopReason("stop")).toBe("end_turn");
    expect(toAnthropicStopReason("tool_calls")).toBe("tool_use");
    expect(toAnthropicStopReason("length")).toBe("max_tokens");
    expect(toAnthropicStopReason("content_filter")).toBe("refusal");
    // `error` has no Anthropic equivalent; end_turn is the honest fallback.
    expect(toAnthropicStopReason("error")).toBe("end_turn");
  });
});

describe("toAnthropicUsage", () => {
  const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

  it("omits cache fields when there is no cache activity", () => {
    expect(toAnthropicUsage(usage)).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("includes cache fields when non-zero", () => {
    expect(toAnthropicUsage({ ...usage, cacheReadTokens: 900, cacheWriteTokens: 100 })).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 100,
    });
  });
});
