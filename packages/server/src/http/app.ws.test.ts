/**
 * `WS /internal/ws` — replay then live, over a **real socket**.
 *
 * `app.inject()` cannot speak WebSocket at all, so unlike the rest of the HTTP
 * suite these pay for a port. What they are really pinning is the seam: that
 * the replay lands before the live feed attaches, and that the ordering holds
 * for an event appended *during* the replay — the one moment where getting it
 * wrong is invisible in a quiet test and corrupts a real dashboard's fold.
 */
import { type EventEnvelope, type SocketServerMessage, foldEvents } from "@rewter/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { Router } from "../router/router.js";
import { FakeAdapter } from "../testing/fake-adapter.js";
import { model, provider } from "../testing/registry.js";
import { task, workItem } from "../testing/tasks.js";
import { buildApp } from "./app.js";

const MODEL_ID = "anthropic/claude-sonnet-5";

let db: Db;
let repos: Repos;
let bus: EventBus;
let app: FastifyInstance;
let sockets: WebSocket[] = [];

beforeEach(() => {
  db = openDb(":memory:");
  let tick = 1_756_252_800_000;
  const clock = () => ++tick;
  bus = new EventBus(db, clock);
  repos = new Repos(db, bus, clock);
  repos.upsertProvider(provider());
  repos.upsertModel(model(MODEL_ID));
  sockets = [];
});

afterEach(async () => {
  for (const s of sockets) s.close();
  sockets = [];
  app?.server.closeAllConnections();
  await app?.close();
});

async function listen(): Promise<string> {
  app = buildApp({
    router: new Router({
      repos,
      createAdapter: () => new FakeAdapter([]),
      sleep: async () => undefined,
    }),
    repos,
    bus,
    sse: { heartbeatMs: 0 },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return `ws://127.0.0.1:${port}/internal/ws`;
}

/** A connected socket that records every server message in arrival order. */
async function connect(url: string): Promise<{ socket: WebSocket; seen: SocketServerMessage[] }> {
  const socket = new WebSocket(url);
  sockets.push(socket);
  const seen: SocketServerMessage[] = [];
  socket.addEventListener("message", (ev) => {
    seen.push(JSON.parse(String(ev.data)) as SocketServerMessage);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      (ev) =>
        reject(
          new Error(`socket failed: ${String((ev as unknown as { message?: string }).message)}`),
        ),
      {
        once: true,
      },
    );
  });
  return { socket, seen };
}

function subscribe(socket: WebSocket, body: Record<string, unknown> = {}): void {
  socket.send(JSON.stringify({ type: "subscribe", ...body }));
}

const eventsOf = (seen: SocketServerMessage[]): EventEnvelope[] =>
  seen.flatMap((m) => (m.type === "event" ? [m.event] : []));

const readyOf = (seen: SocketServerMessage[]) => seen.find((m) => m.type === "ready");

describe("WS /internal/ws", () => {
  it("replays history, then streams what happens next", async () => {
    const url = await listen();
    const t = repos.createTask(task());

    const { socket, seen } = await connect(url);
    subscribe(socket);
    await vi.waitFor(() => expect(readyOf(seen)).toBeDefined());

    // Everything before `ready` is history; the task existed before we connected.
    expect(eventsOf(seen)).toHaveLength(1);
    expect(readyOf(seen)?.replayed).toBe(1);

    repos.createWorkItem(workItem(t.id, "after the seam"));
    await vi.waitFor(() => expect(eventsOf(seen)).toHaveLength(2));

    const live = eventsOf(seen)[1];
    expect(live?.payload.type).toBe("work_item.created");
    // Live events arrive after `ready`, which is what makes the seam meaningful.
    expect(seen.findIndex((m) => m.type === "ready")).toBeLessThan(seen.length - 1);
  });

  it("resumes from afterSeq rather than resending what the client folded", async () => {
    const url = await listen();
    const t = repos.createTask(task());
    const first = bus.eventsAfter(0)[0] as EventEnvelope;
    repos.createWorkItem(workItem(t.id, "second"));

    const { socket, seen } = await connect(url);
    subscribe(socket, { afterSeq: first.seq });
    await vi.waitFor(() => expect(readyOf(seen)).toBeDefined());

    expect(eventsOf(seen).map((e) => e.payload.type)).toEqual(["work_item.created"]);
    expect(readyOf(seen)?.replayed).toBe(1);
  });

  it("reports the resume point even when the replay is empty", async () => {
    // A dashboard that is already current still needs to leave its loading
    // state, and needs a seq to reconnect with — silence gives it neither.
    const url = await listen();
    repos.createTask(task());
    const lastSeq = (bus.eventsAfter(0).at(-1) as EventEnvelope).seq;

    const { socket, seen } = await connect(url);
    subscribe(socket, { afterSeq: lastSeq });
    await vi.waitFor(() => expect(readyOf(seen)).toBeDefined());

    expect(readyOf(seen)?.replayed).toBe(0);
    expect(readyOf(seen)?.seq).toBe(lastSeq);
  });

  it("narrows both the replay and the live feed to one task", async () => {
    const url = await listen();
    const a = repos.createTask(task({ title: "task a" }));
    const b = repos.createTask(task({ title: "task b" }));

    const { socket, seen } = await connect(url);
    subscribe(socket, { taskId: b.id });
    await vi.waitFor(() => expect(readyOf(seen)).toBeDefined());
    expect(eventsOf(seen)).toHaveLength(1);
    expect(readyOf(seen)?.taskId).toBe(b.id);

    repos.createWorkItem(workItem(a.id, "not yours"));
    repos.createWorkItem(workItem(b.id, "yours"));
    await vi.waitFor(() => expect(eventsOf(seen)).toHaveLength(2));

    // Not just "two events": the wrong two would also be two.
    expect(eventsOf(seen).every((e) => e.taskId === b.id)).toBe(true);
  });

  it("delivers events in seq order across the replay/live seam", async () => {
    // The reason replay runs before the listener attaches. An event appended
    // mid-replay may arrive twice — the fold drops that by seq — but one
    // arriving *early* is a hole nothing downstream can repair.
    const url = await listen();
    const t = repos.createTask(task());
    for (let i = 0; i < 20; i++) repos.createWorkItem(workItem(t.id, `w${i}`));

    const { socket, seen } = await connect(url);
    subscribe(socket);
    // Append while the replay is being written out.
    repos.createWorkItem(workItem(t.id, "raced"));
    await vi.waitFor(() => expect(eventsOf(seen).length).toBeGreaterThanOrEqual(22));

    const seqs = eventsOf(seen).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
  });

  it("feeds a fold that ends up agreeing with a fold of the whole log", async () => {
    // The point of the socket: what a dashboard folds from it must equal what
    // it would have got from the database, duplicates and all.
    const url = await listen();
    const t = repos.createTask(task());
    repos.createWorkItem(workItem(t.id, "before"));

    const { socket, seen } = await connect(url);
    subscribe(socket);
    await vi.waitFor(() => expect(readyOf(seen)).toBeDefined());
    repos.createWorkItem(workItem(t.id, "after"));
    await vi.waitFor(() => expect(eventsOf(seen)).toHaveLength(3));

    const overSocket = foldEvents(eventsOf(seen));
    const overDb = foldEvents(bus.eventsAfter(0));
    expect(overSocket.tasks[t.id]).toEqual(overDb.tasks[t.id]);
    expect(overSocket.orphanedEvents).toBe(0);
  });

  it("replaces the previous subscription instead of stacking a second one", async () => {
    const url = await listen();
    const t = repos.createTask(task());

    const { socket, seen } = await connect(url);
    subscribe(socket);
    await vi.waitFor(() => expect(readyOf(seen)).toBeDefined());
    subscribe(socket, { afterSeq: 999 });
    await vi.waitFor(() => expect(seen.filter((m) => m.type === "ready")).toHaveLength(2));

    const before = eventsOf(seen).length;
    repos.createWorkItem(workItem(t.id, "once"));
    await vi.waitFor(() => expect(eventsOf(seen).length).toBe(before + 1));
    // Give a duplicate delivery time to show up if a listener leaked.
    await new Promise((r) => setTimeout(r, 50));
    expect(eventsOf(seen).length).toBe(before + 1);
  });

  it("explains a bad message rather than closing the socket", async () => {
    const url = await listen();
    const { socket, seen } = await connect(url);

    socket.send("not json");
    await vi.waitFor(() => expect(seen.filter((m) => m.type === "error")).toHaveLength(1));
    socket.send(JSON.stringify({ type: "subscribe", afterSeq: -1 }));
    await vi.waitFor(() => expect(seen.filter((m) => m.type === "error")).toHaveLength(2));

    // Still usable: a mistyped subscription must not cost the connection.
    expect(socket.readyState).toBe(socket.OPEN);
    subscribe(socket);
    await vi.waitFor(() => expect(readyOf(seen)).toBeDefined());
  });

  it("drops its listener when the client goes away", async () => {
    const url = await listen();
    const t = repos.createTask(task());
    const { socket, seen } = await connect(url);
    subscribe(socket);
    await vi.waitFor(() => expect(readyOf(seen)).toBeDefined());

    socket.close();
    await vi.waitFor(() => expect(socket.readyState).toBe(socket.CLOSED));
    // The write path must survive a subscriber that is gone, not throw into it.
    expect(() => repos.createWorkItem(workItem(t.id, "after close"))).not.toThrow();
  });
});
