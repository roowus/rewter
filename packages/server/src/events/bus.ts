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
  type EventType,
  type NewEvent,
  NewEventSchema,
} from "@rewter/shared";
import { and, asc, count, desc, eq, gt, inArray, lt, max } from "drizzle-orm";
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

  /**
   * The newest `limit` events (optionally only those older than `beforeSeq`),
   * with filters — the event table's window, as opposed to `eventsAfter`'s
   * replay cursor.
   *
   * The two read the same table in opposite directions because they answer
   * different questions. Replay asks "everything after this point, in order" —
   * a socket resuming wants the oldest unseen first and will read them all. The
   * table asks "the most recent N that match" — an operator inspecting a log
   * starts at the bottom and pages *backwards* through history, so this scans
   * descending and returns the window re-sorted ascending (a table row order
   * that flipped with the paging direction would be unreadable).
   *
   * `hasMore` is whether older matching events exist past the window. Asking
   * for `limit + 1` and dropping the extra answers that in one scan — a
   * separate `COUNT(*)` would cost a second walk of the same rows.
   */
  latestEvents(opts: {
    limit: number;
    /** Exclusive upper bound: the seq of the oldest row already on screen. */
    beforeSeq?: number;
    taskId?: string;
    types?: EventType[];
  }): { events: EventEnvelope[]; hasMore: boolean } {
    const where = and(
      opts.beforeSeq !== undefined ? lt(events.seq, opts.beforeSeq) : undefined,
      opts.taskId !== undefined ? eq(events.taskId, opts.taskId) : undefined,
      opts.types !== undefined ? inArray(events.type, opts.types) : undefined,
    );
    const rows = this.db
      .select()
      .from(events)
      .where(where)
      .orderBy(desc(events.seq))
      .limit(opts.limit + 1)
      .all();
    const hasMore = rows.length > opts.limit;
    return { events: rows.slice(0, opts.limit).reverse().map(rowToEnvelope), hasMore };
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
