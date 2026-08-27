/**
 * Hand-rolled SSE writer. Fastify's reply abstraction is bypassed deliberately:
 * OpenAI clients are strict about framing (`data: ` prefix, blank-line
 * terminator, a literal `data: [DONE]` sentinel), and going through `reply.raw`
 * is the only way to guarantee byte-exact output and flush-on-write.
 *
 * Heartbeats matter more here than in a typical SSE feed. An orchestration can
 * think for minutes before its first token, and proxies and HTTP clients cut
 * idle connections long before that. A comment line (`: ping`) is legal SSE
 * that every parser ignores, so it keeps the socket warm without appearing in
 * the client's message stream.
 */
import type { ServerResponse } from "node:http";

/** Idle interval before a keep-alive comment. Below the common 30s proxy cut. */
export const HEARTBEAT_MS = 15_000;

export interface SseWriterOptions {
  heartbeatMs?: number;
  /** Injectable timers so tests don't wait in real time. */
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

export class SseWriter {
  private heartbeat: ReturnType<typeof globalThis.setInterval> | undefined;
  private closed = false;
  private readonly clearTimer: typeof globalThis.clearInterval;

  constructor(
    private readonly res: ServerResponse,
    opts: SseWriterOptions = {},
  ) {
    const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    const setTimer = opts.setInterval ?? globalThis.setInterval;
    this.clearTimer = opts.clearInterval ?? globalThis.clearInterval;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx and friends buffer streams into uselessness without this.
      "X-Accel-Buffering": "no",
    });

    if (heartbeatMs > 0) {
      this.heartbeat = setTimer(() => this.comment("ping"), heartbeatMs);
      // Never hold the process open for a heartbeat alone.
      this.heartbeat.unref?.();
    }
  }

  /** One `data:` frame holding JSON. */
  send(payload: unknown): void {
    this.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  /**
   * A *named* event frame (`event: … / data: …`). OpenAI's stream is data-only,
   * but Anthropic's is named — its clients dispatch on the `event:` line, and a
   * frame without one is silently ignored.
   */
  sendEvent(name: string, payload: unknown): void {
    this.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  /** A comment line — ignored by SSE parsers, keeps the connection alive. */
  comment(text: string): void {
    this.write(`: ${text}\n\n`);
  }

  /** The OpenAI terminator. Clients stop reading here. */
  done(): void {
    this.write("data: [DONE]\n\n");
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat !== undefined) this.clearTimer(this.heartbeat);
    this.res.end();
  }

  private write(frame: string): void {
    if (this.closed || this.res.writableEnded) return;
    this.res.write(frame);
  }
}
