import type { StreamChunk } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { end, err, text, toolDelta, toolStart } from "../testing/fake-adapter.js";
import { type StreamFrameContext, roleFrame, toOpenAIChunk } from "./openai-stream.js";

const CTX: StreamFrameContext = {
  id: "chatcmpl-abc",
  model: "anthropic/claude-sonnet-5",
  created: 1_756_252_800,
};

const convert = (chunk: StreamChunk, includeUsage = false) =>
  toOpenAIChunk(chunk, CTX, { includeUsage });

describe("roleFrame", () => {
  it("opens with a role-only delta", () => {
    // Clients that render an empty assistant bubble depend on this arriving first.
    expect(roleFrame(CTX)).toEqual({
      id: CTX.id,
      object: "chat.completion.chunk",
      created: CTX.created,
      model: CTX.model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
  });
});

describe("toOpenAIChunk", () => {
  it("carries the same envelope on every frame", () => {
    for (const chunk of [text("a"), end(), err("x", false, 500)]) {
      expect(convert(chunk)).toMatchObject({
        id: CTX.id,
        object: "chat.completion.chunk",
        created: CTX.created,
        model: CTX.model,
      });
    }
  });

  it("maps a text delta to a content delta", () => {
    expect(convert(text("hello"))?.choices[0]).toEqual({
      index: 0,
      delta: { content: "hello" },
      finish_reason: null,
    });
  });

  it("opens a tool call with a name and empty arguments", () => {
    // OpenAI's grammar puts the name on the opening frame only; arguments
    // accumulate from the deltas that follow.
    expect(convert(toolStart(0, "call_1", "read_file"))?.choices[0]?.delta.tool_calls).toEqual([
      { index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } },
    ]);
  });

  it("continues a tool call with arguments only", () => {
    expect(convert(toolDelta(0, '{"path":'))?.choices[0]?.delta.tool_calls).toEqual([
      { index: 0, function: { arguments: '{"path":' } },
    ]);
  });

  it("preserves the tool index across a multi-call fan-out", () => {
    expect(convert(toolDelta(2, "x"))?.choices[0]?.delta.tool_calls?.[0]?.index).toBe(2);
  });

  it("maps message_end to a finish reason with an empty delta", () => {
    expect(convert(end("tool_calls"))?.choices[0]).toEqual({
      index: 0,
      delta: {},
      finish_reason: "tool_calls",
    });
  });

  it("omits usage unless the client asked for it", () => {
    expect(convert(end())?.usage).toBeUndefined();
    const withUsage = convert(end("stop", { cacheReadTokens: 40 }), true);
    expect(withUsage?.usage).toEqual({
      // Cache tokens are prompt tokens; OpenAI reports them inside the total.
      prompt_tokens: 1_040,
      completion_tokens: 500,
      total_tokens: 1_540,
      prompt_tokens_details: { cached_tokens: 40 },
    });
  });

  it("delivers a mid-stream error as a terminal frame, not a hang", () => {
    // OpenAI has no error frame; after headers there is no status code left, so
    // the failure rides on a well-formed final chunk.
    const frame = convert(err("upstream exploded", true, 503));
    expect(frame?.choices[0]).toEqual({ index: 0, delta: {}, finish_reason: "stop" });
    expect(frame?.error).toEqual({
      message: "upstream exploded",
      type: "upstream_error",
      code: 503,
    });
  });

  it("never leaks the internal `error` finish reason onto the wire", () => {
    expect(convert(end("error"))?.choices[0]?.finish_reason).toBe("stop");
  });
});
