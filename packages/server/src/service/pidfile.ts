/**
 * The pidfile: how a second `rewter` invocation finds the first one.
 *
 * `rewter start` runs in the foreground, so `rewter stop` in another terminal
 * has nothing to go on but what the running process left on disk. That file is
 * the whole mechanism, and the thing worth being careful about is that **a
 * pidfile is a claim, not a fact**. Three ways it lies:
 *
 * - the daemon was killed and never got to remove it (the ordinary case);
 * - the machine rebooted and the file survived;
 * - worst, the pid was *reused* by an unrelated process, and a naive `stop`
 *   would send SIGTERM to whatever now happens to own that number.
 *
 * So nothing here trusts the pid. The file records the URL the daemon bound,
 * and liveness is established by **asking that URL** — a `GET /internal/health`
 * that answers with rewter's shape is proof that rewter is the thing listening,
 * which is the question actually being asked. The pid is only used *after* that
 * check passes, to deliver the signal. A pidfile whose URL does not answer is
 * stale by definition, and stale means "delete the file", never "signal the
 * pid".
 *
 * Writes go through a temp file and a rename, so a `status` running during a
 * `start` reads either the old file or the new one and never half of either.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/** Where `start` leaves it; alongside the database, under `~/.rewter`. */
export const DEFAULT_PIDFILE = "~/.rewter/rewter.pid";

export const PidfileSchema = z.object({
  pid: z.number().int().positive(),
  /** The address actually bound — port 0 resolves to a real number before this is written. */
  url: z.string().min(1),
  /** Unix ms. Only ever displayed; liveness is decided by the health probe. */
  startedAt: z.number().int().nonnegative(),
  version: z.string().min(1),
});
export type Pidfile = z.infer<typeof PidfileSchema>;

/**
 * Write the file, atomically.
 *
 * Write-then-rename, with the pid in the temp name so two `start`s racing
 * cannot scribble over each other's draft. `rename` is the commit: a reader
 * during a write sees the whole old file or the whole new one, never a
 * half-written pid it might go on to signal.
 */
export function writePidfile(path: string, entry: Pidfile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${entry.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Read it, or undefined.
 *
 * A file that is missing, unreadable, truncated, or written by some older
 * version with a different shape all mean the same thing to every caller —
 * "there is no usable claim here" — so they collapse to one answer rather than
 * four error paths. The file is ours to rewrite; there is nothing to preserve.
 */
export function readPidfile(path: string): Pidfile | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return PidfileSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Remove it, silently. Absent is the desired state, so absent is not an error. */
export function removePidfile(path: string): void {
  rmSync(path, { force: true });
}

/** Resolve `~` the way the config paths do, so both land in the same directory. */
export function pidfilePath(home: string, override?: string | undefined): string {
  const raw = override ?? DEFAULT_PIDFILE;
  return raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
}
