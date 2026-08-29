/**
 * `rewter gc` — the database does not shrink on its own.
 *
 * Every orchestration appends: a task row, its work items and worker runs, its
 * approvals, and — by far the bulk — one event per interesting thing that
 * happened, because the event log is the source of truth the dashboard folds to
 * reconstruct a task. That is the right design, and it means a machine running
 * rewter daily accumulates a database that only grows.
 *
 * What makes this more than a `DELETE FROM`:
 *
 * - **Cost records are never collected.** They carry a nullable `taskId` and no
 *   foreign key on purpose, and this is why: "what did I spend in March" must
 *   keep working after March's transcripts are gone. Dropping a task's detail is
 *   a storage decision; dropping its price is destroying an answer.
 * - **Unfinished tasks are never collected**, whatever their age. A task still
 *   `running` is either genuinely in flight or something for the next boot's
 *   reconciliation to close out, and neither wants its history removed from
 *   under it. Age is measured from `finishedAt`, not `createdAt`, so a task that
 *   ran for a week is judged on when it *ended*.
 * - **Deletion order follows the foreign keys.** `foreign_keys` is ON and the
 *   schema declares no cascades, so children go first: approvals, then worker
 *   runs, then work items, then events, then the task. Getting this backwards
 *   corrupts nothing — SQLite refuses — but it does mean a gc that throws
 *   halfway through its sweep.
 *
 * The sweep runs in one transaction. A gc interrupted between the events and
 * the task row would leave a task the dashboard can list but cannot
 * reconstruct, which is worse than not having collected it at all.
 *
 * Workspaces are collected too, and are usually the larger win: a tier-2 task
 * that checked out a repository leaves it in `~/.rewter/workspaces/<taskId>/`.
 * Only that directory is removed, never `settings.workspaceDir` — a task
 * pointed at one of your real project directories gets its row collected and
 * your project left alone.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { and, inArray, isNull, lt, or } from "drizzle-orm";
import type { Db } from "../db/connection.js";
import { events, approvals, tasks, workItems, workerRuns } from "../db/schema.js";

/** Terminal statuses — the only ones a task can be collected in. */
const FINISHED = ["succeeded", "failed", "cancelled", "interrupted"] as const;

/** Everything else: still in flight, or waiting for someone. Never collected. */
const UNFINISHED = ["pending", "running", "waiting_approval"] as const;

export const DEFAULT_RETENTION_DAYS = 30;

export interface GcOptions {
  /** Collect tasks that finished more than this many days ago. */
  olderThanDays?: number;
  /** Report what would go, and delete nothing. */
  dryRun?: boolean;
  /**
   * Base workspaces directory. Given one, `<baseDir>/<taskId>` goes with each
   * collected task; omitted, only database rows are collected.
   */
  workspacesDir?: string | undefined;
  /** Injectable so tests are not at the mercy of the clock. */
  now?: number;
}

export interface GcResult {
  /** The cutoff actually used, as unix ms — reported so the run is checkable. */
  cutoff: number;
  dryRun: boolean;
  /** The tasks collected. */
  taskIds: string[];
  deleted: {
    tasks: number;
    workItems: number;
    workerRuns: number;
    approvals: number;
    events: number;
    /** Workspace directories removed — 0 when no `workspacesDir` was given. */
    workspaces: number;
  };
  /** Tasks past the cutoff but kept because they have not finished. */
  unfinishedSkipped: number;
}

/**
 * Collect finished tasks older than the cutoff, with everything hanging off
 * them.
 *
 * Returns what it did (or would have done) rather than printing: the CLI
 * formats, and a caller embedding rewter may want the numbers.
 */
export function collectGarbage(db: Db, opts: GcOptions = {}): GcResult {
  const now = opts.now ?? Date.now();
  const days = opts.olderThanDays ?? DEFAULT_RETENTION_DAYS;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const dryRun = opts.dryRun === true;

  // `finishedAt` is the age that matters. A terminal task with a null one is
  // possible in rows written before it was set reliably; fall back to
  // `updatedAt` so those stay collectable rather than accumulating forever.
  const doomed = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, [...FINISHED]),
        or(
          lt(tasks.finishedAt, cutoff),
          and(isNull(tasks.finishedAt), lt(tasks.updatedAt, cutoff)),
        ),
      ),
    )
    .all()
    .map((r) => r.id);

  const unfinishedSkipped = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(inArray(tasks.status, [...UNFINISHED]), lt(tasks.updatedAt, cutoff)))
    .all().length;

  const result: GcResult = {
    cutoff,
    dryRun,
    taskIds: doomed,
    deleted: { tasks: 0, workItems: 0, workerRuns: 0, approvals: 0, events: 0, workspaces: 0 },
    unfinishedSkipped,
  };
  if (doomed.length === 0) return result;

  // Counted before deleting, so a dry run reports the same numbers the real run
  // will — the whole point of a dry run is that its output is trustworthy.
  result.deleted = {
    tasks: doomed.length,
    workItems: db
      .select({ id: workItems.id })
      .from(workItems)
      .where(inArray(workItems.taskId, doomed))
      .all().length,
    workerRuns: db
      .select({ id: workerRuns.id })
      .from(workerRuns)
      .where(inArray(workerRuns.taskId, doomed))
      .all().length,
    approvals: db
      .select({ id: approvals.id })
      .from(approvals)
      .where(inArray(approvals.taskId, doomed))
      .all().length,
    events: db.select({ seq: events.seq }).from(events).where(inArray(events.taskId, doomed)).all()
      .length,
    workspaces: opts.workspacesDir === undefined ? 0 : doomed.length,
  };

  if (dryRun) return result;

  // One transaction: a sweep interrupted between the events and the task row
  // leaves a task the dashboard can list but cannot reconstruct.
  db.transaction((tx) => {
    // Children first — `foreign_keys` is ON and the schema declares no cascades.
    tx.delete(approvals).where(inArray(approvals.taskId, doomed)).run();
    tx.delete(workerRuns).where(inArray(workerRuns.taskId, doomed)).run();
    tx.delete(workItems).where(inArray(workItems.taskId, doomed)).run();
    tx.delete(events).where(inArray(events.taskId, doomed)).run();
    tx.delete(tasks).where(inArray(tasks.id, doomed)).run();
    // Cost records are deliberately untouched: they outlive the task so that
    // "what did I spend last month" survives collecting last month's detail.
  });

  // After the transaction commits, not inside it: an `rmSync` that throws must
  // not roll back a database sweep that already succeeded. A workspace left on
  // disk is recovered by the next gc; a task resurrected without its directory
  // is a task the dashboard shows and the filesystem contradicts.
  if (opts.workspacesDir !== undefined) {
    const base = opts.workspacesDir;
    for (const id of doomed) rmSync(join(base, id), { recursive: true, force: true });
  }

  return result;
}

/**
 * `VACUUM` — separate, and not run by default.
 *
 * Deleting rows returns their pages to SQLite's free list, not to the
 * filesystem; the file stays the size it grew to. `VACUUM` rewrites it, which
 * needs room for a second copy and holds a write lock on the whole database for
 * the duration. That is a fine thing to ask for explicitly and a rude thing to
 * do to a running daemon by surprise, hence `--vacuum`.
 */
export function vacuum(db: Db): void {
  db.$client.exec("VACUUM");
}

/** A short report — what went, what was kept, and the cutoff it used. */
export function formatGcResult(result: GcResult): string {
  const when = new Date(result.cutoff).toISOString().slice(0, 10);
  const kept =
    result.unfinishedSkipped === 0
      ? []
      : [`  ${result.unfinishedSkipped} unfinished task(s) kept regardless of age`];

  if (result.taskIds.length === 0) {
    return [`nothing to collect — no finished tasks older than ${when}`, ...kept].join("\n");
  }

  const d = result.deleted;
  const lines = [
    `${result.dryRun ? "would remove" : "removed"} ${d.tasks} task(s) finished before ${when}:`,
    `  ${d.events} event(s), ${d.workItems} work item(s), ${d.workerRuns} worker run(s), ${d.approvals} approval(s)`,
  ];
  if (d.workspaces > 0) lines.push(`  ${d.workspaces} workspace director(ies)`);
  lines.push("  cost records kept — spend history outlives task detail");
  lines.push(...kept);
  if (result.dryRun) lines.push("  (dry run — nothing was deleted)");
  return lines.join("\n");
}
