/**
 * The skills digest: the block of text that tells the initiator AI which
 * learned procedures exist for this task, so it can `load_skill` the ones that
 * fit instead of rediscovering them. The sibling of the registry digest, and
 * governed by the same two properties (see registry/digest.ts):
 *
 * **Stability.** Visibility is project-dependent, so this block lives in the
 * per-task region of the prompt rather than behind the global `cache_control`
 * breakpoint — but per-*project* caching still works exactly when the bytes
 * are deterministic. Callers pass the output of `visibleSkills`, which is
 * already stable-sorted; nothing here reintroduces wall-clock or iteration
 * order.
 *
 * **Density.** One line per skill: the slug (the `load_skill` argument) and
 * the frontmatter description (the one line the author wrote for exactly this
 * decision). The body is never inlined — that is what `load_skill` is for.
 */
import type { Skill } from "@rewter/shared";
import { estimateTokens } from "../registry/tokens.js";

export interface SkillsDigestOptions {
  /**
   * Approximate token ceiling. Skills are dropped from the *end* of the
   * (already sorted) list once exceeded, and the omission is stated rather
   * than left silent — an initiator that cannot see a skill will not load it,
   * and it should know that is why.
   */
  maxTokens?: number;
}

/**
 * Small next to the registry's 4000: a skill line is a slug and one sentence,
 * and a library big enough to blow this budget is a library that needs
 * curating, not more context.
 */
const DEFAULT_MAX_TOKENS = 1000;

/**
 * Render one line per skill. The caller is responsible for visibility — pass
 * `visibleSkills(...)` output, never a raw index dump, so the pending-never-
 * retrieved invariant stays in the one shared function.
 *
 * Format: `<slug> — <description>` with ` (project)` appended on
 * project-scoped lines, because a project skill shadowing a global one is a
 * fact the initiator may care about when results look project-specific.
 */
export function renderSkillsDigest(skills: Skill[], opts: SkillsDigestOptions = {}): string {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  const lines: string[] = [];
  let budget = maxTokens;
  let dropped = 0;

  for (const skill of skills) {
    const line = renderLine(skill);
    // +1 for the newline joining lines; tokenizers charge for it.
    const cost = estimateTokens(line) + 1;
    if (cost > budget) {
      dropped++;
      continue;
    }
    budget -= cost;
    lines.push(line);
  }

  if (dropped > 0) {
    lines.push(`(${dropped} further skill(s) omitted for space.)`);
  }
  return lines.join("\n");
}

function renderLine(skill: Skill): string {
  const marker = skill.scope === "project" ? " (project)" : "";
  return `${skill.slug}${marker} — ${skill.description}`;
}
