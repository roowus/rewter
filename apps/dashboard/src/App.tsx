/**
 * The shell: connect the socket, render the tasks it folds.
 *
 * Newest task first, because the reason to have this open is the thing running
 * now. The connection state gets a permanent line rather than a toast — a
 * dashboard showing a task tree from a socket that died ten minutes ago looks
 * exactly like one that is up to date, and the difference matters.
 */
import { type DaemonHealth, tasksInOrder } from "@rewter/shared";
import { useEffect, useState } from "react";
import { CostsPanel } from "./CostsPanel.js";
import { DaemonFooter } from "./DaemonFooter.js";
import { EventsPanel } from "./EventsPanel.js";
import { FailuresPanel } from "./FailuresPanel.js";
import { HealthPanel } from "./HealthPanel.js";
import { ProjectsPanel } from "./ProjectsPanel.js";
import { ProvidersPanel } from "./ProvidersPanel.js";
import { ReadinessCard } from "./ReadinessCard.js";
import { RegistryPanel } from "./RegistryPanel.js";
import { RunPanel } from "./RunPanel.js";
import { SkillsPanel } from "./SkillsPanel.js";
import { TaskTree } from "./TaskTree.js";
import { TranslatePanel } from "./TranslatePanel.js";
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
  // Fetched once by the health panel, read twice. `setState` is stable, so the
  // panel's effect can hold onto it without refetching every render.
  const [health, setHealth] = useState<DaemonHealth | null>(null);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  const tasks = tasksInOrder(fold).reverse();

  return (
    <main>
      <header className="app-head">
        <h1>rewter</h1>
        {/* The dot carries the same `data-status` as the words beside it, so
            colour and text can never disagree; it exists because the words are
            small and grey and a reader scanning the page skips them, which is
            precisely the moment a dead socket matters. `aria-hidden` because it
            is a second rendering of the label, not a second fact. */}
        <span className="conn" data-status={status}>
          <span className="conn-dot" data-status={status} aria-hidden="true" />
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
      <HealthPanel now={now} onHealth={setHealth} />

      {/* Above the tree: it is the daemon's whole spend, including the
          pass-through traffic no task in the tree accounts for. */}
      <CostsPanel />

      {/* Beside spend: what the upstreams cost in a different currency. The
          retried failures here are the ones no task in the tree shows. */}
      <FailuresPanel />

      {/* Above the registry, because it is the prior question: a model's price
          is irrelevant if the provider under it is holding an unset key. */}
      <ProvidersPanel />

      {/* Collapsed by default and below the spend: what a model costs is the
          question that sends you looking for the editor in the first place. */}
      <RegistryPanel />

      {/* Below the registry, above the run box: a project is what a run *uses*
          — policy, workspace, pin — so it sits between the catalog and the
          control that starts work under it. */}
      <ProjectsPanel />

      {/* Below projects, which own the scopes skills land in. Fetches its
          count even while collapsed: a proposed skill is a question waiting
          on the owner, and the header is where the question shows. */}
      <SkillsPanel />

      {/* Collapsed, and next to the log for the same reason: both are opened
          when something has gone wrong. This one answers the question the log
          cannot — not what the daemon did, but what the upstream was handed. */}
      <TranslatePanel />

      {/* Also collapsed: the raw log is the inspection view — expanded when
          someone wants to know exactly what the daemon did, in order. */}
      <EventsPanel />

      {/* Directly above the tree, because the tree is where its output goes:
          the task this starts appears in the next rows down, and the panel
          deliberately shows nothing of it beyond a name. Collapsed, unlike the
          reporting panels — it is the one control on the page that spends. */}
      <RunPanel />

      {/* The empty state earns its space by saying whether a task *could* run,
          not just that none has. Once one has, the question is answered by
          demonstration and the card goes away. */}
      {tasks.length === 0 ? (
        <ReadinessCard health={health} />
      ) : (
        tasks.map((task) => <TaskTree task={task} now={now} key={task.task.id} />)
      )}

      {/* Last, and below everything: the standing "this is your machine"
          statement, and the only control on the page that ends the process. */}
      <DaemonFooter version={health?.version ?? null} />
    </main>
  );
}
