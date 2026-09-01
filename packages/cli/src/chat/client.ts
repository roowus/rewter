/**
 * The TUI's side of the daemon's public surfaces.
 *
 * Everything here talks to endpoints the dashboard already uses — chat over
 * `/v1/chat/completions`, steering over `/internal/tasks/:id/steer`, approvals
 * over `/internal/approvals/:id` — so this module adds no server surface, only
 * a client for the existing one. The shapes come from `@rewter/shared`; the
 * TUI never invents a contract.
 *
 * Discovery reuses the pidfile: `rewter start` records where it bound, and
 * `daemonStatus` probes that URL before we trust it — the same "a pidfile is a
 * claim, not a fact" reasoning as `rewter stop`. `REWTER_URL` overrides it for
 * the tailnet case, where the daemon lives on another machine and no local
 * pidfile speaks for it.
 *
 * Auth: `/internal` is gated by `REWTER_INTERNAL_KEY` when the daemon is
 * shared beyond loopback, and `/v1` by `REWTER_API_KEY` when configured. Both
 * guards accept `x-api-key`, so that is the one header convention used here —
 * sent unconditionally when the env var is set, harmless when the daemon
 * doesn't check it.
 */
import { daemonStatus } from "@rewter/server";
import { type SteerTaskResult, SteerTaskResultSchema } from "@rewter/shared";

export interface Connection {
  baseUrl: string;
  /** Headers carrying the internal/API keys; {} when none are configured. */
  headers: Record<string, string>;
}

export type Discovery = { ok: true; connection: Connection } | { ok: false; reason: string };

export interface DiscoverOptions {
  env: NodeJS.ProcessEnv;
  pidfilePath: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Find a daemon to talk to: `REWTER_URL` wins (the remote/tailnet case),
 * otherwise the pidfile's URL — but only after the health probe confirms
 * something rewter-shaped is actually serving there.
 */
export async function discoverDaemon(opts: DiscoverOptions): Promise<Discovery> {
  const override = opts.env.REWTER_URL;
  if (override !== undefined && override !== "") {
    return { ok: true, connection: connectionFor(override, opts.env) };
  }

  const status = await daemonStatus(opts.pidfilePath, {
    ...(opts.fetch !== undefined && { fetch: opts.fetch }),
  });
  switch (status.state) {
    case "running":
      return { ok: true, connection: connectionFor(status.entry.url, opts.env) };
    case "stopped":
      return { ok: false, reason: "rewter is not running — start it with `rewter start`" };
    case "stale":
      return {
        ok: false,
        reason: `rewter is not running (stale pidfile for pid ${status.entry.pid}) — start it with \`rewter start\``,
      };
    case "unreachable":
      return {
        ok: false,
        reason: `something is on ${status.entry.url}, but it is not rewter — ${status.reason}`,
      };
  }
}

function connectionFor(url: string, env: NodeJS.ProcessEnv): Connection {
  const headers: Record<string, string> = {};
  // One header both guards accept; see the module comment. The internal key
  // matters on /internal routes, the API key on /v1 — when both are set they
  // are usually the same value, but sending the more specific one wins.
  const key = env.REWTER_INTERNAL_KEY ?? env.REWTER_API_KEY;
  if (key !== undefined && key !== "") headers["x-api-key"] = key;
  return { baseUrl: url.replace(/\/$/, ""), headers };
}

/** The daemon's error envelope, when there is one worth relaying. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (typeof body.error?.message === "string") return body.error.message;
  } catch {
    // fall through — not JSON, or empty
  }
  return `daemon returned ${res.status}`;
}

export type SteerOutcome =
  | { ok: true; result: SteerTaskResult }
  | { ok: false; status: number; reason: string };

/**
 * `POST /internal/tasks/:id/steer` — the client half of mid-run prompting.
 *
 * The distinct failure statuses are worth keeping distinct for the prompt
 * line: 409 means "this task can no longer hear you" (finished, or orphaned by
 * a restart), which the TUI should say instead of silently eating the message.
 */
export async function steerTask(
  conn: Connection,
  fetchImpl: typeof globalThis.fetch,
  taskId: string,
  message: string,
): Promise<SteerOutcome> {
  const res = await fetchImpl(`${conn.baseUrl}/internal/tasks/${taskId}/steer`, {
    method: "POST",
    headers: { ...conn.headers, "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) return { ok: false, status: res.status, reason: await errorMessage(res) };
  const parsed = SteerTaskResultSchema.safeParse(await res.json());
  if (!parsed.success) {
    return { ok: false, status: res.status, reason: "daemon answered with an unexpected shape" };
  }
  return { ok: true, result: parsed.data };
}

export type SimpleOutcome = { ok: true } | { ok: false; status: number; reason: string };

/** `POST /internal/approvals/:id` — the same gate the dashboard buttons hit. */
export async function resolveApproval(
  conn: Connection,
  fetchImpl: typeof globalThis.fetch,
  approvalId: string,
  approved: boolean,
  note?: string,
): Promise<SimpleOutcome> {
  const res = await fetchImpl(`${conn.baseUrl}/internal/approvals/${approvalId}`, {
    method: "POST",
    headers: { ...conn.headers, "content-type": "application/json" },
    body: JSON.stringify({ approved, ...(note !== undefined && note !== "" && { note }) }),
  });
  if (!res.ok) return { ok: false, status: res.status, reason: await errorMessage(res) };
  return { ok: true };
}

/** `POST /internal/tasks/:id/cancel` — the kill switch, same as the dashboard's. */
export async function cancelTask(
  conn: Connection,
  fetchImpl: typeof globalThis.fetch,
  taskId: string,
): Promise<SimpleOutcome> {
  const res = await fetchImpl(`${conn.baseUrl}/internal/tasks/${taskId}/cancel`, {
    method: "POST",
    headers: conn.headers,
  });
  if (!res.ok) return { ok: false, status: res.status, reason: await errorMessage(res) };
  return { ok: true };
}
