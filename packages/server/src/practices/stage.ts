/**
 * The approval act for practices: move `pending/<slug>/` to its target scope
 * directory, or delete it. Same shape and failure codes as `skills/stage.ts`
 * so the HTTP layer maps them identically.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PRACTICE_FILENAME, parsePracticeMd } from "./store.js";

export interface StageFailure {
  ok: false;
  code: "not_found" | "invalid" | "unknown_project" | "conflict";
  reason: string;
}

export interface ApproveSuccess {
  ok: true;
  path: string;
  scope: "global" | "project";
  projectSlug: string | null;
}

export interface ApproveOptions {
  overwrite?: boolean | undefined;
  /** Refuse a draft whose target project does not exist. Absent = don't check. */
  projectExists?: ((slug: string) => boolean) | undefined;
}

/**
 * Approve re-reads the file: the owner may have edited the draft in place
 * before approving, and the version that lands must be the version that
 * parses. A draft that no longer parses is refused, not moved.
 */
export function approvePractice(
  root: string,
  slug: string,
  opts: ApproveOptions = {},
): ApproveSuccess | StageFailure {
  const pendingDir = join(root, "pending", slug);
  const pendingFile = join(pendingDir, PRACTICE_FILENAME);
  if (!existsSync(pendingFile)) {
    return { ok: false, code: "not_found", reason: `no pending draft: ${slug}` };
  }

  let project: string | undefined;
  try {
    const { frontmatter } = parsePracticeMd(readFileSync(pendingFile, "utf8"));
    if (frontmatter.name !== slug) {
      return {
        ok: false,
        code: "invalid",
        reason: `draft frontmatter name "${frontmatter.name}" != "${slug}"`,
      };
    }
    project = frontmatter.project;
  } catch (err) {
    return {
      ok: false,
      code: "invalid",
      reason: `draft does not parse — fix ${pendingFile} first: ${err instanceof Error ? err.message : err}`,
    };
  }

  if (project !== undefined && opts.projectExists !== undefined && !opts.projectExists(project)) {
    return {
      ok: false,
      code: "unknown_project",
      reason: `draft targets project "${project}", which does not exist — create it or edit the frontmatter`,
    };
  }

  const scopeDir = project ?? "global";
  const targetDir = join(root, scopeDir, slug);
  if (existsSync(targetDir)) {
    if (opts.overwrite !== true) {
      return {
        ok: false,
        code: "conflict",
        reason: `an approved "${slug}" already exists in ${scopeDir}/ — pass overwrite to replace it`,
      };
    }
    rmSync(targetDir, { recursive: true, force: true });
  }

  mkdirSync(join(root, scopeDir), { recursive: true });
  renameSync(pendingDir, targetDir);
  return {
    ok: true,
    path: join(targetDir, PRACTICE_FILENAME),
    scope: project === undefined ? "global" : "project",
    projectSlug: project ?? null,
  };
}

export function rejectPractice(root: string, slug: string): { ok: true } | StageFailure {
  const pendingDir = join(root, "pending", slug);
  if (!existsSync(join(pendingDir, PRACTICE_FILENAME))) {
    return { ok: false, code: "not_found", reason: `no pending draft: ${slug}` };
  }
  rmSync(pendingDir, { recursive: true, force: true });
  return { ok: true };
}
