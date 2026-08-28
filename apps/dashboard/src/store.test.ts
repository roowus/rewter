/**
 * The store, driven through a fake socket.
 *
 * What is worth pinning here is not "the fold works" — `shared/src/fold.test.ts`
 * owns that — but the things only this layer can get wrong: resuming from the
 * right `seq`, not re-rendering on the replay/live overlap, and surviving a
 * daemon that goes away.
 */
import {
  type EventEnvelope,
  EventEnvelopeSchema,
  type EventPayload,
  ModelIdSchema,
  TaskSchema,
  TaskSettingsSchema,
  newTaskId,
} from "@rewter/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDashboard } from "./store.js";

const now = 1_756_252_800_000;
const mdl = ModelIdSchema.parse("anthropic/claude-sonnet-5");

/** The sockets the store opened, in order, so a test can drive the live one. */
let opened: FakeSocket[] = [];

class FakeSocket {
  static readonly OPEN = 1;
  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    opened.push(this);
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  /** Drive the handshake the way a real server would. */
  accept(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit("open", {});
  }

  deliver(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }
}

const live = (): FakeSocket => {
  const socket = opened.at(-1);
  if (socket === undefined) throw new Error("no socket was opened");
  return socket;
};

const subscribeOf = (socket: FakeSocket): { afterSeq?: number } =>
  JSON.parse(socket.sent[0] ?? "{}") as { afterSeq?: number };

function taskCreated(seq: number, taskId = newTaskId()): EventEnvelope {
  const task = TaskSchema.parse({
    id: taskId,
    status: "pending",
    title: "summarize three urls",
    initiatorModelId: mdl,
    conversationFingerprint: null,
    settings: TaskSettingsSchema.parse({}),
    resultSummary: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  });
  const payload: EventPayload = { type: "task.created", task };
  return EventEnvelopeSchema.parse({ seq, ts: now + seq, taskId, payload });
}

beforeEach(() => {
  opened = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.useFakeTimers();
  useDashboard.setState({
    status: "idle",
    fold: { tasks: {}, lastSeq: 0, orphanedEvents: 0 },
    replayed: 0,
    error: null,
  });
});

afterEach(() => {
  useDashboard.getState().disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("connecting", () => {
  it("subscribes from the top on a first connect", () => {
    useDashboard.getState().connect("ws://test/internal/ws");
    live().accept();

    expect(subscribeOf(live())).toEqual({ type: "subscribe", afterSeq: 0 });
    expect(useDashboard.getState().status).toBe("connecting");
  });

  it("opens only one socket even if connect is called twice", () => {
    // A component that mounts twice in StrictMode must not double the feed.
    useDashboard.getState().connect("ws://test/internal/ws");
    useDashboard.getState().connect("ws://test/internal/ws");
    expect(opened).toHaveLength(1);
  });

  it("goes live on `ready` and reports how much history it replayed", () => {
    useDashboard.getState().connect("ws://test/internal/ws");
    live().accept();
    live().deliver({ type: "ready", seq: 0, replayed: 0, taskId: null });

    // `replayed: 0` is the already-current case, and it still has to leave the
    // loading state — a dashboard that waits for an event waits forever.
    expect(useDashboard.getState().status).toBe("live");
    expect(useDashboard.getState().replayed).toBe(0);
  });
});

describe("folding", () => {
  it("folds an event frame into the tree", () => {
    useDashboard.getState().connect("ws://test/internal/ws");
    live().accept();
    const event = taskCreated(1);
    live().deliver({ type: "event", event });

    const { fold } = useDashboard.getState();
    expect(fold.lastSeq).toBe(1);
    expect(Object.keys(fold.tasks)).toHaveLength(1);
  });

  it("keeps the same fold object when an event is re-delivered", () => {
    // The replay/live overlap is the common case, not a rare one. `applyEvent`
    // returns the identical object below `lastSeq`; if the store set state
    // anyway, every duplicate would re-render the whole tree.
    useDashboard.getState().connect("ws://test/internal/ws");
    live().accept();
    const event = taskCreated(1);
    live().deliver({ type: "event", event });
    const first = useDashboard.getState().fold;

    live().deliver({ type: "event", event });
    expect(useDashboard.getState().fold).toBe(first);
  });

  it("survives a frame it cannot parse without losing the feed", () => {
    // A newer daemon than the bundle. Folding a half-shaped envelope would
    // corrupt the tree; dropping it keeps everything else working.
    useDashboard.getState().connect("ws://test/internal/ws");
    live().accept();
    live().deliver({ type: "event", event: { seq: 1, ts: 2 } });
    expect(useDashboard.getState().error).toBe("unrecognized message from daemon");

    live().deliver({ type: "event", event: taskCreated(1) });
    expect(useDashboard.getState().fold.lastSeq).toBe(1);
  });

  it("surfaces a server error frame without dropping the connection", () => {
    useDashboard.getState().connect("ws://test/internal/ws");
    live().accept();
    live().deliver({ type: "error", message: "afterSeq must be nonnegative" });

    expect(useDashboard.getState().error).toBe("afterSeq must be nonnegative");
    // `ready` clears it: the next successful subscribe is the answer to the
    // complaint, and a stale error in the status bar outlives its usefulness.
    live().deliver({ type: "ready", seq: 0, replayed: 0, taskId: null });
    expect(useDashboard.getState().error).toBeNull();
  });
});

describe("reconnecting", () => {
  it("resumes from what it already folded rather than refolding history", () => {
    useDashboard.getState().connect("ws://test/internal/ws");
    live().accept();
    live().deliver({ type: "event", event: taskCreated(7) });
    live().close();

    vi.advanceTimersByTime(250);
    expect(opened).toHaveLength(2);
    live().accept();
    // The whole point of `afterSeq`: on a long-lived daemon, refolding from 0
    // is the entire history every time a laptop lid closes.
    expect(subscribeOf(live()).afterSeq).toBe(7);
  });

  it("keeps the tree on screen while it is reconnecting", () => {
    useDashboard.getState().connect("ws://test/internal/ws");
    live().accept();
    live().deliver({ type: "event", event: taskCreated(1) });
    live().close();

    // Blanking the tree on a dropped socket would make a two-second blip look
    // like a daemon that lost the task.
    expect(useDashboard.getState().status).toBe("reconnecting");
    expect(Object.keys(useDashboard.getState().fold.tasks)).toHaveLength(1);
  });

  it("backs off instead of hammering a daemon that is not there", () => {
    useDashboard.getState().connect("ws://test/internal/ws");
    live().accept();

    live().close();
    vi.advanceTimersByTime(250);
    expect(opened).toHaveLength(2);

    // Second failure waits longer than the first; a fixed delay is a tight loop
    // against a daemon that is down for an hour.
    live().close();
    vi.advanceTimersByTime(250);
    expect(opened).toHaveLength(2);
    vi.advanceTimersByTime(250);
    expect(opened).toHaveLength(3);
  });

  it("stops retrying once disconnected", () => {
    useDashboard.getState().connect("ws://test/internal/ws");
    live().accept();
    useDashboard.getState().disconnect();

    vi.advanceTimersByTime(10_000);
    expect(opened).toHaveLength(1);
    expect(useDashboard.getState().status).toBe("idle");
  });
});
