/**
 * What the daemon knows about itself.
 *
 * `GET /internal/health` has existed since M8, but only as a liveness probe:
 * `rewter status` asks it whether something rewter-shaped is on the port, reads
 * two counts off it and stops. Everything else the daemon plainly knows — how
 * long it has been up, which database file it opened and how big that has got,
 * how much of the registry is actually reachable, whether a task is sitting
 * waiting for someone to approve something — was known and displayed nowhere.
 *
 * Two constraints shaped the schema.
 *
 * **`status`, `version`, `models` and `providers` keep their names and their
 * meanings.** `service/control.ts` has read them since M8, and an older CLI
 * probing a newer daemon must not decide it has found a stranger on the port.
 * `models`/`providers` therefore stay the *enabled* counts — what the router can
 * actually reach — and the totals live under `registry` alongside them.
 *
 * **Everything here is a fact the process already has.** No latency percentiles:
 * rewter times nothing per request today, and a percentile computed from worker
 * runs would be orchestration latency wearing a router's label. A number on an
 * ops page is read as measured. Better a missing row than a plausible one.
 */
import { z } from "zod";
import { TimestampSchema } from "./entities.js";

export const DaemonHealthSchema = z.object({
  /** The shape check `rewter status` uses to tell rewter from whatever else is listening. */
  status: z.literal("ok"),
  version: z.string(),

  // ── Kept at these names for the M8 CLI: enabled counts, not totals. ────────
  models: z.number().int().nonnegative(),
  providers: z.number().int().nonnegative(),

  /** ms since this process bound its port — not since the machine booted. */
  uptimeMs: z.number().int().nonnegative(),
  startedAt: TimestampSchema,
  pid: z.number().int().positive(),
  /** The address actually bound, port 0 already resolved. */
  url: z.string().nullable(),

  registry: z.object({
    providersTotal: z.number().int().nonnegative(),
    providersEnabled: z.number().int().nonnegative(),
    modelsTotal: z.number().int().nonnegative(),
    modelsEnabled: z.number().int().nonnegative(),
    /** Models with a capability card — the half of the registry that steers routing. */
    cards: z.number().int().nonnegative(),
  }),

  db: z.object({
    path: z.string(),
    /**
     * Bytes on disk including `-wal` and `-shm`, or `null` for an in-memory
     * database. In WAL mode a busy daemon can carry a lot of recent history in
     * the sidecar file, so reporting the main file alone would understate it —
     * which is exactly backwards for the one question this number answers.
     */
    sizeBytes: z.number().int().nonnegative().nullable(),
  }),

  events: z.object({
    count: z.number().int().nonnegative(),
    /** Highest `seq` written. A dashboard behind this has replaying left to do. */
    lastSeq: z.number().int().nonnegative(),
  }),

  tasks: z.object({
    running: z.number().int().nonnegative(),
    /** Parked on a gate. The one count worth interrupting someone over. */
    pendingApprovals: z.number().int().nonnegative(),
  }),
});
export type DaemonHealth = z.infer<typeof DaemonHealthSchema>;
