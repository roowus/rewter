/**
 * What the daemon knows about itself — `/internal/health` on a screen.
 *
 * Everything here is a fact the process already had and displayed nowhere:
 * how long it has been up (a launchd KeepAlive restart is exactly the thing
 * this catches), what it is listening on, how much of the registry is actually
 * enabled, where the database lives and how big it has got, and whether
 * anything is parked waiting for someone to approve something. The survey of
 * other routers' dashboards called this the biggest single gap, and it is the
 * cheapest to fill: one endpoint the daemon already serves.
 *
 * Conspicuously absent: latency. The daemon times nothing per request, and a
 * number on an ops page is read as measured — a blank row is honest, a
 * plausible one is not.
 *
 * Uptime ticks against the page's shared `now` clock rather than refetching
 * every second: the fetch below is for the facts that only the daemon can
 * count, not for the passage of time.
 */
import type { DaemonHealth } from "@rewter/shared";
import { type ReactNode, useEffect, useState } from "react";
import { bytes, duration } from "./format.js";
import { fetchHealth } from "./health.js";
import { useDashboard } from "./store.js";

const POLL_MS = 10_000;

function Fact({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="fact" title={title}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function HealthPanel({ now }: { now: number }): JSX.Element {
  const [health, setHealth] = useState<DaemonHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastSeq = useDashboard((s) => s.fold.lastSeq);

  // Refetch on the socket tick (something happened) and on a slow interval
  // (uptime's friends — event and task counts — move without the socket, when
  // the socket itself is down or the traffic is pass-through).
  // `lastSeq` is a tick, not an input — see CostsPanel for the same trick.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the socket advances.
  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      void (async () => {
        const result = await fetchHealth({ signal: controller.signal }, fetch);
        if (controller.signal.aborted) return;
        if (result.ok) {
          setHealth(result.health);
          setError(null);
        } else {
          // Keep the last good facts up, same as the costs panel: a health
          // strip that blanks on a transient failure reads as "daemon gone",
          // which is a different and louder claim than "one fetch failed".
          setError(result.message);
        }
      })();
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      clearInterval(id);
      controller.abort();
    };
  }, [lastSeq]);

  if (health === null) {
    return (
      <section className="health" aria-label="daemon health">
        <h2>daemon</h2>
        <p className="empty">{error ?? "loading…"}</p>
      </section>
    );
  }

  const behind = health.events.lastSeq - lastSeq;

  return (
    <section className="health" aria-label="daemon health">
      <h2>daemon</h2>
      {error !== null && <span className="error">{error}</span>}
      <dl className="facts">
        <Fact
          label="uptime"
          title={`pid ${health.pid} · since ${new Date(health.startedAt).toLocaleString()}`}
        >
          {duration(Math.max(0, now - health.startedAt))}
        </Fact>
        <Fact label="version">v{health.version}</Fact>
        <Fact label="url" title={health.url ?? "not listening"}>
          {health.url ?? "—"}
        </Fact>
        <Fact
          label="registry"
          title="enabled/total providers and models; cards = models with a capability card"
        >
          {health.registry.providersEnabled}/{health.registry.providersTotal} providers ·{" "}
          {health.registry.modelsEnabled}/{health.registry.modelsTotal} models ·{" "}
          {health.registry.cards} cards
        </Fact>
        <Fact
          label="db"
          title={health.db.sizeBytes === null ? "in-memory database" : health.db.path}
        >
          {health.db.sizeBytes === null ? health.db.path : bytes(health.db.sizeBytes)}
        </Fact>
        <Fact label="events" title="rows in the event log · highest seq written">
          {health.events.count.toLocaleString()} · seq {health.events.lastSeq.toLocaleString()}
        </Fact>
        <Fact label="tasks">
          {health.tasks.running} running
          {health.tasks.pendingApprovals > 0 && (
            <span className="pending" data-pending="true">
              {" · "}
              {health.tasks.pendingApprovals} awaiting approval
            </span>
          )}
        </Fact>
      </dl>
      {/* The daemon is ahead of this view's fold: replay lag, worth naming
          because a task that is not on screen yet is not finished either. */}
      {behind > 0 && (
        <p className="behind">catching up — {behind.toLocaleString()} events behind</p>
      )}
    </section>
  );
}
