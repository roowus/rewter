/**
 * Project semantics that must not fork between server and dashboard: how a
 * project's policy folds into a task's settings, and which resource is the
 * workspace. Both are pure — the server applies them at task creation, the
 * dashboard uses them to preview what a run inside a project will do.
 */
import type { Project, ProjectResource, TaskSettings } from "./entities.js";

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
