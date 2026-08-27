import { describe, expect, it } from "vitest";
import { ChatRequestSchema, StreamChunkSchema, UsageSchema } from "./chat.js";

describe("chat contracts", () => {
  it("ChatRequest defaults stream to false and requires messages", () => {
    const req = ChatRequestSchema.parse({
      modelId: "zai/glm-5.3",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(req.stream).toBe(false);
    expect(() => ChatRequestSchema.parse({ modelId: "x", messages: [] })).toThrow();
  });

  it("StreamChunk discriminates on type", () => {
    expect(StreamChunkSchema.parse({ type: "text_delta", text: "he" }).type).toBe("text_delta");
    expect(
      StreamChunkSchema.parse({ type: "tool_call_start", index: 0, id: "c1", name: "spawn_worker" })
        .type,
    ).toBe("tool_call_start");
    const end = StreamChunkSchema.parse({
      type: "message_end",
      finishReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(end.type === "message_end" && end.finishReason).toBe("tool_calls");
    const err = StreamChunkSchema.parse({
      type: "error",
      message: "429",
      retryable: true,
      statusCode: 429,
    });
    expect(err.type === "error" && err.retryable).toBe(true);
    expect(() => StreamChunkSchema.parse({ type: "mystery" })).toThrow();
  });

  it("Usage defaults cache tokens to 0", () => {
    expect(UsageSchema.parse({ inputTokens: 1, outputTokens: 1 })).toEqual({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});
