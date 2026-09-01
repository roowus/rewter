/**
 * The approval gate (phase-2 M4, slice 3): approve moves a pending draft into
 * its scoped directory, reject deletes it. Both are pure tree mutations and
 * the caller reindexes afterwards — placement, not a DB write, is the approval
 * act (docs/design/phase2-direction.md §2, decision 4), so the file move is
 * the whole operation and the index just catches up.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SKILL_FILENAME, parseSkillMd } from "./store.js";

export interface StageFailure {
  ok: false;
  code: "not_found" | "invalid" | "unknown_project" | "conflict";
  /** Human-actionable: names the file or the fix, never just the code. */
  reason: string;
}

export interface ApproveSuccess {
  ok: true;
  /** The approved SKILL.md's new absolute path — its key in the fresh index. */
  path: string;
  scope: "global" | "project";
  projectSlug: string | null;
}

export type ApproveOutcome = ApproveSuccess | StageFailure;
export type RejectOutcome = { ok: true } | StageFailure;

export interface ApproveOptions {
  /**
   * Replace an existing approved skill of the same slug in the target scope.
   * Off by default: a draft may legitimately be a *replacement* for an
   * approved skill, but destroying the old copy must be said out loud.
   */
  overwrite?: boolean;
  /**
   * Whether the frontmatter's target project actually exists. Approving into
   * a directory no project answers to would strand the skill where retrieval
   * never looks — better to refuse and let the owner fix the frontmatter.
   */
  projectExists?: (slug: string) => boolean;
}

/**
 * Move `pending/<slug>` into the scope directory its frontmatter names
 * (`project: x` → `x/`, absent → `global/`). The file is re-read at approval
 * time, not trusted from the index: the owner may have edited it since the
 * last scan, and "edit first, then approve" is an intended flow.
 */
export function approveSkill(
  root: string,
  slug: string,
  opts: ApproveOptions = {},
): ApproveOutcome {
  const pendingDir = join(root, "pending", slug);
  const pendingFile = join(pendingDir, SKILL_FILENAME);
  if (!existsSync(pendingFile)) {
    return { ok: false, code: "not_found", reason: `no pending draft: ${slug}` };
  }

  let frontmatter: ReturnType<typeof parseSkillMd>["frontmatter"];
  try {
    frontmatter = parseSkillMd(readFileSync(pendingFile, "utf8")).frontmatter;
  } catch (err) {
    return {
      ok: false,
      code: "invalid",
      reason: `draft does not parse — fix ${pendingFile} first: ${(err as Error).message}`,
    };
  }
  // The scanner enforces name === directory after the move; checking it here
  // means a mismatch is refused with the file still in pending/, editable,
  // instead of moved somewhere the index will never accept it from.
  if (frontmatter.name !== slug) {
    return {
      ok: false,
      code: "invalid",
      reason: `frontmatter name "${frontmatter.name}" does not match slug "${slug}" — fix the file before approving`,
    };
  }

  const projectSlug = frontmatter.project ?? null;
  if (projectSlug !== null && !(opts.projectExists?.(projectSlug) ?? true)) {
    return {
      ok: false,
      code: "unknown_project",
      reason: `draft targets project "${projectSlug}", which does not exist — create it or edit the frontmatter`,
    };
  }

  const scopeDir = projectSlug ?? "global";
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
    path: join(targetDir, SKILL_FILENAME),
    scope: projectSlug === null ? "global" : "project",
    projectSlug,
  };
}

/** Delete `pending/<slug>` outright. The draft was never retrievable; nothing else references it. */
export function rejectSkill(root: string, slug: string): RejectOutcome {
  const pendingDir = join(root, "pending", slug);
  if (!existsSync(join(pendingDir, SKILL_FILENAME))) {
    return { ok: false, code: "not_found", reason: `no pending draft: ${slug}` };
  }
  rmSync(pendingDir, { recursive: true, force: true });
  return { ok: true };
}
