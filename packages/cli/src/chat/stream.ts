/**
 * Start a task and read its feed.
 *
 * One POST to `/v1/chat/completions` with `stream: true` is the whole start
 * protocol: the task id arrives in the `x-rewter-task-id` response header —
 * available before the first body byte, which is what lets the prompt line go
 * live (and steer) while the model is still thinking — and the body is the
 * OpenAI SSE feed the orchestrator narrates into.
 *
 * The generator yields typed events rather than raw frames because the two
 * non-obvious cases live at this layer and nowhere else should know about
 * them: the `[DONE]` sentinel, and the daemon's error-on-the-final-frame
 * convention — once SSE headers are sent there is no status code left, so a
 * mid-stream failure rides an `error` field on a well-formed last chunk.
 */
import { TASK_ID_HEADER } from "@rewter/server";
import type { OpenAIChatChunk, OpenAIMessage, OpenAIUsage } from "@rewter/shared";
import type { Connection } from "./client.js";
import { createSseParser } from "./sse.js";

export type FeedEvent =
  | { type: "text"; text: string }
  | { type: "usage"; usage: OpenAIUsage }
  | { type: "error"; message: string }
  | { type: "done" };

export interface ChatStream {
  /** From the response header — known before any body bytes arrive. */
  taskId: string | undefined;
  events: AsyncGenerator<FeedEvent, void, undefined>;
}

export interface StartChatOptions {
  model: string;
  messages: OpenAIMessage[];
  /** Routed via the x-rewter-project header; the daemon validates the slug. */
  project?: string;
  signal?: AbortSignal;
}

export class ChatStartError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatStartError";
  }
}

/** POST the conversation; throw on a pre-stream refusal, stream otherwise. */
export async function startChat(
  conn: Connection,
  fetchImpl: typeof globalThis.fetch,
  opts: StartChatOptions,
): Promise<ChatStream> {
  const res = await fetchImpl(`${conn.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      ...conn.headers,
      "content-type": "application/json",
      ...(opts.project !== undefined && { "x-rewter-project": opts.project }),
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: true,
      stream_options: { include_usage: true },
    }),
    ...(opts.signal !== undefined && { signal: opts.signal }),
  });

  if (!res.ok || res.body === null) {
    let message = `daemon returned ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (typeof body.error?.message === "string") message = body.error.message;
    } catch {
      // keep the status-code message
    }
    throw new ChatStartError(res.status, message);
  }

  return {
    taskId: res.headers.get(TASK_ID_HEADER) ?? undefined,
    events: readFeed(res.body),
  };
}

async function* readFeed(body: ReadableStream<Uint8Array>): AsyncGenerator<FeedEvent> {
  const parse = createSseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const payload of parse(decoder.decode(value, { stream: true }))) {
        if (payload === "[DONE]") {
          yield { type: "done" };
          return;
        }
        let chunk: OpenAIChatChunk;
        try {
          chunk = JSON.parse(payload) as OpenAIChatChunk;
        } catch {
          // A frame we cannot read is a frame we cannot render; the stream
          // itself is still framed correctly, so keep going.
          continue;
        }
        const content = chunk.choices[0]?.delta.content;
        if (typeof content === "string" && content !== "") yield { type: "text", text: content };
        if (chunk.error !== undefined) yield { type: "error", message: chunk.error.message };
        if (chunk.usage !== undefined) yield { type: "usage", usage: chunk.usage };
      }
    }
    // The socket closed without `[DONE]`: the daemon died mid-stream, or the
    // connection was cut. Distinct from a clean end, and the caller should say so.
    yield { type: "error", message: "stream ended without [DONE] — connection lost" };
  } finally {
    reader.releaseLock();
  }
}
