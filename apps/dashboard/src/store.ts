/**
 * The dashboard's whole state: one socket, one `FoldState`.
 *
 * There is no fetching layer and no cache, because there is nothing to cache —
 * the daemon's answer to "what is happening" *is* the event stream, and the
 * fold that turns it into a task tree lives in `@rewter/shared` and is the same
 * function the server would use. A REST layer here would be a second answer to
 * the same question, and the one on screen would be the one nobody tested.
 *
 * So this file is mostly socket lifecycle: connect, subscribe from where we
 * left off, fold what arrives, and reconnect without losing our place.
 */
import {
  type FoldState,
  type SocketServerMessage,
  SocketServerMessageSchema,
  applyEvent,
  emptyFoldState,
} from "@rewter/shared";
import { create } from "zustand";

export type ConnectionStatus =
  | "idle"
  /** Socket opening, or open but the replay has not finished. */
  | "connecting"
  /** `ready` seen: history is folded and we are on the live feed. */
  | "live"
  /** Dropped; a reconnect is scheduled. Prior state is still on screen. */
  | "reconnecting";

export interface DashboardState {
  status: ConnectionStatus;
  fold: FoldState;
  /**
   * How many events the last `ready` replayed. Distinguishes "already current"
   * from "still loading" for a dashboard that connected to a quiet daemon.
   */
  replayed: number;
  /** Last socket-level problem, kept for the status bar rather than thrown. */
  error: string | null;

  connect(url?: string): void;
  disconnect(): void;
  /** Test seam: apply a server frame as if it had arrived on the socket. */
  ingest(message: SocketServerMessage): void;
}

/** Same-origin in production (the daemon serves this bundle); proxied in dev. */
function defaultUrl(): string {
  const proto = globalThis.location?.protocol === "https:" ? "wss:" : "ws:";
  const host = globalThis.location?.host ?? "127.0.0.1:20130";
  return `${proto}//${host}/internal/ws`;
}

/**
 * Backoff, capped. A dashboard left open on a laptop that sleeps will retry for
 * hours; without a cap that is a tight loop against a daemon that is not there.
 */
const RECONNECT_MS = [250, 500, 1000, 2000, 5000] as const;
const reconnectDelay = (attempt: number): number =>
  RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)] ?? 5000;

export const useDashboard = create<DashboardState>((set, get) => {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  /** Set on `disconnect()` so a close in flight does not schedule a retry. */
  let closing = false;

  function open(url: string): void {
    socket = new WebSocket(url);
    set({ status: get().fold.lastSeq > 0 ? "reconnecting" : "connecting" });

    socket.addEventListener("open", () => {
      attempt = 0;
      // Resume from what we have already folded rather than refolding from the
      // top: on a long-lived daemon the difference is the whole history.
      socket?.send(JSON.stringify({ type: "subscribe", afterSeq: get().fold.lastSeq }));
    });

    socket.addEventListener("message", (ev) => {
      const parsed = SocketServerMessageSchema.safeParse(JSON.parse(String(ev.data)));
      // A frame this client cannot parse is the daemon being newer than the
      // bundle. Dropping it keeps the rest of the feed working; folding a
      // half-shaped envelope would corrupt the tree instead.
      if (!parsed.success) {
        set({ error: "unrecognized message from daemon" });
        return;
      }
      get().ingest(parsed.data);
    });

    socket.addEventListener("close", () => {
      socket = null;
      if (closing) {
        set({ status: "idle" });
        return;
      }
      set({ status: "reconnecting" });
      timer = setTimeout(() => open(url), reconnectDelay(attempt++));
    });

    // `error` is always followed by `close`, which is where the retry lives.
    socket.addEventListener("error", () => set({ error: "socket error" }));
  }

  return {
    status: "idle",
    fold: emptyFoldState(),
    replayed: 0,
    error: null,

    connect(url = defaultUrl()) {
      if (socket !== null) return;
      closing = false;
      open(url);
    },

    disconnect() {
      closing = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      socket?.close();
      socket = null;
      set({ status: "idle" });
    },

    ingest(message) {
      if (message.type === "error") {
        set({ error: message.message });
        return;
      }
      if (message.type === "ready") {
        set({ status: "live", replayed: message.replayed, error: null });
        return;
      }
      const before = get().fold;
      const after = applyEvent(before, message.event);
      // Identity, not deep-equality: `applyEvent` returns the *same* object for
      // an event at or below `lastSeq`, which is exactly the replay/live overlap
      // and the common case. Setting state anyway would re-render the whole tree
      // on every duplicate.
      if (after !== before) set({ fold: after });
    },
  };
});
