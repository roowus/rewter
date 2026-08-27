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
import { and, asc, eq, gt } from "drizzle-orm";
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
