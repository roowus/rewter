/**
 * The event log, as a table — survey shortlist item 2. rewter's log is its
 * best asset (it is the source of truth everything else folds) and until now
 * it was only readable as a task tree: aggregated, and gone for rows the fold
 * drops (pass-through costs, resolved approvals, finished runs).
 *
 * Collapsed by default, because the reason to open the dashboard is the task
 * that is running; this is the inspection view you expand when you want to
 * know *exactly* what the daemon did. Filters go to the server (`?type=`,
 * `?taskId=`) — the log can be thousands of rows and "fetch everything, then
 * filter in the browser" is the anti-pattern the windowed endpoint exists to
 * avoid.
 *
 * One rule is non-obvious: paging back pauses the live tail. The newest window
 * refreshes on every socket tick; an operator who has scrolled into history
 * with "load older" is *reading* a moment, and prepending rows under their
 * eyes would yank the view. The panel says the tail is paused and offers to
 * jump back, rather than silently going stale or silently moving.
 */
import { EVENT_TYPES, type EventEnvelope, type EventType, tasksInOrder } from "@rewter/shared";
import { useEffect, useMemo, useState } from "react";
import { describeEvent, oneLine } from "./eventSummary.js";
import { fetchEventsWindow, mergeBySeq } from "./eventsLog.js";
import { clockTime } from "./format.js";
import { useDashboard } from "./store.js";

const PAGE = 100;
const POLL_MS = 10_000;

/** `task_h4x8f…` — the last six of a branded id are the distinguishable part. */
function shortTaskId(id: string): string {
  return `…${id.slice(-6)}`;
}

export function EventsPanel(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"all" | EventType>("all");
  const [taskId, setTaskId] = useState<"all" | string>("all");
  const [rows, setRows] = useState<EventEnvelope[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [pagedBack, setPagedBack] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSeq = useDashboard((s) => s.fold.lastSeq);
  const fold = useDashboard((s) => s.fold);

  // Task titles for the filter dropdown, from the fold the socket maintains —
  // the log has ids, the fold knows what they were called.
  const tasks = useMemo(() => tasksInOrder(fold).reverse(), [fold]);

  const filters =
    type === "all" && taskId === "all"
      ? {}
      : {
          ...(type !== "all" && { type }),
          ...(taskId !== "all" && { taskId }),
        };

  // The live tail: newest page, refreshed on the socket tick and on a slow
  // interval. Not run while paged back — see the component comment.
  // `lastSeq` is a tick, not an input — same as the costs and health panels.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the socket advances.
  useEffect(() => {
    if (!open || pagedBack) return;
    const controller = new AbortController();
    const load = () => {
      void (async () => {
        const result = await fetchEventsWindow(
          { latest: PAGE, ...filters, signal: controller.signal },
          fetch,
        );
        if (controller.signal.aborted) return;
        if (result.ok) {
          // Server windows arrive ascending (envelope order); the table is
          // stored and rendered newest-first.
          setRows(result.window.events.slice().reverse());
          setHasMore(result.window.hasMore);
          setError(null);
        } else if (result.message !== "aborted") {
          // Keep the loaded rows up: a table that empties on one failed fetch
          // reads as "the log is gone".
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
  }, [open, pagedBack, type, taskId, lastSeq]);

  const loadOlder = () => {
    const oldest = rows?.[rows.length - 1]?.seq;
    if (oldest === undefined) return;
    void (async () => {
      const result = await fetchEventsWindow({ latest: PAGE, before: oldest, ...filters });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setRows((prev) => mergeBySeq(prev ?? [], result.window.events));
      setHasMore(result.window.hasMore);
      setPagedBack(true);
    })();
  };

  const changeFilter = (next: () => void) => {
    next();
    // A filter names a different log; depth accumulated under the old one is
    // gone by definition, and the tail resumes.
    setPagedBack(false);
    setRows(null);
  };

  const taskTitle = (id: string | null): string => {
    if (id === null) return "—";
    return tasks.find((t) => t.task.id === id)?.task.title ?? shortTaskId(id);
  };

  return (
    <section className="events" aria-label="event log">
      <header className="events-head">
        <h2>log</h2>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "hide" : "events"}
        </button>
        {open && rows !== null && <span className="dim">{rows.length} events</span>}
        {open && pagedBack && (
          <button
            type="button"
            className="link"
            onClick={() => {
              setPagedBack(false);
              setRows(null);
            }}
          >
            live tail paused — jump to latest
          </button>
        )}
        {error !== null && <span className="error">{error}</span>}
      </header>

      {open && (
        <>
          <div className="events-filters">
            <label>
              filter by type{" "}
              <select
                value={type}
                onChange={(e) => changeFilter(() => setType(e.target.value as "all" | EventType))}
              >
                <option value="all">all types</option>
                {EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label>
              filter by task{" "}
              <select
                value={taskId}
                onChange={(e) => changeFilter(() => setTaskId(e.target.value))}
              >
                <option value="all">all tasks</option>
                {tasks.map((t) => (
                  <option key={t.task.id} value={t.task.id}>
                    {t.task.title}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {rows === null || rows.length === 0 ? (
            <p className="empty">
              {rows === null
                ? "loading…"
                : type === "all" && taskId === "all"
                  ? "No events yet."
                  : "No events match this filter."}
            </p>
          ) : (
            <table className="events-table">
              <thead>
                <tr>
                  <th scope="col">time</th>
                  <th scope="col">type</th>
                  <th scope="col">task</th>
                  <th scope="col">what</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const detail = describeEvent(e.payload);
                  return (
                    <tr key={e.seq} title={`seq ${e.seq} · ${detail}`}>
                      <td>{clockTime(e.ts)}</td>
                      <td>{e.payload.type}</td>
                      <td title={e.taskId ?? undefined}>{taskTitle(e.taskId)}</td>
                      <td>{oneLine(detail)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {rows !== null && hasMore && (
            <button type="button" className="events-older" onClick={loadOlder}>
              load older
            </button>
          )}
        </>
      )}
    </section>
  );
}
