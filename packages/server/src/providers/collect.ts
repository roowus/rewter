/**
 * Fold a normalized chunk stream into a ChatResponse. This is how every
 * adapter gets `complete()` for free, and — more importantly — it is the one
 * place that reassembles split tool-call argument deltas, so that logic is
 * tested once rather than per adapter.
 */
import type { ChatResponse, StreamChunk, ToolCall } from "@rewter/shared";
import { AdapterError } from "./types.js";

const EMPTY_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
} as const;

export async function collectStream(chunks: AsyncIterable<StreamChunk>): Promise<ChatResponse> {
  let text = "";
  /** Keyed by chunk `index` — upstreams interleave deltas for parallel calls. */
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let end: Extract<StreamChunk, { type: "message_end" }> | undefined;

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case "text_delta":
        text += chunk.text;
        break;
      case "tool_call_start":
        calls.set(chunk.index, { id: chunk.id, name: chunk.name, args: "" });
        break;
      case "tool_call_delta": {
        const call = calls.get(chunk.index);
        // A delta before its start means the adapter broke the contract.
        if (call === undefined) {
          throw new AdapterError(`tool_call_delta for unknown index ${chunk.index}`, false);
        }
        call.args += chunk.argumentsDelta;
        break;
      }
      case "message_end":
        end = chunk;
        break;
      case "error":
        throw new AdapterError(chunk.message, chunk.retryable, chunk.statusCode);
    }
  }

  if (end === undefined) {
    // Truncated stream: the upstream hung up before message_end.
    throw new AdapterError("stream ended without message_end", true);
  }

  const toolCalls: ToolCall[] = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, c]) => ({ id: c.id, name: c.name, arguments: c.args }));

  return {
    message: {
      role: "assistant",
      content: text === "" ? null : text,
      ...(toolCalls.length > 0 && { toolCalls }),
    },
    finishReason: end.finishReason,
    usage: end.usage ?? EMPTY_USAGE,
  };
}
