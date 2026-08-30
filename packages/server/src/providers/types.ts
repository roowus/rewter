/**
 * The provider adapter seam. Three implementations cover all seven upstreams:
 * `anthropic` (native SDK), `openai-compat` (OpenAI, OpenRouter, xAI, Z.AI,
 * Ollama, LM Studio — parameterized by baseUrl + quirks) and `google`.
 *
 * Adapters translate wire formats only. Retry, fallback, cost recording and
 * model resolution live in the router layer above them — an adapter never
 * decides *whether* to call, only *how*.
 */
import type {
  ChatMessage,
  ChatResponse,
  ProviderKind,
  StreamChunk,
  ToolDefinition,
} from "@rewter/shared";

/** One upstream call. `model` is the *upstream* id, already resolved from our slug. */
export interface AdapterRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  /**
   * Prompt-caching breakpoint: cache everything up to and including this
   * 0-based message index. Adapters without cache control ignore it.
   */
  cacheUpToMessage?: number;
}

/**
 * Per-upstream deviations from the baseline wire format. Every quirk here
 * exists because some real upstream needs it — no speculative knobs.
 */
export interface Quirks {
  /** Local runtimes (Ollama, LM Studio) may omit usage entirely on streams. */
  usageOptional?: boolean;
  /** Newer OpenAI models require `max_completion_tokens` over `max_tokens`. */
  maxCompletionTokens?: boolean;
  /** Upstreams that reject `stream_options: { include_usage: true }`. */
  noStreamOptions?: boolean;
}

export interface AdapterConfig {
  /** Resolved secret value. Only the env var *name* is ever persisted. */
  apiKey: string | null;
  baseUrl?: string | null;
  quirks?: Quirks;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  /**
   * Normalized chunk stream. Contract (enforced by describeAdapterContract):
   *   (text_delta | tool_call_start | tool_call_delta)* → message_end
   * or a terminating `error` chunk. Exactly one terminal chunk, always last.
   */
  stream(req: AdapterRequest, signal?: AbortSignal): AsyncIterable<StreamChunk>;
  /** Non-streaming call. Defaults to folding `stream()`; adapters may override. */
  complete(req: AdapterRequest, signal?: AbortSignal): Promise<ChatResponse>;
  /**
   * The body this adapter *would* put on the wire, without sending it.
   *
   * Exists for the dialect panel, which shows a request at all three stages —
   * as the client sent it, as `ChatMessage[]`, and as the upstream would
   * receive it. The third stage is the one that catches real bugs, and it is
   * only worth showing if it is the truth: so `stream()` builds its body by
   * calling this, rather than the two constructing the same object twice and
   * drifting.
   *
   * Never contains credentials. The key rides in a header (or, for Google, a
   * query parameter) that the SDK attaches at call time — none of it is in the
   * body, so nothing here needs redacting.
   */
  describeRequest(req: AdapterRequest): UpstreamRequest;
}

/** One outbound call, as JSON, for display rather than for sending. */
export interface UpstreamRequest {
  /** Which of the three translations produced this — not the provider's name. */
  kind: ProviderKind;
  /**
   * Path relative to the provider's base URL. Written out rather than derived,
   * because the SDKs own the real URL and a guess that looked plausible would
   * be worse than no line at all.
   */
  path: string;
  body: Record<string, unknown>;
}

/** Thrown by `collectStream` when the upstream terminated with an error chunk. */
export class AdapterError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly statusCode: number | null = null,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

/** HTTP statuses worth another attempt. Everything else is the caller's fault. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export function isRetryableStatus(status: number | null | undefined): boolean {
  return status === null || status === undefined ? true : RETRYABLE_STATUS.has(status);
}

/**
 * Normalize anything thrown by an SDK into the `error` chunk shape. Network
 * failures (no status) are retryable; aborts are not — a cancelled task must
 * not be retried back to life.
 */
export function toErrorChunk(err: unknown): Extract<StreamChunk, { type: "error" }> {
  if (isAbort(err)) {
    return { type: "error", message: "request aborted", retryable: false, statusCode: null };
  }
  const statusCode = extractStatus(err);
  const message = err instanceof Error ? err.message : String(err);
  return { type: "error", message, retryable: isRetryableStatus(statusCode), statusCode };
}

function isAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.message.toLowerCase().includes("abort"))
  );
}

function extractStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") return status;
  const code = (err as { statusCode?: unknown }).statusCode;
  return typeof code === "number" ? code : null;
}
