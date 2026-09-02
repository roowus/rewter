/**
 * The task tree as text — the terminal's view of `FoldedTask`.
 *
 * This is the same fold the dashboard renders (`apps/dashboard/src/TaskTree.tsx`),
 * in the same vocabulary: label, title, status, model, tier, attempts, cost,
 * elapsed. Rendering it here, rather than trusting the narrated feed alone, is
 * what makes the terminal a *live* view: the feed says what happened, the tree
 * says what is true right now — which worker is still running after four have
 * finished, how much the task has spent so far, whether an approval is waiting.
 *
 * Pure functions over the fold, no I/O: the tests feed events and read strings,
 * and `chat.ts` decides where the strings go. Nothing here is ever appended to
 * the assistant message — the answer is the last text delta of the stream, and
 * these lines are rendered *around* it (see `chatCommand`); a footer joined
 * into the answer would silently corrupt every follow-up turn's history.
 */
import type { FoldedTask, FoldedWorkItem } from "@rewter/shared";
import { pendingApprovals } from "@rewter/shared";

/** One glyph per worker status, so a column of workers scans without reading. */
const STATUS_GLYPH: Record<FoldedWorkItem["workItem"]["status"], string> = {
  pending: "·",
  running: "▶",
  waiting_approval: "⏸",
  succeeded: "✔",
  failed: "✖",
  cancelled: "⊘",
  interrupted: "⚡",
  handed_off: "⇄",
};

/**
 * The tree for one task: a header line, one line per work item, and a line
 * per pending approval. Empty array while the task has nothing to show yet —
 * the caller renders nothing rather than an empty box.
 */
export function renderTree(task: FoldedTask, now: number): string[] {
  const lines: string[] = [];
  const t = task.task;
  const total = task.workItems.length;
  const done = task.workItems.filter((w) => isSettled(w.workItem.status)).length;
  const running = task.workItems.filter((w) => w.workItem.status === "running").length;
  const parts = [`${t.status}`];
  if (total > 0)
    parts.push(`${done}/${total} workers done${running > 0 ? `, ${running} running` : ""}`);
  parts.push(costSummary(task), elapsedOf(t, now));
  lines.push(`┌ ${parts.join(" · ")}`);

  for (const item of task.workItems) {
    const wi = item.workItem;
    const glyph = STATUS_GLYPH[wi.status];
    const fields = [
      `${item.label}`,
      shortModelId(wi.modelId),
      `T${wi.tier}`,
      wi.status.replace("_", " "),
    ];
    if (item.runs.length > 1) fields.push(`${item.runs.length} attempts`);
    fields.push(usd(item.costUsd), elapsedOf(wi, now));
    lines.push(`│ ${glyph} ${wi.title} — ${fields.join(" · ")}`);
  }

  for (const approval of pendingApprovals(task)) {
    const owner = task.workItems.find((w) => w.workItem.id === approval.workItemId);
    const who = owner === undefined ? "" : ` [${owner.label}]`;
    lines.push(`│ ⏸${who} awaiting approval: ${approval.summary}`);
  }
  lines.push("└");
  return lines;
}

/**
 * The line after the answer: what the turn cost and how long it took. Separate
 * from `renderTree` because it is printed once, as a feed line, when the stream
 * ends — never redrawn, never part of the answer.
 */
export function costFooter(task: FoldedTask, now: number): string {
  return `· ${costSummary(task)} · ${task.workItems.length} worker(s) · ${elapsedOf(task.task, now)}`;
}

function costSummary(task: FoldedTask): string {
  const planning = task.initiatorCostUsd > 0 ? ` (planning ${usd(task.initiatorCostUsd)})` : "";
  return `${usd(task.costUsd)} spent${planning}`;
}

function isSettled(status: FoldedWorkItem["workItem"]["status"]): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted" ||
    status === "handed_off"
  );
}

/** `$0.0042`, `$1.37`, `$0` — the dashboard's rule; a `$0.00` per worker looks free. */
export function usd(amount: number): string {
  if (amount === 0) return "$0";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

/** `840ms`, `12s`, `4m 06s`. */
export function duration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 1000) return `${Math.round(clamped)}ms`;
  const seconds = clamped / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

function elapsedOf(entity: { createdAt: number; finishedAt: number | null }, now: number): string {
  return duration((entity.finishedAt ?? now) - entity.createdAt);
}

/** `anthropic/claude-sonnet-5` → `claude-sonnet-5`; the provider half repeats down a column. */
export function shortModelId(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash === -1 ? modelId : modelId.slice(slash + 1);
}
