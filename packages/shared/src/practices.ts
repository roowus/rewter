/**
 * Practices — learning v2 (phase 2, docs/design/practices-memory.md).
 *
 * A practice is one small durable fact the owner wants every task to honour:
 * a correction ("never run `git push --force` here"), a convention ("tests
 * live next to the source"), a tool preference ("use pnpm, not npm"). Where a
 * skill is a *procedure* loaded on demand, a practice is a *standing rule*
 * that is always in context — the learned `CLAUDE.md`.
 *
 * Same storage discipline as skills: files are the truth, the DB is a
 * rebuildable index. One `PRACTICE.md` per practice, YAML frontmatter for
 * identity and provenance, the body is the fact itself. The body is capped
 * hard because every approved practice is paid for on every task's prompt;
 * a fact that needs 2000 characters is a skill, not a practice.
 */
import { z } from "zod";
import { TimestampSchema } from "./entities.js";
import { PracticeSlugSchema, ProjectSlugSchema, TaskIdSchema } from "./ids.js";

/**
 * Hard ceiling on a practice body. ~100 tokens. The always-in-context digest
 * budget is ~400 tokens by default, so this is "a handful of facts", by
 * design — the pressure to keep each one short is the feature.
 */
export const PRACTICE_MAX_CHARS = 400;

/**
 * On-disk layout under the practices root (`~/.rewter/practices`) mirrors the
 * skills tree, and shares its reserved scope names:
 *
 *   global/<slug>/PRACTICE.md          approved, in every task's prompt
 *   <project-slug>/<slug>/PRACTICE.md  approved, in that project's prompts
 *   pending/<slug>/PRACTICE.md         staged drafts — NEVER in a prompt
 */
export const PracticeStatusSchema = z.enum(["pending", "approved"]);
export type PracticeStatus = z.infer<typeof PracticeStatusSchema>;

export const PracticeScopeSchema = z.enum(["global", "project"]);
export type PracticeScope = z.infer<typeof PracticeScopeSchema>;

/**
 * Parsed frontmatter of a PRACTICE.md. Strict rather than passthrough — there
 * is no external format to stay compatible with, and this is LLM-written in
 * the distill path. `name` must equal the directory the file lives in; that
 * check needs the path and lives in the indexer.
 */
export const PracticeFrontmatterSchema = z
  .object({
    name: PracticeSlugSchema,
    /** Provenance: the task whose corrections this practice was drafted from. */
    learned_from: TaskIdSchema.optional(),
    /** Target project for a pending draft; absent = global. */
    project: ProjectSlugSchema.optional(),
  })
  .strict();
export type PracticeFrontmatter = z.infer<typeof PracticeFrontmatterSchema>;

/**
 * One index row = one PRACTICE.md on disk. Keyed by path, as skills are, for
 * the same reason: the same slug can be approved globally and in a project,
 * and pending as a replacement of either.
 *
 * `fact` is the body, whitespace-collapsed — the exact text the prompt will
 * carry, so the dashboard and CLI show precisely what the model sees.
 */
export const PracticeSchema = z.object({
  slug: PracticeSlugSchema,
  status: PracticeStatusSchema,
  scope: PracticeScopeSchema,
  /** Set exactly when scope = "project". */
  projectSlug: ProjectSlugSchema.nullable(),
  /** Absolute path of the PRACTICE.md — the index key. */
  path: z.string().min(1),
  fact: z.string().min(1).max(PRACTICE_MAX_CHARS),
  learnedFrom: TaskIdSchema.nullable(),
  updatedAt: TimestampSchema,
});
export type Practice = z.infer<typeof PracticeSchema>;

/** Body of `POST /internal/practices/:slug/approve`. Same contract as skills. */
export const PracticeApproveRequestSchema = z
  .object({
    overwrite: z.boolean().optional(),
  })
  .strict();
export type PracticeApproveRequest = z.infer<typeof PracticeApproveRequestSchema>;

/**
 * Which approved practices a task carries: global ∪ project, project shadows
 * global on a slug collision, pending never. Identical rule to `visibleSkills`
 * and kept as its own function rather than generic over both, because the
 * two types are branded apart on purpose.
 */
export function visiblePractices(all: Practice[], projectSlug: string | null): Practice[] {
  const approved = all.filter((p) => p.status === "approved");
  const global = approved.filter((p) => p.scope === "global");
  if (projectSlug === null) return sortBySlug(global);

  const project = approved.filter((p) => p.scope === "project" && p.projectSlug === projectSlug);
  const shadowed = new Set(project.map((p) => p.slug));
  return sortBySlug([...project, ...global.filter((p) => !shadowed.has(p.slug))]);
}

function sortBySlug(practices: Practice[]): Practice[] {
  return [...practices].sort((a, b) =>
    a.slug === b.slug ? (a.path < b.path ? -1 : 1) : a.slug < b.slug ? -1 : 1,
  );
}
