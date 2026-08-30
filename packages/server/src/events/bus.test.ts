/**
 * `stats()` is what `/internal/health` polls to describe the event log, so it
 * is tested for the property that matters there: `lastSeq` is the *highest seq
 * written*, not the row count, and the two part ways the moment anything is
 * deleted. A dashboard that compared its replay cursor against a count would
 * think it was finished while events sat unread.
 */
import { newTaskId } from "@rewter/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db/connection.js";
import { events } from "../db/schema.js";
import { EventBus } from "./bus.js";

let db: ReturnType<typeof openDb>;
let bus: EventBus;

beforeEach(() => {
  db = openDb(":memory:");
  bus = new EventBus(db, () => 1_724_800_000_000);
});

const stubTask = () => newTaskId();

const note = (text: string) => {
  const taskId = newTaskId();
  return { taskId, payload: { type: "task.plan_note" as const, taskId, note: text } };
};

describe("stats", () => {
  it("reports zeros for an empty log", () => {
    expect(bus.stats()).toEqual({ count: 0, lastSeq: 0 });
  });

  it("counts rows and reports the highest seq", () => {
    const a = bus.append(note("one"));
    const b = bus.append(note("two"));
    expect(bus.stats()).toEqual({ count: 2, lastSeq: b.seq });
    expect(b.seq).toBeGreaterThan(a.seq);
  });

  it("keeps lastSeq above count once rows are deleted — AUTOINCREMENT never reuses a seq", () => {
    const first = bus.append(note("one"));
    bus.append(note("two"));
    // Direct table access is deliberate: no repo method deletes events, and the
    // divergence only exists once something has.
    db.delete(events).where(eq(events.seq, first.seq)).run();
    const stats = bus.stats();
    expect(stats.count).toBe(1);
    expect(stats.lastSeq).toBeGreaterThan(stats.count);
    expect(stats.lastSeq).toBeGreaterThan(first.seq);
  });
});

describe("latestEvents", () => {
  // Both fixtures append and return the envelope; they are statements, not
  // values — wrapping one in `bus.append()` again would write it twice.
  const noteEvent = (text: string) => bus.append(note(text));
  const steer = (text: string) => {
    const taskId = stubTask();
    return bus.append({ taskId, payload: { type: "steering.received" as const, taskId, text } });
  };

  it("returns the newest N in ascending order — a table reads top-down regardless of how it paged", () => {
    for (let i = 1; i <= 5; i++) {
      if (i % 2 === 0) steer(`s${i}`);
      else noteEvent(`n${i}`);
    }
    const page = bus.latestEvents({ limit: 3 });
    expect(page.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(page.hasMore).toBe(true);
  });

  it("hasMore is false exactly when the window reaches the beginning of the log", () => {
    noteEvent("one");
    noteEvent("two");
    expect(bus.latestEvents({ limit: 2 }).hasMore).toBe(false);
    expect(bus.latestEvents({ limit: 5 }).hasMore).toBe(false);
  });

  it("pages backwards from beforeSeq, exclusively — no row appears on two pages", () => {
    for (let i = 1; i <= 5; i++) noteEvent(`n${i}`);
    const first = bus.latestEvents({ limit: 2 }); // [4, 5]
    const oldest = first.events[0];
    expect(oldest).toBeDefined();
    const second =
      oldest !== undefined ? bus.latestEvents({ limit: 2, beforeSeq: oldest.seq }) : null; // [2, 3]
    expect(second?.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(new Set([...first.events, ...(second?.events ?? [])]).size).toBe(4);
  });

  it("filters by type inside the window", () => {
    noteEvent("n1");
    steer("s2");
    noteEvent("n3");
    const page = bus.latestEvents({ limit: 10, types: ["steering.received"] });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.payload.type).toBe("steering.received");
  });
});
