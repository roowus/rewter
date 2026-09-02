import type { EventEnvelope } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import type { Connection } from "./client.js";
import { fanOut } from "./fold-fixtures.js";
import { type SocketFactory, type SocketLike, socketUrl, watchTask } from "./watch.js";

const TASK_ID = "task_abcdefghijkl";
const conn: Connection = { baseUrl: "http://127.0.0.1:20180", headers: { "x-api-key": "k" } };

/** A socket the test drives from the daemon's side. */
class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closedByClient = false;
  private readonly listeners: Record<string, Array<(ev: unknown) => void>> = {};

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}

  addEventListener(type: string, listener: (ev: never) => void): void {
    const list = this.listeners[type] ?? [];
    list.push(listener as (ev: unknown) => void);
    this.listeners[type] = list;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closedByClient = true;
  }

  // daemon side
  open(): void {
    this.emit("open", undefined);
  }
  message(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }
  event(event: EventEnvelope): void {
    this.message({ type: "event", event });
  }
  error(): void {
    this.emit("error", {});
  }
  hangUp(code?: number, reason?: string): void {
    this.emit("close", { code, reason });
  }
  emit(type: string, ev: unknown): void {
    for (const l of this.listeners[type] ?? []) l(ev);
  }
}

function fakeFactory(): { factory: SocketFactory; socket: () => FakeSocket } {
  let created: FakeSocket | undefined;
  const factory: SocketFactory = (url, headers) => {
    created = new FakeSocket(url, headers);
    return created;
  };
  return {
    factory,
    socket: () => {
      if (created === undefined) throw new Error("socket not opened");
      return created;
    },
  };
}

describe("socketUrl", () => {
  it("swaps the scheme and appends the dashboard's path", () => {
    expect(socketUrl("http://127.0.0.1:20130")).toBe("ws://127.0.0.1:20130/internal/ws");
    expect(socketUrl("https://mac.tailnet.ts.net")).toBe("wss://mac.tailnet.ts.net/internal/ws");
  });
});

describe("watchTask", () => {
  it("connects with the connection's headers and subscribes to the one task on open", () => {
    const { factory, socket } = fakeFactory();
    watchTask(conn, TASK_ID, factory);
    expect(socket().url).toBe("ws://127.0.0.1:20180/internal/ws");
    expect(socket().headers).toEqual({ "x-api-key": "k" });
    expect(socket().sent).toEqual([]);
    socket().open();
    expect(socket().sent.map((s) => JSON.parse(s))).toEqual([
      { type: "subscribe", taskId: TASK_ID },
    ]);
  });

  it("folds events into the task and notifies on each change", () => {
    const { factory, socket } = fakeFactory();
    const watcher = watchTask(conn, TASK_ID, factory);
    const seen: string[] = [];
    watcher.onChange((task) => seen.push(`${task.task.status}:${task.workItems.length}`));
    socket().open();
    const { stream } = fanOut(TASK_ID);
    for (const ev of stream.events) socket().event(ev);
    expect(watcher.task?.workItems.map((w) => w.label)).toEqual(["w1", "w2"]);
    expect(watcher.task?.costUsd).toBeCloseTo(0.021);
    expect(seen[0]).toBe("pending:0");
    expect(seen.at(-1)).toBe("running:2");
    expect(seen).toHaveLength(stream.events.length);
    expect(watcher.failure).toBeNull();
  });

  it("ignores frames that are not events and replays that are not JSON", () => {
    const { factory, socket } = fakeFactory();
    const watcher = watchTask(conn, TASK_ID, factory);
    socket().open();
    socket().message({ type: "ready", seq: 0, replayed: 0, taskId: TASK_ID });
    socket().emit("message", { data: "not json" });
    expect(watcher.task).toBeUndefined();
    expect(watcher.failure).toBeNull();
  });

  it("settles when the task reaches a terminal status", async () => {
    const { factory, socket } = fakeFactory();
    const watcher = watchTask(conn, TASK_ID, factory);
    socket().open();
    const { stream, finish } = fanOut(TASK_ID);
    for (const ev of stream.events) socket().event(ev);
    let settled = false;
    const wait = watcher.settled(10_000).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    const before = stream.events.length;
    finish();
    for (const ev of stream.events.slice(before)) socket().event(ev);
    await wait;
    expect(settled).toBe(true);
    expect(watcher.task?.task.status).toBe("succeeded");
  });

  it("settles on the timeout when the socket stays quiet", async () => {
    const { factory, socket } = fakeFactory();
    const watcher = watchTask(conn, TASK_ID, factory);
    socket().open();
    const started = Date.now();
    await watcher.settled(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(watcher.task).toBeUndefined();
  });

  it("settles immediately once the socket has closed, and records why", async () => {
    const { factory, socket } = fakeFactory();
    const watcher = watchTask(conn, TASK_ID, factory);
    socket().hangUp(1006, "upgrade refused");
    await watcher.settled(10_000);
    expect(watcher.failure).toBe("socket closed (1006): upgrade refused");
  });

  it("turns an error followed by close into one unavailable reason", () => {
    const { factory, socket } = fakeFactory();
    const watcher = watchTask(conn, TASK_ID, factory);
    socket().error();
    expect(watcher.failure).toBe("socket error");
    socket().hangUp(1006);
    expect(watcher.failure).toBe("socket unavailable (1006)");
  });

  it("relays the daemon's refusal", () => {
    const { factory, socket } = fakeFactory();
    const watcher = watchTask(conn, TASK_ID, factory);
    socket().open();
    socket().message({ type: "error", message: "unauthorised" });
    expect(watcher.failure).toBe("socket refused: unauthorised");
  });

  it("does not call a healthy close a failure", async () => {
    const { factory, socket } = fakeFactory();
    const watcher = watchTask(conn, TASK_ID, factory);
    socket().open();
    const { stream, finish } = fanOut(TASK_ID);
    finish();
    for (const ev of stream.events) socket().event(ev);
    socket().hangUp(1000);
    await watcher.settled(10_000);
    expect(watcher.failure).toBeNull();
  });

  it("close() hangs up the socket and releases anyone waiting", async () => {
    const { factory, socket } = fakeFactory();
    const watcher = watchTask(conn, TASK_ID, factory);
    socket().open();
    const wait = watcher.settled(10_000);
    watcher.close();
    await wait;
    expect(socket().closedByClient).toBe(true);
  });

  it("degrades to a stub when the socket cannot even be constructed", async () => {
    const watcher = watchTask(conn, TASK_ID, () => {
      throw new Error("WebSocket is not defined");
    });
    expect(watcher.task).toBeUndefined();
    expect(watcher.failure).toBe("socket unavailable: WebSocket is not defined");
    await watcher.settled(10_000);
    watcher.close();
  });
});
