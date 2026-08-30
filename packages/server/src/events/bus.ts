/**
 * Event bus: appends events to the append-only `events` table (assigning seq/ts)
 * and fans them out to in-process subscribers (SSE narrator, dashboard WS, stats).
 *
 * Append is synchronous (better-sqlite3), so a subscriber never sees an event
 * that isn't durably ordered. Replay = `eventsAfter(seq)`.
 */
import {
  type EventEnvelope,
  EventEnvelopeSchema,
  type NewEvent,
  NewEventSchema,
} from "@rewter/shared";
import { and, asc, count, eq, gt, max } from "drizzle-orm";
import type { Db } from "../db/connection.js";
import { events } from "../db/schema.js";

export type EventListener = (event: EventEnvelope) => void;

export class EventBus {
  private listeners = new Set<EventListener>();

  constructor(
    private readonly db: Db,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Validate, persist (seq assigned by AUTOINCREMENT), then notify listeners. */
  append(input: NewEvent): EventEnvelope {
    const ev = NewEventSchema.parse(input);
    const row = this.db
      .insert(events)
      .values({
        ts: this.clock(),
        taskId: ev.taskId,
        type: ev.payload.type,
        payloadJson: JSON.stringify(ev.payload),
      })
      .returning()
      .get();
    const envelope = rowToEnvelope(row);
    for (const listener of this.listeners) {
      try {
        listener(envelope);
      } catch {
        // A broken subscriber must never break the write path.
      }
    }
    return envelope;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * How much log there is, without reading any of it.
   *
   * `lastSeq` is `MAX(seq)` rather than the count: AUTOINCREMENT never reuses a
   * number, so once anything is deleted the two diverge, and the cursor a
   * dashboard compares itself against is the max. Both are one indexed scan, so
   * the health route can answer them on every poll.
   */
  stats(): { count: number; lastSeq: number } {
    const row = this.db
      .select({ count: count(), lastSeq: max(events.seq) })
      .from(events)
      .get();
    return { count: row?.count ?? 0, lastSeq: row?.lastSeq ?? 0 };
  }

  /** Replay: all events with seq > afterSeq, in seq order. */
  eventsAfter(afterSeq: number, taskId?: string): EventEnvelope[] {
    const where =
      taskId === undefined
        ? gt(events.seq, afterSeq)
        : and(gt(events.seq, afterSeq), eq(events.taskId, taskId));
    const rows = this.db.select().from(events).where(where).orderBy(asc(events.seq)).all();
    return rows.map(rowToEnvelope);
  }
}

function rowToEnvelope(row: typeof events.$inferSelect): EventEnvelope {
  return EventEnvelopeSchema.parse({
    seq: row.seq,
    ts: row.ts,
    taskId: row.taskId,
    payload: JSON.parse(row.payloadJson),
  });
}
