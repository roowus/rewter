/**
 * `load_skill`'s implementation, shared by the initiator and tier-2 workers.
 *
 * One function on purpose: retrieval is where the pending-never-retrieved
 * invariant is enforced (via `visibleSkills` — the only allowed path from an
 * index dump to a skill a model may see), and two copies of that filter is one
 * copy waiting to be forgotten. The return value is always a tool *result*
 * string, never a throw — an unknown slug, a shadowed draft, or a file that
 * moved under the index are all things the calling model should be told about
 * in a turn it can respond to, not exceptions that kill a run.
 */
import type { Skill } from "@rewter/shared";
import { visibleSkills } from "@rewter/shared";
import { readSkillBody } from "./store.js";

/**
 * Resolve a slug against the skills visible to a task and return the tool
 * result: the skill's full body on success, a correctable refusal otherwise.
 *
 * The refusal names the available slugs because a bare "not found" costs the
 * model a guess-and-retry loop over slugs it cannot see — the same rule
 * `parseToolArgs` applies to unknown tool names.
 */
export function loadSkillResult(all: Skill[], projectSlug: string | null, slug: string): string {
  const visible = visibleSkills(all, projectSlug);
  const skill = visible.find((s) => s.slug === slug);
  if (skill === undefined) {
    if (visible.length === 0) {
      return `no skill "${slug}" — no skills are available to this task.`;
    }
    const slugs = visible.map((s) => s.slug).join(", ");
    return `no skill "${slug}". Available: ${slugs}.`;
  }

  // The index is a cache of the tree; the file can move or vanish between the
  // reindex and this read. That is an operational fact for the model to route
  // around, not a crash.
  let body: string;
  try {
    body = readSkillBody(skill.path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `skill "${slug}" could not be read (${message}). Proceed without it.`;
  }

  return [`Skill: ${slug}`, skill.description, "", body].join("\n");
}
