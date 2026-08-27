import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { HEARTBEAT_MS, SseWriter } from "./sse.js";

/** A minimal ServerResponse stand-in that records exactly what was written. */
function fakeRes() {
  const writes: string[] = [];
  let head: { status: number; headers: Record<string, string> } | undefined;
  const res = {
    writableEnded: false,
    writeHead(status: number, headers: Record<string, string>) {
      head = { status, headers };
      return this;
    },
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    writes,
    get head() {
      return head;
    },
    get body() {
      return writes.join("");
    },
  };
}

/** Timer stubs so heartbeats are triggered explicitly, not by waiting. */
function fakeTimers() {
  let fn: (() => void) | undefined;
  let cleared = false;
  return {
    setInterval: ((cb: () => void) => {
      fn = cb;
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof globalThis.setInterval,
    clearInterval: (() => {
      cleared = true;
    }) as unknown as typeof globalThis.clearInterval,
    fire: () => fn?.(),
    get cleared() {
      return cleared;
    },
    get registered() {
      return fn !== undefined;
    },
  };
}

describe("SseWriter", () => {
  it("writes the SSE headers streaming clients and proxies need", () => {
    const f = fakeRes();
    new SseWriter(f.res, { heartbeatMs: 0 });
    expect(f.head?.status).toBe(200);
    expect(f.head?.headers["Content-Type"]).toBe("text/event-stream; charset=utf-8");
    expect(f.head?.headers["Cache-Control"]).toBe("no-cache, no-transform");
    // Without this nginx buffers the stream into uselessness.
    expect(f.head?.headers["X-Accel-Buffering"]).toBe("no");
  });

  it("frames a payload as one `data:` line ending in a blank line", () => {
    const f = fakeRes();
    const w = new SseWriter(f.res, { heartbeatMs: 0 });
    w.send({ a: 1 });
    expect(f.writes).toEqual(['data: {"a":1}\n\n']);
  });

  it("emits the literal [DONE] sentinel clients stop on", () => {
    const f = fakeRes();
    const w = new SseWriter(f.res, { heartbeatMs: 0 });
    w.send({ a: 1 });
    w.done();
    expect(f.body).toBe('data: {"a":1}\n\ndata: [DONE]\n\n');
  });

  it("writes comments as `: text`, which every SSE parser ignores", () => {
    const f = fakeRes();
    const w = new SseWriter(f.res, { heartbeatMs: 0 });
    w.comment("ping");
    expect(f.writes).toEqual([": ping\n\n"]);
  });

  it("heartbeats on the configured interval and stops on end()", () => {
    // An orchestration can think for minutes; proxies cut idle sockets first.
    const f = fakeRes();
    const timers = fakeTimers();
    const w = new SseWriter(f.res, {
      heartbeatMs: 1_000,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    timers.fire();
    timers.fire();
    expect(f.writes).toEqual([": ping\n\n", ": ping\n\n"]);
    w.end();
    expect(timers.cleared).toBe(true);
  });

  it("skips the heartbeat entirely when disabled", () => {
    const timers = fakeTimers();
    new SseWriter(fakeRes().res, {
      heartbeatMs: 0,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    expect(timers.registered).toBe(false);
  });

  it("defaults below the common 30s proxy timeout", () => {
    expect(HEARTBEAT_MS).toBeLessThan(30_000);
  });

  it("drops writes after end() instead of throwing", () => {
    // The client hanging up mid-stream must not crash the request handler.
    const f = fakeRes();
    const w = new SseWriter(f.res, { heartbeatMs: 0 });
    w.end();
    w.send({ late: true });
    w.done();
    expect(f.writes).toEqual([]);
  });

  it("is idempotent on end()", () => {
    const f = fakeRes();
    const w = new SseWriter(f.res, { heartbeatMs: 0 });
    w.end();
    expect(() => w.end()).not.toThrow();
  });
});
