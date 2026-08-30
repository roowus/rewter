/**
 * The shell: connect the socket, render the tasks it folds.
 *
 * Newest task first, because the reason to have this open is the thing running
 * now. The connection state gets a permanent line rather than a toast — a
 * dashboard showing a task tree from a socket that died ten minutes ago looks
 * exactly like one that is up to date, and the difference matters.
 */
import { tasksInOrder } from "@rewter/shared";
import { useEffect, useState } from "react";
import { CostsPanel } from "./CostsPanel.js";
import { HealthPanel } from "./HealthPanel.js";
import { RegistryPanel } from "./RegistryPanel.js";
import { TaskTree } from "./TaskTree.js";
import { useDashboard } from "./store.js";

const STATUS_TEXT = {
  idle: "not connected",
  connecting: "connecting…",
  live: "live",
  reconnecting: "reconnecting…",
} as const;

/**
 * One clock for the whole page, ticking a second at a time.
 *
 * Durations have to advance for a running task, but a `Date.now()` inside each
 * row would be a different instant per row and would re-render on every parent
 * render. One value, passed down, keeps the components pure functions of props.
 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function App(): JSX.Element {
  const { status, fold, replayed, error, connect, disconnect } = useDashboard();
  const now = useNow();

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  const tasks = tasksInOrder(fold).reverse();

  return (
    <main>
      <header className="app-head">
        <h1>rewter</h1>
        <span className="conn" data-status={status}>
          {STATUS_TEXT[status]}
        </span>
        {/* `replayed` distinguishes "already current" from "still loading" — a
            quiet daemon and a stalled one look identical without it. */}
        {status === "live" && replayed > 0 && (
          <span className="replayed">replayed {replayed} events</span>
        )}
        {error !== null && <span className="error">{error}</span>}
      </header>

      {/* Not an error: a fold that started mid-stream cannot be complete, and
          `orphanedEvents` is the only way a reader can tell that happened. */}
      {fold.orphanedEvents > 0 && (
        <p className="orphaned">
          {fold.orphanedEvents} events refer to tasks this view never saw created — history was
          trimmed, or this feed started partway through.
        </p>
      )}

      {/* Above the tree: the daemon's own facts — uptime, registry reachability,
          database footprint, approvals parked. Facts it already knew. */}
      <HealthPanel now={now} />

      {/* Above the tree: it is the daemon's whole spend, including the
          pass-through traffic no task in the tree accounts for. */}
      <CostsPanel />

      {/* Collapsed by default and below the spend: what a model costs is the
          question that sends you looking for the editor in the first place. */}
      <RegistryPanel />

      {tasks.length === 0 ? (
        <p className="empty">
          No tasks yet. Point a client at <code>auto/orchestrator</code> and one will appear here.
        </p>
      ) : (
        tasks.map((task) => <TaskTree task={task} now={now} key={task.task.id} />)
      )}
    </main>
  );
}
