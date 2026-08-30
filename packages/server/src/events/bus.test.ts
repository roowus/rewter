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
