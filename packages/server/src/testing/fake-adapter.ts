/**
 * A `ProviderAdapter` that replays scripted chunk sequences instead of talking
 * to an upstream. One script per attempt, so retry behaviour is expressible:
 * `[[retryableError], [text, end]]` is "fails once, then succeeds".
 *
 * Test-only module; nothing here is exported from the package entrypoint.
 */
import type { ChatResponse, FinishReason, ProviderKind, StreamChunk, Usage } from "@rewter/shared";
import { collectStream } from "../providers/collect.js";
import type { AdapterRequest, ProviderAdapter } from "../providers/types.js";

export interface FakeAdapterOptions {
  kind?: ProviderKind;
  /** Throw (rather than yield an error chunk) on the nth attempt, 1-based. */
  throwOnAttempt?: number;
}

export class FakeAdapter implements ProviderAdapter {
  readonly kind: ProviderKind;
  /** Every request this adapter instance saw — assert on what went upstream. */
  readonly requests: AdapterRequest[] = [];
  attempts = 0;

  constructor(
    private readonly scripts: StreamChunk[][],
    private readonly opts: FakeAdapterOptions = {},
  ) {
    this.kind = opts.kind ?? "openai-compat";
  }

  async *stream(req: AdapterRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    this.attempts += 1;
    this.requests.push(req);
    if (this.opts.throwOnAttempt === this.attempts) {
      throw new Error("adapter exploded");
    }
    // Past the end of the script, keep replaying the last one: a test that only
    // cares about the first two attempts shouldn't have to pad the array.
    const script = this.scripts[Math.min(this.attempts - 1, this.scripts.length - 1)] ?? [];
    for (const chunk of script) {
      if (signal?.aborted === true) {
        yield { type: "error", message: "request aborted", retryable: false, statusCode: null };
        return;
      }
      yield chunk;
    }
  }

  async complete(req: AdapterRequest, signal?: AbortSignal): Promise<ChatResponse> {
    return collectStream(this.stream(req, signal));
  }
}

// ── Chunk shorthands ────────────────────────────────────────────────────────

export const text = (t: string): StreamChunk => ({ type: "text_delta", text: t });

export const usage = (over: Partial<Usage> = {}): Usage => ({
  inputTokens: 1_000,
  outputTokens: 500,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

export const end = (
  finishReason: FinishReason = "stop",
  over: Partial<Usage> = {},
): StreamChunk => ({ type: "message_end", finishReason, usage: usage(over) });

export const err = (
  message: string,
  retryable: boolean,
  statusCode: number | null = null,
): StreamChunk => ({ type: "error", message, retryable, statusCode });

export const toolStart = (index: number, id: string, name: string): StreamChunk => ({
  type: "tool_call_start",
  index,
  id,
  name,
});

export const toolDelta = (index: number, argumentsDelta: string): StreamChunk => ({
  type: "tool_call_delta",
  index,
  argumentsDelta,
});
