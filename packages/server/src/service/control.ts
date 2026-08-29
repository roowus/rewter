/**
 * `status` and `stop`: talking to a daemon this process did not start.
 *
 * Both answer the same question first — *is a rewter actually running?* — and
 * the answer deliberately does not come from the pidfile. A pid is a number
 * that the kernel reuses; a pidfile outlives reboots and `kill -9`s. Signalling
 * a pid because a file mentions it is how a stop command ends up killing an
 * unrelated process that inherited the number.
 *
 * So liveness is a **health probe against the URL the pidfile records**. If
 * `GET /internal/health` answers with rewter's shape, rewter is listening
 * there, which is the thing we wanted to know. Only then is the pid used, and
 * only to deliver the signal.
 *
 * The failure modes are named rather than collapsed into "not running", because
 * they call for different actions from whoever is reading:
 *
 * - `stopped` — no pidfile. Nothing to do.
 * - `stale` — a pidfile whose URL does not answer. The daemon died without
 *   cleaning up; the file is removable and the fact is worth printing, because
 *   it means the last shutdown was not graceful.
 * - `unreachable` — the URL answers, but not like rewter. Something else is on
 *   that port. Emphatically not a thing to send SIGTERM to.
 * - `running` — health answered; the payload is returned with it, so `status`
 *   can print model and provider counts without a second request.
 */
import { readPidfile, removePidfile } from "./pidfile.js";
import type { Pidfile } from "./pidfile.js";

export interface HealthPayload {
  status: string;
  version?: string;
  models?: number;
  providers?: number;
}

export type DaemonStatus =
  | { state: "stopped" }
  | { state: "stale"; entry: Pidfile }
  | { state: "unreachable"; entry: Pidfile; reason: string }
  | { state: "running"; entry: Pidfile; health: HealthPayload };

export interface ProbeOptions {
  fetch?: typeof globalThis.fetch;
  /** Bounded so `status` cannot hang on a socket that accepts and never answers. */
  timeoutMs?: number;
}

/** Probe the recorded URL. Resolves to a state; never throws for a dead daemon. */
export async function daemonStatus(
  pidfilePath: string,
  opts: ProbeOptions = {},
): Promise<DaemonStatus> {
  const entry = readPidfile(pidfilePath);
  if (entry === undefined) return { state: "stopped" };

  const doFetch = opts.fetch ?? globalThis.fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 2_000);

  let res: Response;
  try {
    res = await doFetch(`${entry.url}/internal/health`, { signal });
  } catch {
    // Connection refused, DNS, timeout — all mean nothing is serving there, so
    // the pidfile is a leftover rather than a live claim.
    return { state: "stale", entry };
  }

  if (!res.ok) {
    return { state: "unreachable", entry, reason: `health returned ${res.status}` };
  }
  let health: HealthPayload;
  try {
    health = (await res.json()) as HealthPayload;
  } catch {
    return { state: "unreachable", entry, reason: "health did not return JSON" };
  }
  // Something else on the port answers 200 to anything. `status: "ok"` is the
  // shape check that keeps us from signalling it.
  if (health.status !== "ok") {
    return { state: "unreachable", entry, reason: "not a rewter daemon" };
  }
  return { state: "running", entry, health };
}

export interface StopOptions extends ProbeOptions {
  /** Injectable so tests can stop a daemon without signalling the test runner. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** How long to wait for the process to actually go away. */
  graceMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type StopOutcome =
  | { ok: true; note: string }
  | { ok: false; note: string; state: DaemonStatus["state"] };

/**
 * SIGTERM the running daemon, then wait for it to stop answering.
 *
 * Waiting on the *health probe* rather than on the pid is the same reasoning as
 * above, and it is also the stronger check: what the caller wants to know is
 * that the port is free and no more requests will be served, which is exactly
 * what a health probe that stops answering means.
 *
 * SIGTERM only — no escalation to SIGKILL. rewter's shutdown drains in-flight
 * SSE streams, and killing it harder mid-drain leaves the client parsing a
 * truncated event *and* leaves rows for the next boot's reconciliation to close.
 * If the drain is genuinely stuck, that is worth reporting so a human can decide,
 * not papering over on a timer.
 */
export async function stopDaemon(
  pidfilePath: string,
  opts: StopOptions = {},
): Promise<StopOutcome> {
  const status = await daemonStatus(pidfilePath, opts);

  if (status.state === "stopped") return { ok: true, note: "not running" };
  if (status.state === "stale") {
    // The daemon died without cleaning up. Removing the file is the whole job,
    // and saying so matters: it means the last shutdown was not graceful, and
    // the next boot will have interrupted rows to show for it.
    removePidfile(pidfilePath);
    return { ok: true, note: `not running (removed a stale pidfile for pid ${status.entry.pid})` };
  }
  if (status.state === "unreachable") {
    return {
      ok: false,
      state: status.state,
      note: `refusing to signal pid ${status.entry.pid}: ${status.reason} at ${status.entry.url}`,
    };
  }

  const kill = opts.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const graceMs = opts.graceMs ?? 10_000;

  try {
    kill(status.entry.pid, "SIGTERM");
  } catch (err) {
    // ESRCH between the probe and the signal: the daemon exited on its own in
    // the gap. Rare, and indistinguishable from success from here.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      state: "running",
      note: `could not signal pid ${status.entry.pid}: ${msg}`,
    };
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await sleep(100);
    const now = await daemonStatus(pidfilePath, opts);
    if (now.state !== "running") {
      // A graceful exit removes its own pidfile; a stale one left here means it
      // went down without finishing that, which is still a stop.
      if (now.state === "stale") removePidfile(pidfilePath);
      return { ok: true, note: `stopped (pid ${status.entry.pid})` };
    }
  }

  return {
    ok: false,
    state: "running",
    note: `pid ${status.entry.pid} is still serving ${status.entry.url} ${graceMs}ms after SIGTERM — it may be draining a long stream`,
  };
}

/** One line for `rewter status`, in the shape a human scans rather than parses. */
export function formatStatus(status: DaemonStatus): string {
  switch (status.state) {
    case "stopped":
      return "rewter is not running";
    case "stale":
      return `rewter is not running — stale pidfile for pid ${status.entry.pid} (${status.entry.url}); the last shutdown was not graceful`;
    case "unreachable":
      return `something is on ${status.entry.url}, but it is not rewter — ${status.reason}`;
    case "running": {
      const { models, providers } = status.health;
      const counts =
        models === undefined ? "" : ` — ${providers ?? 0} provider(s), ${models} model(s)`;
      const up = uptime(Date.now() - status.entry.startedAt);
      return `rewter ${status.entry.version} running on ${status.entry.url}, pid ${status.entry.pid}, up ${up}${counts}`;
    }
  }
}

/** Coarse on purpose: "up 3h" is what you want at a glance, not 3h04m12.8s. */
function uptime(ms: number): string {
  if (ms < 0) return "0s"; // clock moved; not worth a negative
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
