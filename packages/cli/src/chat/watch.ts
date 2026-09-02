/**
 * Watch one task over the daemon's socket and fold it.
 *
 * `WS /internal/ws` is the dashboard's feed: subscribe with a task id, receive
 * the task's history as replay, then live events, with `ready` marking the seam
 * (`@rewter/shared` `socket.ts`). The terminal client uses the very same
 * contract and the very same fold (`fold.ts`), so the tree it draws is, by
 * construction, the tree the dashboard draws — one fold, two renderers.
 *
 * Node ≥ 22 ships a WHATWG `WebSocket` whose constructor takes `headers`, so
 * the `x-api-key` the REST calls send goes on the upgrade too and a keyed
 * daemon over the tailnet works without a dependency. The constructor is
 * injectable because a test wants to *be* the daemon: push envelopes, watch the
 * fold move.
 *
 * Failure is soft on purpose. The socket is how the tree stays live; the SSE
 * stream is how the turn happens. If the socket cannot connect (an older
 * daemon, a proxy that drops upgrades) the turn still runs — the caller just
 * has no tree, and `failure` says why so the client can print one line about
 * it instead of a silently emptier screen.
 */
import {
  type EventEnvelope,
  type FoldState,
  type FoldedTask,
  SocketServerMessageSchema,
  TASK_TRANSITIONS,
  applyEvent,
  emptyFoldState,
  isTerminal,
} from "@rewter/shared";
import type { Connection } from "./client.js";

/** The slice of the WHATWG interface this module touches; Node's global satisfies it. */
export interface SocketLike {
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (ev: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

/** `new WebSocket(url, { headers })` — Node 22's global, typed via undici. */
export const nodeSocket: SocketFactory = (url, headers) =>
  new WebSocket(url, { headers }) as unknown as SocketLike;

export interface TaskWatcher {
  /** The task as folded so far; `undefined` until its `task.created` arrives. */
  readonly task: FoldedTask | undefined;
  /** Why there is no live view, once known; `null` while the socket is healthy. */
  readonly failure: string | null;
  /** Called after every event that changed the fold. */
  onChange(listener: (task: FoldedTask) => void): void;
  /**
   * Resolves once the task has reached a terminal status — or after `timeoutMs`,
   * whichever comes first. The stream's `[DONE]` and the socket's last events
   * ride different connections, so a footer printed the instant the stream ends
   * could be printed before the final cost record lands.
   */
  settled(timeoutMs: number): Promise<void>;
  close(): void;
}

/** `http://host:port` → `ws://host:port/internal/ws`; `https` → `wss`. */
export function socketUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, "ws")}/internal/ws`;
}

export function watchTask(
  conn: Connection,
  taskId: string,
  factory: SocketFactory = nodeSocket,
): TaskWatcher {
  let state: FoldState = emptyFoldState();
  let failure: string | null = null;
  let closed = false;
  const listeners: Array<(task: FoldedTask) => void> = [];
  const settleWaiters: Array<() => void> = [];

  let socket: SocketLike;
  try {
    socket = factory(socketUrl(conn.baseUrl), conn.headers);
  } catch (err) {
    failure = `socket unavailable: ${(err as Error).message}`;
    return stub();
  }

  const current = (): FoldedTask | undefined => state.tasks[taskId];
  const isSettled = (): boolean => {
    const task = current();
    return task !== undefined && isTerminal(TASK_TRANSITIONS, task.task.status);
  };
  const wakeSettled = (): void => {
    for (const wake of settleWaiters.splice(0)) wake();
  };

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "subscribe", taskId }));
  });
  socket.addEventListener("message", (ev) => {
    const parsed = SocketServerMessageSchema.safeParse(parseJson(ev.data));
    if (!parsed.success) return; // not ours to understand; the fold's guard would drop it anyway
    const msg = parsed.data;
    if (msg.type === "error") {
      failure = `socket refused: ${msg.message}`;
      return;
    }
    if (msg.type !== "event") return;
    const next = applyEvent(state, msg.event as EventEnvelope);
    if (next === state) return;
    state = next;
    const task = current();
    if (task === undefined) return;
    for (const listener of listeners) listener(task);
    if (isSettled()) wakeSettled();
  });
  socket.addEventListener("error", () => {
    // `close` follows with the same story; the error event carries no message
    // on the WHATWG interface, so the reason is taken from there.
    if (failure === null) failure = "socket error";
  });
  socket.addEventListener("close", (ev) => {
    closed = true;
    if (failure === null && !isSettled()) {
      const why = ev.reason !== undefined && ev.reason !== "" ? `: ${ev.reason}` : "";
      failure = `socket closed (${ev.code ?? "?"})${why}`;
    }
    if (failure === "socket error") failure = `socket unavailable (${ev.code ?? "?"})`;
    wakeSettled();
  });

  return {
    get task() {
      return current();
    },
    get failure() {
      return failure;
    },
    onChange(listener) {
      listeners.push(listener);
    },
    settled(timeoutMs) {
      if (isSettled() || closed) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(done, timeoutMs);
        function done(): void {
          clearTimeout(timer);
          resolve();
        }
        settleWaiters.push(done);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      wakeSettled();
      try {
        socket.close();
      } catch {
        // already gone
      }
    },
  };

  function stub(): TaskWatcher {
    return {
      task: undefined,
      get failure() {
        return failure;
      },
      onChange() {},
      settled: () => Promise.resolve(),
      close() {},
    };
  }
}

function parseJson(data: unknown): unknown {
  const text =
    typeof data === "string"
      ? data
      : data instanceof ArrayBuffer
        ? new TextDecoder().decode(data)
        : String(data);
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
