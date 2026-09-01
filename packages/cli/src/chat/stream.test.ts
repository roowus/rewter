import { describe, expect, it } from "vitest";
import type { Connection } from "./client.js";
import { ChatStartError, startChat } from "./stream.js";
import type { FeedEvent } from "./stream.js";

const conn: Connection = { baseUrl: "http://127.0.0.1:20180", headers: { "x-api-key": "k" } };

/** An SSE body from a list of pre-framed chunks, delivered one read() each. */
function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunkWith(extra: Record<string, unknown>): unknown {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "auto/orchestrator",
    choices: [{ index: 0, delta: {}, finish_reason: null }],
    ...extra,
  };
}

function textChunk(text: string): unknown {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "auto/orchestrator",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

function streamingFetch(
  chunks: string[],
  headers: Record<string, string> = {},
): { fetch: typeof globalThis.fetch; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(sseBody(chunks), {
      status: 200,
      headers: { "content-type": "text/event-stream", ...headers },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

async function collect(events: AsyncGenerator<FeedEvent>): Promise<FeedEvent[]> {
  const out: FeedEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("startChat", () => {
  it("POSTs a streaming completion and exposes the task id from the header", async () => {
    const { fetch, calls } = streamingFetch([frame(textChunk("hi")), "data: [DONE]\n\n"], {
      "x-rewter-task-id": "task_abcdefghijkl",
    });
    const stream = await startChat(conn, fetch, {
      model: "auto/orchestrator",
      messages: [{ role: "user", content: "do the thing" }],
    });
    expect(stream.taskId).toBe("task_abcdefghijkl");
    const call = calls[0];
    expect(call?.url).toBe("http://127.0.0.1:20180/v1/chat/completions");
    const body = JSON.parse(String(call?.init?.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.model).toBe("auto/orchestrator");
    await collect(stream.events);
  });

  it("leaves taskId undefined when the daemon does not send the header", async () => {
    // Pass-through routes never carry it; steering has nothing to aim at.
    const { fetch } = streamingFetch(["data: [DONE]\n\n"]);
    const stream = await startChat(conn, fetch, {
      model: "anthropic/claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(stream.taskId).toBeUndefined();
    await collect(stream.events);
  });

  it("routes the project via the x-rewter-project header", async () => {
    const { fetch, calls } = streamingFetch(["data: [DONE]\n\n"]);
    const stream = await startChat(conn, fetch, {
      model: "auto/orchestrator",
      messages: [{ role: "user", content: "hi" }],
      project: "clarity",
    });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["x-rewter-project"]).toBe("clarity");
    await collect(stream.events);
  });

  it("throws ChatStartError with the daemon's message on a pre-stream refusal", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "unknown project: nope", type: "bad" } }), {
        status: 400,
      })) as unknown as typeof globalThis.fetch;
    await expect(
      startChat(conn, fetch, { model: "auto/orchestrator", messages: [] }),
    ).rejects.toThrowError(
      expect.objectContaining({
        name: "ChatStartError",
        status: 400,
        message: "unknown project: nope",
      }),
    );
  });

  it("falls back to the status code when the refusal body is not JSON", async () => {
    const fetch = (async () =>
      new Response("boom", { status: 503 })) as unknown as typeof globalThis.fetch;
    await expect(
      startChat(conn, fetch, { model: "auto/orchestrator", messages: [] }),
    ).rejects.toThrowError(
      expect.objectContaining({ status: 503, message: "daemon returned 503" }),
    );
  });
});

describe("the event feed", () => {
  async function feedOf(chunks: string[]): Promise<FeedEvent[]> {
    const { fetch } = streamingFetch(chunks);
    const stream = await startChat(conn, fetch, {
      model: "auto/orchestrator",
      messages: [{ role: "user", content: "hi" }],
    });
    return collect(stream.events);
  }

  it("yields text deltas and ends cleanly on [DONE]", async () => {
    const events = await feedOf([
      frame(textChunk("◆ plan: ")),
      frame(textChunk("two workers\n")),
      "data: [DONE]\n\n",
    ]);
    expect(events).toEqual([
      { type: "text", text: "◆ plan: " },
      { type: "text", text: "two workers\n" },
      { type: "done" },
    ]);
  });

  it("skips the role frame and empty deltas without inventing text events", async () => {
    const events = await feedOf([
      frame(
        chunkWith({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
      ),
      frame(textChunk("hello")),
      "data: [DONE]\n\n",
    ]);
    expect(events).toEqual([{ type: "text", text: "hello" }, { type: "done" }]);
  });

  it("surfaces the error riding the final frame", async () => {
    // Once SSE headers are out there is no status code left; a mid-stream
    // failure arrives as an `error` field on a well-formed last chunk.
    const events = await feedOf([
      frame(textChunk("partial")),
      frame(chunkWith({ error: { message: "provider fell over", type: "upstream", code: null } })),
      "data: [DONE]\n\n",
    ]);
    expect(events).toEqual([
      { type: "text", text: "partial" },
      { type: "error", message: "provider fell over" },
      { type: "done" },
    ]);
  });

  it("yields usage when the daemon includes it", async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const events = await feedOf([frame(chunkWith({ usage })), "data: [DONE]\n\n"]);
    expect(events).toEqual([{ type: "usage", usage }, { type: "done" }]);
  });

  it("reports a connection loss when the socket closes without [DONE]", async () => {
    const events = await feedOf([frame(textChunk("half an ans"))]);
    expect(events).toEqual([
      { type: "text", text: "half an ans" },
      { type: "error", message: "stream ended without [DONE] — connection lost" },
    ]);
  });

  it("skips an unparseable frame and keeps reading", async () => {
    const events = await feedOf([
      "data: {not json\n\n",
      frame(textChunk("ok")),
      "data: [DONE]\n\n",
    ]);
    expect(events).toEqual([{ type: "text", text: "ok" }, { type: "done" }]);
  });

  it("handles a frame split across two reads", async () => {
    const whole = frame(textChunk("split across reads"));
    const events = await feedOf([whole.slice(0, 12), whole.slice(12), "data: [DONE]\n\n"]);
    expect(events).toEqual([{ type: "text", text: "split across reads" }, { type: "done" }]);
  });
});
