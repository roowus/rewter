/**
 * The dashboard socket contract: `WS /internal/ws`.
 *
 * The dashboard's problem is not "get the events" — `GET /internal/events` has
 * done that since M1. It is *getting them without a gap*: poll on an interval
 * and a task can finish between two polls, so the tree jumps rather than moves;
 * poll fast enough to hide that and a live daemon spends its life answering.
 *
 * So the socket does replay and live in one place, and the seam between them is
 * the part worth designing. A client subscribes with the highest `seq` it has
 * folded; the server replays everything after it and *then* attaches the live
 * listener. Attaching first would interleave a live event ahead of the replay
 * that precedes it — out of order, which the fold would count as orphaned. This
 * way the client can receive an event twice (one appended mid-replay), and a
 * duplicate is exactly what the fold's `seq <= lastSeq` guard already drops.
 * Reordering it cannot fix; redelivery it handles for free.
 *
 * Messages are one-way in practice: the client sends `subscribe` and then
 * listens. Approve/deny stay REST POSTs — they are actions with outcomes worth
 * a status code, not stream traffic.
 */
import { z } from "zod";
import { EventEnvelopeSchema } from "./events.js";
import { TaskIdSchema } from "./ids.js";

/**
 * Client → server. `afterSeq` is the client's own `FoldState.lastSeq`, so a
 * reconnect resumes rather than refolds; omit it (or send 0) for everything.
 *
 * `taskId` narrows both the replay and the live feed to one task. It is a
 * filter, not an authorization boundary: `/internal` is localhost-bound and a
 * client asking for everything gets everything.
 */
export const SocketSubscribeSchema = z.object({
  type: z.literal("subscribe"),
  afterSeq: z.number().int().nonnegative().optional(),
  taskId: TaskIdSchema.optional(),
});
export type SocketSubscribe = z.infer<typeof SocketSubscribeSchema>;

export const SocketClientMessageSchema = z.discriminatedUnion("type", [SocketSubscribeSchema]);
export type SocketClientMessage = z.infer<typeof SocketClientMessageSchema>;

/**
 * Server → client.
 *
 * `ready` marks the replay/live seam: everything before it is history, and the
 * `seq` it carries is what the client would resume from if the socket dropped
 * right then. A dashboard can use it to stop showing a loading state without
 * guessing from a quiet socket.
 */
export const SocketReadySchema = z.object({
  type: z.literal("ready"),
  /** Highest `seq` sent during replay — or the client's `afterSeq` if none was. */
  seq: z.number().int().nonnegative(),
  /** How many events the replay carried, so an empty one is distinguishable. */
  replayed: z.number().int().nonnegative(),
  taskId: TaskIdSchema.nullable(),
});
export type SocketReady = z.infer<typeof SocketReadySchema>;

export const SocketEventSchema = z.object({
  type: z.literal("event"),
  event: EventEnvelopeSchema,
});
export type SocketEvent = z.infer<typeof SocketEventSchema>;

/**
 * A message the server could not act on. Sent instead of closing the socket: a
 * dashboard that mistypes one subscription should see why, not silently lose
 * its connection and retry the same thing forever.
 */
export const SocketErrorSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});
export type SocketError = z.infer<typeof SocketErrorSchema>;

export const SocketServerMessageSchema = z.discriminatedUnion("type", [
  SocketReadySchema,
  SocketEventSchema,
  SocketErrorSchema,
]);
export type SocketServerMessage = z.infer<typeof SocketServerMessageSchema>;
