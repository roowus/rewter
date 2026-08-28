/**
 * The socket contract, from the parser's side.
 *
 * These schemas are the only thing standing between a mistyped dashboard
 * message and the event bus, so what is pinned here is mostly what gets
 * *rejected* — and that a rejection is a value the route can put in an `error`
 * message rather than an exception that costs the connection.
 */
import { describe, expect, it } from "vitest";
import { EventEnvelopeSchema } from "./events.js";
import { ModelIdSchema, newTaskId } from "./ids.js";
import {
  SocketClientMessageSchema,
  SocketServerMessageSchema,
  SocketSubscribeSchema,
} from "./socket.js";

const taskId = newTaskId();

describe("SocketSubscribe", () => {
  it("accepts a bare subscribe — no filters means everything", () => {
    const parsed = SocketSubscribeSchema.parse({ type: "subscribe" });
    // Absent rather than defaulted: the route reads `afterSeq = 0`, and a schema
    // that filled it in would hide which of the two chose the value.
    expect(parsed.afterSeq).toBeUndefined();
    expect(parsed.taskId).toBeUndefined();
  });

  it("carries a resume point and a task filter when given them", () => {
    const parsed = SocketSubscribeSchema.parse({ type: "subscribe", afterSeq: 42, taskId });
    expect(parsed).toEqual({ type: "subscribe", afterSeq: 42, taskId });
  });

  it("refuses a seq that could not have come from a fold", () => {
    // `afterSeq` is the client's own `lastSeq`, and `lastSeq` starts at 0. A
    // negative or fractional one is a bug on the client, not a resume request —
    // and passed through it would silently replay from the top.
    expect(SocketSubscribeSchema.safeParse({ type: "subscribe", afterSeq: -1 }).success).toBe(
      false,
    );
    expect(SocketSubscribeSchema.safeParse({ type: "subscribe", afterSeq: 1.5 }).success).toBe(
      false,
    );
    expect(SocketSubscribeSchema.safeParse({ type: "subscribe", afterSeq: "9" }).success).toBe(
      false,
    );
  });

  it("refuses an id that is not a task id", () => {
    // Branded ids are prefixed for exactly this: a work-item id here would
    // filter the whole feed down to nothing and look like a quiet daemon.
    expect(SocketSubscribeSchema.safeParse({ type: "subscribe", taskId: "wi_abc" }).success).toBe(
      false,
    );
  });
});

describe("SocketClientMessage", () => {
  it("routes on `type` and rejects anything else the client might send", () => {
    expect(SocketClientMessageSchema.parse({ type: "subscribe" }).type).toBe("subscribe");
    // Approve/deny are REST POSTs. Accepting them here would make the same
    // action reachable two ways, one of which has no status code to fail with.
    expect(SocketClientMessageSchema.safeParse({ type: "approve", id: "apr_x" }).success).toBe(
      false,
    );
    expect(SocketClientMessageSchema.safeParse({}).success).toBe(false);
  });
});

describe("SocketServerMessage", () => {
  it("parses a ready frame, including the empty-replay case", () => {
    // `replayed: 0` with a non-zero seq is what an already-current dashboard
    // gets, and it has to be a legal frame or that client never leaves loading.
    const ready = SocketServerMessageSchema.parse({
      type: "ready",
      seq: 17,
      replayed: 0,
      taskId: null,
    });
    expect(ready).toEqual({ type: "ready", seq: 17, replayed: 0, taskId: null });
  });

  it("requires ready to say which task it is scoped to, even when it is not", () => {
    // Nullable, not optional: "all tasks" is an answer, and a missing field
    // would leave the client unable to tell it from an older server.
    expect(
      SocketServerMessageSchema.safeParse({ type: "ready", seq: 1, replayed: 0 }).success,
    ).toBe(false);
  });

  it("wraps a real envelope in an event frame", () => {
    const event = EventEnvelopeSchema.parse({
      seq: 3,
      ts: 1_724_800_000_000,
      taskId,
      payload: {
        type: "task.created",
        task: {
          id: taskId,
          status: "pending",
          title: "t",
          initiatorModelId: ModelIdSchema.parse("anthropic/claude-sonnet-5"),
          conversationFingerprint: null,
          settings: {},
          resultSummary: null,
          error: null,
          createdAt: 1_724_800_000_000,
          updatedAt: 1_724_800_000_000,
          finishedAt: null,
        },
      },
    });
    const frame = SocketServerMessageSchema.parse({ type: "event", event });
    expect(frame.type === "event" && frame.event.seq).toBe(3);
  });

  it("refuses an event frame carrying something that is not an envelope", () => {
    // The dashboard folds whatever arrives here; a half-shaped envelope would
    // land in `orphanedEvents` at best and corrupt the tree at worst.
    expect(
      SocketServerMessageSchema.safeParse({ type: "event", event: { seq: 1, ts: 2 } }).success,
    ).toBe(false);
  });

  it("parses an error frame", () => {
    expect(
      SocketServerMessageSchema.parse({ type: "error", message: "message must be JSON" }),
    ).toEqual({ type: "error", message: "message must be JSON" });
  });
});
