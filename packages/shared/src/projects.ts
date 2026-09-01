/**
 * Project semantics that must not fork between server and dashboard: how a
 * project's policy folds into a task's settings, which resource is the
 * workspace, and the shapes of the `/internal/projects` CRUD bodies. All pure —
 * the server applies them at task creation / route handling, the dashboard uses
 * them to preview what a run inside a project will do.
 */
import { z } from "zod";
import {
  type Project,
  ProjectModelPrefsSchema,
  ProjectPolicySchema,
  type ProjectResource,
  ProjectResourceSchema,
  ProjectSchema,
  type TaskSettings,
} from "./entities.js";
import { ProjectSlugSchema } from "./ids.js";
import { RESERVED_PROJECT_SLUGS } from "./skills.js";

/**
 * Fold a project's policy into a task's requested settings. The rule is
 * tighten-only, in both directions of "tight":
 *
 * - autoApprove: ON only if BOTH the project and the task say so. A gated
 *   project cannot be loosened per-task, and a cautious task stays gated even
 *   inside a trusted project.
 * - maxSpendUsd: the LOWER of the two caps; null (uncapped) always loses to a
 *   number. A task can spend less than the project allows, never more.
 *
 * Everything else (workspaceDir, concurrency) passes through — those are
 * mechanics, not permissions. Callers pass the task's settings as requested by
 * the client; the return value is what gets persisted, so the precedence is
 * applied once, at creation, and every later reader (engine, budget guard,
 * approvals) sees only the folded result.
 */
export function effectiveTaskSettings(project: Project, requested: TaskSettings): TaskSettings {
  return {
    ...requested,
    autoApprove: requested.autoApprove && project.policy.autoApprove,
    maxSpendUsd: minCap(project.policy.maxSpendUsd, requested.maxSpendUsd),
  };
}

/** Lower of two caps, where null means "no cap" and loses to any number. */
export function minCap(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * The project's primary workspace: the FIRST `dir` resource, or a `repo` if no
 * plain dir exists (a repo resource is a directory that happens to be a
 * checkout). Order in `resources` is meaningful for exactly this reason.
 * Returns null when the project has no directory-shaped resource at all — such
 * tasks fall back to the scratch `~/.rewter/workspaces/<taskId>` exactly like
 * a project-less task.
 */
export function primaryWorkspace(project: Project): ProjectResource | null {
  return (
    project.resources.find((r) => r.kind === "dir") ??
    project.resources.find((r) => r.kind === "repo") ??
    null
  );
}

/**
 * Creating a project over `/internal/projects`. The id, timestamps, and
 * `archived` are not fields here: the server mints the id and the clock, and a
 * project born archived is a contradiction — archiving is a later, explicit
 * act on something that existed.
 */
export const ProjectCreateSchema = z
  .object({
    // "global" and "pending" are directory names inside the skills root — a
    // project by either name would collide with them on disk. Refused at
    // creation, not in the slug schema, so existing rows always parse.
    slug: ProjectSlugSchema.refine(
      (s) => !(RESERVED_PROJECT_SLUGS as readonly string[]).includes(s),
      { message: `reserved slug — ${RESERVED_PROJECT_SLUGS.join(", ")} name skills directories` },
    ),
    name: z.string().min(1),
    description: z.string().default(""),
    resources: z.array(ProjectResourceSchema).default([]),
    policy: ProjectPolicySchema.default({}),
    modelPrefs: ProjectModelPrefsSchema.default({}),
  })
  .strict();
export type ProjectCreate = z.infer<typeof ProjectCreateSchema>;

/**
 * A partial update. `.strict()` for the same reason as `ModelPatchSchema`: a
 * misspelled field in a PATCH body is the failure mode that looks like success.
 * The slug is deliberately NOT patchable — it is the project's address (model
 * suffix, header, skills dir), and a rename would strand every client config
 * and stored reference pointing at the old one. Archiving rides here as a
 * plain boolean in both directions: unarchive is the same edit.
 */
export const ProjectPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    resources: z.array(ProjectResourceSchema).optional(),
    policy: ProjectPolicySchema.optional(),
    modelPrefs: ProjectModelPrefsSchema.optional(),
    archived: z.boolean().optional(),
  })
  .strict();
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Apply a patch, or return `undefined` when nothing changed — same contract as
 * `applyModelPatch`, for the same reason: a save that changed nothing must not
 * bump `updatedAt` into claiming an edit that never happened.
 */
export function applyProjectPatch(
  existing: Project,
  patch: ProjectPatch,
  now: number,
): Project | undefined {
  const keys = ["name", "description", "resources", "policy", "modelPrefs", "archived"] as const;
  const changed = keys.some((key) => patch[key] !== undefined && !same(existing[key], patch[key]));
  if (!changed) return undefined;

  return ProjectSchema.parse({
    ...existing,
    ...(patch.name !== undefined && { name: patch.name }),
    ...(patch.description !== undefined && { description: patch.description }),
    ...(patch.resources !== undefined && { resources: patch.resources }),
    ...(patch.policy !== undefined && { policy: patch.policy }),
    ...(patch.modelPrefs !== undefined && { modelPrefs: patch.modelPrefs }),
    ...(patch.archived !== undefined && { archived: patch.archived }),
    updatedAt: now,
  });
}
