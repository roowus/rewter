/**
 * Internal StreamChunk → OpenAI `chat.completion.chunk` frames.
 *
 * The two grammars differ in one significant way: our contract lets an `error`
 * terminate a stream, and OpenAI's has no such frame. Once headers are sent
 * there is no status code left to use either, so an error that arrives
 * mid-stream is delivered as a final chunk carrying an `error` field alongside
 * `finish_reason: "stop"`. Clients that check for it see the failure; clients
 * that don't at least get a well-formed termination instead of a hang.
 */
import type { OpenAIChatChunk, StreamChunk } from "@rewter/shared";
import { toOpenAIFinishReason, toOpenAIUsage } from "@rewter/shared";

export interface StreamFrameContext {
  id: string;
  model: string;
  created: number;
}

/** The opening frame: role only, no content. Every OpenAI client expects it. */
export function roleFrame(ctx: StreamFrameContext): OpenAIChatChunk {
  return {
    ...envelope(ctx),
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  };
}

/**
 * Translate one internal chunk. Returns null for chunks with no wire
 * equivalent, and the caller supplies `[DONE]` after the terminal frame.
 */
export function toOpenAIChunk(
  chunk: StreamChunk,
  ctx: StreamFrameContext,
  opts: { includeUsage?: boolean } = {},
): OpenAIChatChunk | null {
  switch (chunk.type) {
    case "text_delta":
      return {
        ...envelope(ctx),
        choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }],
      };

    case "tool_call_start":
      return {
        ...envelope(ctx),
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: chunk.index,
                  id: chunk.id,
                  type: "function",
                  // Arguments open empty; deltas fill them in.
                  function: { name: chunk.name, arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };

    case "tool_call_delta":
      return {
        ...envelope(ctx),
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: chunk.index, function: { arguments: chunk.argumentsDelta } }],
            },
            finish_reason: null,
          },
        ],
      };

    case "message_end":
      return {
        ...envelope(ctx),
        choices: [{ index: 0, delta: {}, finish_reason: toOpenAIFinishReason(chunk.finishReason) }],
        ...(opts.includeUsage === true && { usage: toOpenAIUsage(chunk.usage) }),
      };

    case "error":
      // No OpenAI frame means "the stream broke"; this is the least-bad shape.
      return {
        ...envelope(ctx),
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        error: { message: chunk.message, type: "upstream_error", code: chunk.statusCode },
      };
  }
}

function envelope(ctx: StreamFrameContext): Omit<OpenAIChatChunk, "choices"> {
  return {
    id: ctx.id,
    object: "chat.completion.chunk",
    created: ctx.created,
    model: ctx.model,
  };
}
