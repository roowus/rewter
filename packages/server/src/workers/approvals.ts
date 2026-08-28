/**
 * The approval choke point.
 *
 * Every action a tier-2 worker could regret goes through `Approvals.require`,
 * and there is exactly one of these functions on purpose: a second path to the
 * disk is a second place to forget the gate. Callers do not decide policy, do
 * not read `autoApprove`, and do not know whether a human was involved — they
 * `await` a verdict and either act or return the denial to the model.
 *
 * The order of the checks is the design:
 *
 * 1. **Auto-approve** — the task said "don't ask me". Logged as
 *    `auto_approved`, never silent: the audit trail must show what ran under it.
 * 2. **Inside the workspace** — a write in the task's own scratch directory
 *    damages nothing a user would miss. Gating it would teach people to click
 *    approve without reading, which costs more safety than it buys.
 * 3. **Read-only shell allowlist** — `ls`, `git status`, `pnpm test`. Same
 *    argument: an approval prompt for `git diff` is noise, and noise is what
 *    makes the prompt for `rm -rf` get waved through.
 * 4. **Otherwise, ask.** A `pending` row, an `approval.requested` event, and a
 *    promise that parks until something resolves it — the dashboard, an in-band
 *    "approve w2", or the task being cancelled.
 *
 * A denial is **not an error**. It comes back as `{ok: false, reason}` and the
 * caller hands it to the model as a tool result, because a worker told "denied:
 * don't touch node_modules" can adapt, while a worker that crashes cannot.
 *
 * Cancellation resolves every parked request as denied. A task that is being
 * killed must not leave a worker awaiting a human who has closed the tab.
 */
import {
  type Approval,
  type ApprovalId,
  type ApprovalKind,
  type TaskId,
  type WorkItemId,
  type WorkerRunId,
  newApprovalId,
} from "@rewter/shared";
import type { Repos } from "../db/repos.js";

export interface ApprovalRequest {
  kind: ApprovalKind;
  /** What the user will read. The exact command or path, not a category. */
  summary: string;
  detail?: Record<string, unknown> | undefined;
  workItemId?: WorkItemId | null;
  workerRunId?: WorkerRunId | null;
  /**
   * True when the action stays inside the task's auto-approve zone. The caller
   * knows this (it has the `Workspace`); policy lives here.
   */
  inWorkspace?: boolean;
  /** True for a shell command matched against the read-only allowlist. */
  readOnly?: boolean;
}

export type Verdict =
  | { ok: true; approvalId: ApprovalId | null; auto: boolean }
  | { ok: false; reason: string; approvalId: ApprovalId | null };

export interface ApprovalsOptions {
  repos: Repos;
  taskId: TaskId;
  /** Read fresh on every call: the user may flip auto-approve mid-task. */
  autoApprove: () => boolean;
  clock?: () => number;
  /** Announce the request to the user's live feed, if a stream is attached. */
  announce?: (approval: Approval) => void;
}

export class Approvals {
  private readonly clock: () => number;
  /** Parked requests, so cancellation and in-band replies can find them. */
  private readonly waiting = new Map<ApprovalId, (v: Verdict) => void>();
  private cancelled = false;

  constructor(private readonly opts: ApprovalsOptions) {
    this.clock = opts.clock ?? Date.now;
  }

  /**
   * Ask permission. Resolves immediately for anything policy allows, otherwise
   * parks until resolved or cancelled.
   */
  async require(req: ApprovalRequest): Promise<Verdict> {
    // Checked before policy: a task already being torn down should not open a
    // prompt nobody will answer, however harmless the action.
    if (this.cancelled) {
      return { ok: false, reason: "the task was cancelled", approvalId: null };
    }

    const auto = this.autoReason(req);
    if (auto !== null) {
      // Recorded even when nobody is asked. "Nothing was gated" and "everything
      // was auto-approved" must not look the same in the audit trail.
      const row = this.create(req, "auto_approved", auto);
      return { ok: true, approvalId: row.id, auto: true };
    }

    // No `bus.append` here: `repos.createApproval` emits `approval.requested`
    // itself, and a second one would put two cards in the dashboard for one
    // request. The repo owns the event because the repo owns the write.
    const approval = this.create(req, "pending", null);
    this.opts.announce?.(approval);

    return await new Promise<Verdict>((resolve) => {
      this.waiting.set(approval.id, resolve);
    });
  }

  /**
   * Resolve a pending request. Returns false when the id is unknown or already
   * settled — a double-click in the dashboard and a race with an in-band
   * "approve all" are both ordinary, not errors.
   */
  resolve(
    id: ApprovalId,
    approved: boolean,
    by: "dashboard" | "in_band" | "policy" | "timeout",
    note?: string,
  ): boolean {
    const pending = this.waiting.get(id);
    const current = this.opts.repos.getApproval(id);
    if (current === undefined || current.status !== "pending") return false;

    const status = approved ? "approved" : "denied";
    // Emits `approval.resolved` as part of the write, same as the create path.
    this.opts.repos.resolveApproval(id, status, by, note ?? null);

    // The row is updated even with nobody parked: the daemon may have restarted,
    // or this may be a duplicate arriving after the worker moved on. The audit
    // trail is the durable part; the promise is just how this process learns.
    this.waiting.delete(id);
    pending?.(
      approved
        ? { ok: true, approvalId: id, auto: false }
        : { ok: false, reason: denialReason(note), approvalId: id },
    );
    return true;
  }

  /** Resolve every pending request for this task at once — the "approve all" reply. */
  resolveAll(approved: boolean, by: "dashboard" | "in_band", note?: string): number {
    let n = 0;
    for (const id of [...this.waiting.keys()]) {
      if (this.resolve(id, approved, by, note)) n += 1;
    }
    return n;
  }

  /**
   * Deny everything parked and refuse anything later. Called when the task is
   * cancelled: a worker must not sit awaiting a human who has gone.
   */
  cancel(): void {
    this.cancelled = true;
    for (const id of [...this.waiting.keys()]) {
      this.resolve(id, false, "policy", "the task was cancelled");
    }
  }

  /** Pending requests for this task, for the dashboard and the `/internal` route. */
  pending(): Approval[] {
    return this.opts.repos.listPendingApprovals(this.opts.taskId);
  }

  /**
   * Why this action needs no human, or null if it does.
   *
   * The string is stored as the resolution note, so the audit trail says *which*
   * rule let something through rather than just "auto_approved".
   */
  private autoReason(req: ApprovalRequest): string | null {
    if (this.opts.autoApprove()) return "auto-approve is on for this task";
    if (req.inWorkspace === true) return "inside the task workspace";
    if (req.readOnly === true) return "read-only command";
    return null;
  }

  private create(req: ApprovalRequest, status: Approval["status"], note: string | null): Approval {
    const now = this.clock();
    const resolved = status !== "pending";
    return this.opts.repos.createApproval({
      id: newApprovalId(),
      taskId: this.opts.taskId,
      workItemId: req.workItemId ?? null,
      workerRunId: req.workerRunId ?? null,
      status,
      kind: req.kind,
      summary: req.summary,
      detail: req.detail ?? null,
      resolvedBy: resolved ? "policy" : null,
      resolutionNote: note,
      createdAt: now,
      resolvedAt: resolved ? now : null,
    });
  }
}

/**
 * Read-only shell commands, matched on the *first two* words.
 *
 * Deliberately a small allowlist rather than a denylist of dangerous things:
 * you cannot enumerate every way to write to a disk, but you can enumerate the
 * handful of commands whose whole job is to look. Anything unlisted gets asked
 * about, which is the safe direction to be wrong in.
 */
const READ_ONLY_COMMANDS: readonly string[] = [
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "stat",
  "which",
  "type",
  "date",
  "env",
  "df",
  "du",
  "tree",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git remote",
  "pnpm test",
  "pnpm lint",
  "pnpm typecheck",
  "npm test",
  "node --version",
  "python --version",
];

/**
 * Does this command only read?
 *
 * Any shell metacharacter forfeits the allowlist outright. `ls; rm -rf ~` starts
 * with `ls`, and no amount of first-word matching makes that safe — the check is
 * "this is one simple command from the list", not "it begins with one".
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return false;
  // Substitution, chaining, redirection, backgrounding, globbing into a write —
  // each of these can smuggle a second command past a first-word check.
  if (/[;&|><`$(){}\n\r\\]/.test(trimmed)) return false;

  const words = trimmed.split(/\s+/);
  const one = words[0] ?? "";
  const two = words.length > 1 ? `${one} ${words[1]}` : "";
  // `-o`/`--output` write files even from read-only-looking commands.
  if (words.some((w) => w === "-o" || w === "--output" || w.startsWith("--output="))) return false;
  return READ_ONLY_COMMANDS.includes(two) || READ_ONLY_COMMANDS.includes(one);
}

/**
 * A denial the model can act on.
 *
 * The user's note is the important half — "denied" alone invites the worker to
 * retry the identical command, while "denied: use the test fixture instead"
 * redirects it.
 */
function denialReason(note?: string): string {
  const trimmed = (note ?? "").trim();
  return trimmed === "" ? "denied by the user" : `denied by the user: ${trimmed}`;
}
