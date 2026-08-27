/**
 * Progress-as-text.
 *
 * An orchestration takes tens of seconds and spends the user's money, and the
 * only channel back to an OpenAI-compatible client is the assistant message
 * itself. So progress goes down the same SSE stream as ordinary text, before the
 * final answer — the client needs no rewter awareness to show it, and a plain
 * `curl` sees it too.
 *
 * The formatting is deliberately narrow: one line per event, a leading glyph
 * that survives a terminal with no colour, and no ANSI codes (a client may be
 * rendering into a web page, a log file, or a TUI). Numbers are rounded at the
 * boundary — the user is watching, not auditing; the audit trail is the event
 * log and `cost_records`.
 */

/** Leading glyphs, kept here so the vocabulary is visible in one place. */
export const GLYPH = {
  plan: "◆",
  start: "▶",
  done: "✔",
  failed: "✖",
  cancelled: "⊘",
  paused: "⏸",
  handoff: "⇄",
  note: "·",
} as const;

export function planLine(note: string, dashboardUrl?: string | undefined): string {
  const tail = dashboardUrl === undefined ? "" : `   (dashboard: ${dashboardUrl})`;
  return `${GLYPH.plan} plan: ${note}${tail}`;
}

export function workerStartLine(opts: {
  label: string;
  modelId: string;
  tier: number;
  title: string;
}): string {
  return `${GLYPH.start} [${opts.label} · ${opts.modelId} · tier${opts.tier}] ${opts.title} — started`;
}

export function workerDoneLine(opts: {
  label: string;
  costUsd: number | null;
  durationMs: number;
}): string {
  return `${GLYPH.done} [${opts.label}] done (${formatCost(opts.costUsd)}, ${formatDuration(opts.durationMs)})`;
}

export function workerFailedLine(opts: { label: string; error: string }): string {
  return `${GLYPH.failed} [${opts.label}] failed: ${firstLine(opts.error)}`;
}

export function workerCancelledLine(opts: { label: string; reason?: string | undefined }): string {
  const why = opts.reason === undefined || opts.reason === "" ? "" : `: ${firstLine(opts.reason)}`;
  return `${GLYPH.cancelled} [${opts.label}] cancelled${why}`;
}

export function askUserLine(question: string, taskId: string): string {
  return `${GLYPH.paused} ${question}\n   (reply in this conversation, or answer in the dashboard — task ${taskId})`;
}

export function handoffLine(opts: { toModel: string; reason: string }): string {
  return `${GLYPH.handoff} handing off to ${opts.toModel}: ${firstLine(opts.reason)}`;
}

export function noteLine(text: string): string {
  return `${GLYPH.note} ${firstLine(text)}`;
}

/**
 * The separator between the progress feed and the answer.
 *
 * Without it, a final answer that opens with a bullet list is visually
 * indistinguishable from one more progress line.
 */
export const ANSWER_SEPARATOR = "";

export function formatCost(usd: number | null): string {
  if (usd === null) return "cost n/a";
  if (usd === 0) return "$0";
  // Sub-cent costs are the common case for tier-1 workers, and "$0.00" reads as
  // free rather than cheap, so small values keep four decimals.
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}

/**
 * Progress lines are one line each — a provider error containing a stack trace
 * would otherwise blow the feed apart and bury everything above it.
 */
function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  const trimmed = line.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed;
}
