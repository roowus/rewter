/**
 * Skills — learning v1 (phase-2 M4, docs/design/phase2-direction.md §2).
 *
 * A skill is an agentskills.io `SKILL.md`: markdown with YAML frontmatter
 * (`name`, `description`) and a body holding the procedure. Choosing the
 * standard verbatim means skills the owner already has (Claude Code's
 * `~/.claude/skills/<name>/SKILL.md`) import by copying a directory, and skills
 * rewter distills are usable by other tools. rewter's own frontmatter additions
 * (`learned_from`, `uses`, `project`) are optional keys other tools ignore.
 *
 * Storage is files, not DB rows — a skill you can't open in an editor is a
 * skill you can't fix. The DB carries only an *index* (one row per SKILL.md,
 * keyed by path) so retrieval and the dashboard don't re-parse the tree per
 * request; the file is the source of truth and the index is rebuilt from it.
 * These schemas are the cross-boundary shape of that index and of the parsed
 * frontmatter; the parser itself lives in the server, next to the files.
 */
import { z } from "zod";
import { TimestampSchema } from "./entities.js";
import { ProjectSlugSchema, SkillSlugSchema, TaskIdSchema } from "./ids.js";

/**
 * On-disk layout under the skills root (`~/.rewter/skills`):
 *
 *   global/<skill-slug>/SKILL.md          approved, visible to every task
 *   <project-slug>/<skill-slug>/SKILL.md  approved, visible inside that project
 *   pending/<skill-slug>/SKILL.md         staged drafts — NEVER retrieved
 *
 * `global` and `pending` are therefore reserved words a project slug may not
 * take: a project named "pending" would make its skills directory
 * indistinguishable from the staging area. Enforced at project creation
 * (ProjectCreateSchema) rather than in ProjectSlugSchema itself, so that a
 * hypothetical pre-existing row still parses — refusing to *read* data is
 * never the right failure mode for a rule about *creating* it.
 */
export const RESERVED_PROJECT_SLUGS = ["global", "pending"] as const;

export const SkillStatusSchema = z.enum(["pending", "approved"]);
export type SkillStatus = z.infer<typeof SkillStatusSchema>;

export const SkillScopeSchema = z.enum(["global", "project"]);
export type SkillScope = z.infer<typeof SkillScopeSchema>;

/**
 * The parsed YAML frontmatter of a SKILL.md. `.passthrough()` is deliberate:
 * imported skills carry keys we don't know (`license`, `allowed-tools`,
 * `metadata`, …) and a strict parse would refuse exactly the files the format
 * was chosen to accept. Known keys are still validated hard — this is
 * LLM-written JSON in the distill path, and zod-parsed defensively like all of
 * it (CLAUDE.md rule).
 *
 * `name` must equal the directory the file lives in; that check needs the path
 * and therefore lives in the indexer, not here.
 */
export const SkillFrontmatterSchema = z
  .object({
    name: SkillSlugSchema,
    /**
     * The one line the digest shows — it is what the initiator decides from,
     * so it must exist and fit. 1024 is the agentskills.io ceiling.
     */
    description: z.string().min(1).max(1024),
    /** rewter provenance: the task whose event log this skill was distilled from. */
    learned_from: TaskIdSchema.optional(),
    /** rewter usage counter, maintained by the retrieval side. */
    uses: z.number().int().nonnegative().optional(),
    /** Target project for a pending draft; absent = global. */
    project: ProjectSlugSchema.optional(),
  })
  .passthrough();
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/**
 * One index row = one SKILL.md on disk. Keyed by `path` because that is the
 * only true uniqueness: the same slug may legitimately exist in `global/` and
 * in a project (project wins at retrieval), and as an approved skill plus a
 * pending draft of its replacement.
 *
 * For approved skills the scope is read off the *directory* the file sits in —
 * placement is the owner's approval act and outranks any frontmatter claim.
 * For pending drafts the directory is always `pending/`, so scope/projectSlug
 * carry the frontmatter's *target* instead: where the file will move on
 * approval.
 */
export const SkillSchema = z.object({
  slug: SkillSlugSchema,
  status: SkillStatusSchema,
  scope: SkillScopeSchema,
  /** Set exactly when scope = "project". */
  projectSlug: ProjectSlugSchema.nullable(),
  /** Absolute path of the SKILL.md — the index key and the `load_skill` target. */
  path: z.string().min(1),
  description: z.string().min(1).max(1024),
  learnedFrom: TaskIdSchema.nullable(),
  uses: z.number().int().nonnegative(),
  updatedAt: TimestampSchema,
});
export type Skill = z.infer<typeof SkillSchema>;

/**
 * Retrieval visibility: which approved skills a task sees. Global ∪ project,
 * and on a slug collision the project's copy shadows the global one — the same
 * precedence CLAUDE.md scoping taught everyone to expect. Pending never
 * appears regardless of arguments; that invariant lives here, in the one
 * function every retrieval path shares, not in each caller's memory.
 *
 * Pure and in `shared` so the dashboard can show exactly what a task will see.
 */
export function visibleSkills(all: Skill[], projectSlug: string | null): Skill[] {
  const approved = all.filter((s) => s.status === "approved");
  const global = approved.filter((s) => s.scope === "global");
  if (projectSlug === null) return sortBySlug(global);

  const project = approved.filter((s) => s.scope === "project" && s.projectSlug === projectSlug);
  const shadowed = new Set(project.map((s) => s.slug));
  return sortBySlug([...project, ...global.filter((s) => !shadowed.has(s.slug))]);
}

/** Stable order for digests and lists: slug, then (for pending twins) path. */
function sortBySlug(skills: Skill[]): Skill[] {
  return [...skills].sort((a, b) =>
    a.slug === b.slug ? (a.path < b.path ? -1 : 1) : a.slug < b.slug ? -1 : 1,
  );
}
