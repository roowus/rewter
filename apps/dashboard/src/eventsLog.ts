/**
 * Fetching a window of the event log — the table's data path, as opposed to
 * the socket the task tree folds. Same reasoning as the costs panel: the fold
 * aggregates as it replays and keeps no raw envelopes, so "show me the log"
 * has to ask the daemon. The window (not the whole log) is the point: a
 * daemon that has been up for weeks has thousands of events, and the table
 * starts at the newest and pages backwards on demand.
 *
 * Parsed, not cast: an envelope shape the bundle half-understands would fold
 * garbage into the table silently.
 */
import { type EventEnvelope, EventEnvelopeSchema } from "@rewter/shared";
import { z } from "zod";

const EventsWindowSchema = z.object({
  events: z.array(EventEnvelopeSchema),
  hasMore: z.boolean(),
});

export interface EventsWindow {
  events: EventEnvelope[];
  hasMore: boolean;
}

export type EventsResult = { ok: true; window: EventsWindow } | { ok: false; message: string };

export interface FetchEventsOptions {
  /** Page size — also the ceiling the server enforces (see MAX_EVENT_PAGE). */
  latest: number;
  /** Exclusive upper seq: "older than the oldest row I already have". */
  before?: number;
  taskId?: string;
  /** Comma-separated event types, validated by the server against the union. */
  type?: string;
  signal?: AbortSignal;
}

export async function fetchEventsWindow(
  options: FetchEventsOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<EventsResult> {
  const params = new URLSearchParams({ latest: String(options.latest) });
  if (options.before !== undefined) params.set("before", String(options.before));
  if (options.taskId !== undefined) params.set("taskId", options.taskId);
  if (options.type !== undefined) params.set("type", options.type);

  let response: Response;
  try {
    response = await fetchImpl(`/internal/events?${params.toString()}`, {
      ...(options.signal !== undefined && { signal: options.signal }),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      return { ok: false, message: "aborted" };
    }
    return { ok: false, message: "daemon unreachable" };
  }

  if (!response.ok) return { ok: false, message: `daemon said ${response.status}` };
  const parsed = EventsWindowSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { ok: false, message: "unrecognized response from daemon" };
  return { ok: true, window: parsed.data };
}

/** Merge a backwards page into loaded rows, keyed by seq — pages may overlap at the seam. */
export function mergeBySeq(loaded: EventEnvelope[], older: EventEnvelope[]): EventEnvelope[] {
  const bySeq = new Map(older.map((e) => [e.seq, e]));
  for (const e of loaded) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq);
}
