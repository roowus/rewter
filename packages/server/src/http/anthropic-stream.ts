/**
 * Internal StreamChunk → Anthropic Messages SSE events.
 *
 * Unlike the OpenAI translator next door, this one is **stateful**, and it has
 * to be. OpenAI frames are independent: each delta names its own choice and
 * tool index, so a pure function suffices. Anthropic's stream is a sequence of
 * *content blocks* that must be explicitly opened (`content_block_start`) and
 * closed (`content_block_stop`), at most one open at a time, with a running
 * index the client uses to assemble the message. Our internal grammar has no
 * such notion — text deltas simply arrive, and a tool call simply starts — so
 * something has to remember which block is open and close it before opening
 * the next. That bookkeeping is this class.
 *
 * Two consequences worth naming:
 *
 * - A tool call arriving after text closes the text block first. Emitting
 *   `content_block_start` while another block is open is a protocol violation
 *   that leaves clients assembling content into the wrong block.
 * - `message_start` must carry usage, but real input-token counts only arrive
 *   at `message_end`. We send zeros up front and the true totals in
 *   `message_delta`, which is what Anthropic itself does — the client adds them.
 */
import type {
  AnthropicStopReason,
  AnthropicStreamEvent,
  AnthropicUsage,
  StreamChunk,
} from "@rewter/shared";
import { toAnthropicStopReason, toAnthropicUsage } from "@rewter/shared";

export interface AnthropicFrameContext {
  id: string;
  model: string;
}

const ZERO_USAGE: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };

/**
 * Accumulates block state across a stream. One instance per request; the caller
 * feeds it chunks and writes whatever events come back, in order.
 */
export class AnthropicStreamTranslator {
  private index = -1;
  private open: "text" | "tool_use" | null = null;
  /** Anthropic requires a terminal stop reason even if the upstream dies. */
  private ended = false;

  constructor(private readonly ctx: AnthropicFrameContext) {}

  /** The opening event. Content is empty; usage is filled in at the end. */
  start(): AnthropicStreamEvent {
    return {
      type: "message_start",
      message: {
        id: this.ctx.id,
        type: "message",
        role: "assistant",
        model: this.ctx.model,
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: ZERO_USAGE,
      },
    };
  }

  /** Translate one internal chunk into zero or more Anthropic events. */
  next(chunk: StreamChunk): AnthropicStreamEvent[] {
    switch (chunk.type) {
      case "text_delta": {
        const out: AnthropicStreamEvent[] = [];
        if (this.open !== "text") {
          out.push(...this.closeOpen());
          this.index += 1;
          this.open = "text";
          out.push({
            type: "content_block_start",
            index: this.index,
            content_block: { type: "text", text: "" },
          });
        }
        out.push({
          type: "content_block_delta",
          index: this.index,
          delta: { type: "text_delta", text: chunk.text },
        });
        return out;
      }

      case "tool_call_start": {
        // Always a fresh block: a second tool call must not reuse the first's.
        const out = this.closeOpen();
        this.index += 1;
        this.open = "tool_use";
        out.push({
          type: "content_block_start",
          index: this.index,
          content_block: { type: "tool_use", id: chunk.id, name: chunk.name, input: {} },
        });
        return out;
      }

      case "tool_call_delta":
        // Arguments stream as raw JSON text; the client parses once at close.
        return [
          {
            type: "content_block_delta",
            index: this.index,
            delta: { type: "input_json_delta", partial_json: chunk.argumentsDelta },
          },
        ];

      case "message_end":
        return this.finish(
          toAnthropicStopReason(chunk.finishReason),
          toAnthropicUsage(chunk.usage),
        );

      case "error":
        // Headers are long gone, so there is no status code left to fail with.
        // Send Anthropic's own `error` event, then still terminate the message:
        // a client that ignores the error must not be left waiting forever.
        return [
          ...this.closeOpen(),
          { type: "error", error: { type: "api_error", message: chunk.message } },
          ...this.finish("end_turn", ZERO_USAGE),
        ];
    }
  }

  /**
   * Terminate a stream that ended without a terminal chunk — a caller-side
   * throw, say. Returns nothing if the message was already closed properly.
   */
  finishIfOpen(): AnthropicStreamEvent[] {
    if (this.ended) return [];
    return this.finish("end_turn", ZERO_USAGE);
  }

  private finish(stop: AnthropicStopReason, usage: AnthropicUsage): AnthropicStreamEvent[] {
    if (this.ended) return [];
    this.ended = true;
    return [
      ...this.closeOpen(),
      { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage },
      { type: "message_stop" },
    ];
  }

  private closeOpen(): AnthropicStreamEvent[] {
    if (this.open === null) return [];
    this.open = null;
    return [{ type: "content_block_stop", index: this.index }];
  }
}
