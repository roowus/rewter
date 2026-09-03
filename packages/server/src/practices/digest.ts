/**
 * Render the practices a task carries into its prompt.
 *
 * Unlike the skills digest this is not an index the model chooses from — it
 * is the rules themselves, every one of them, on every task. That is why the
 * budget is a quarter of the skills digest's: a practice costs tokens on every
 * prompt for the rest of time, and the tight budget is the signal that keeps
 * the library small. Over budget, the lowest-priority facts are dropped and
 * the omission is stated, so the model never silently loses a rule it thinks
 * it has.
 *
 * Order is `visiblePractices`' stable slug order, not a priority ranking — the
 * same library must render to the same bytes every time, and an owner who
 * wants a fact to survive the cut controls that by keeping the library short,
 * not by naming it "aaa-…".
 */
import type { Practice } from "@rewter/shared";
import { estimateTokens } from "../registry/tokens.js";

export interface PracticesDigestOptions {
  /** Token budget for the rendered block. Default: DEFAULT_PRACTICES_MAX_TOKENS. */
  maxTokens?: number | undefined;
}

/**
 * ~400 tokens ≈ 8–12 one-line facts. Deliberately a fraction of the skills
 * digest's 1000: skills are an index the model reads once, practices are
 * rules it must hold for the whole task.
 */
export const DEFAULT_PRACTICES_MAX_TOKENS = 400;

export function renderPracticesDigest(
  practices: Practice[],
  opts: PracticesDigestOptions = {},
): string {
  const budget = opts.maxTokens ?? DEFAULT_PRACTICES_MAX_TOKENS;
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;

  for (const p of practices) {
    const line = renderLine(p);
    const cost = estimateTokens(line) + 1;
    if (used + cost > budget) {
      dropped += 1;
      continue;
    }
    lines.push(line);
    used += cost;
  }

  if (dropped > 0) {
    lines.push(`(${dropped} further practice(s) omitted for space — the library is over budget.)`);
  }
  return lines.join("\n");
}

function renderLine(p: Practice): string {
  return `- ${p.fact}${p.scope === "project" ? " (project)" : ""}`;
}
