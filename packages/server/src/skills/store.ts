/**
 * The skills store: the on-disk SKILL.md tree and the scanner that turns it
 * into index rows (phase-2 M4, docs/design/phase2-direction.md §2).
 *
 * Layout under the root (default `~/.rewter/skills`):
 *
 *   global/<slug>/SKILL.md          approved, every task sees it
 *   <project-slug>/<slug>/SKILL.md  approved, tasks in that project see it
 *   pending/<slug>/SKILL.md         staged drafts — never retrieved
 *
 * The files are the source of truth — the owner edits them in any editor, adds
 * skills by copying a directory in (the Claude Code import path), deletes them
 * with `rm -r`. The scanner is therefore built to face an *untrusted* tree:
 * every file that fails to parse becomes a named problem in the scan result,
 * never an exception, because one malformed import must not take down
 * retrieval for the forty skills next to it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ProjectSlugSchema,
  RESERVED_PROJECT_SLUGS,
  type Skill,
  type SkillFrontmatter,
  SkillFrontmatterSchema,
  SkillSchema,
  SkillSlugSchema,
} from "@rewter/shared";
import { parse as parseYaml } from "yaml";

export const SKILL_FILENAME = "SKILL.md";

export interface ParsedSkillMd {
  frontmatter: SkillFrontmatter;
  /** Markdown after the closing `---`, leading newline trimmed. */
  body: string;
}

/**
 * Parse one SKILL.md: YAML frontmatter between `---` fences, body after.
 * Throws with a reason a human can act on — the scanner catches and files it
 * under the offending path.
 */
export function parseSkillMd(raw: string): ParsedSkillMd {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    throw new Error("missing frontmatter: file must start with ---");
  }
  const close = raw.indexOf("\n---", 3);
  if (close === -1) throw new Error("unterminated frontmatter: no closing ---");
  const yamlSrc = raw.slice(raw.indexOf("\n") + 1, close);

  let data: unknown;
  try {
    data = parseYaml(yamlSrc);
  } catch (err) {
    throw new Error(`frontmatter is not valid YAML: ${(err as Error).message}`);
  }
  const parsed = SkillFrontmatterSchema.safeParse(data);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(
      `frontmatter rejected: ${first ? `${first.path.join(".")} ${first.message}` : "invalid"}`,
    );
  }

  const bodyStart = raw.indexOf("\n", close + 1);
  // The blank line conventionally separating fence from body is separator,
  // not content — `load_skill` should hand the model the markdown, not framing.
  const body = bodyStart === -1 ? "" : raw.slice(bodyStart + 1).replace(/^(\r?\n)+/, "");
  return { frontmatter: parsed.data, body };
}

/** A file the scanner refused, and why — surfaced, never thrown. */
export interface SkillProblem {
  path: string;
  reason: string;
}

export interface ScanResult {
  skills: Skill[];
  problems: SkillProblem[];
}

/**
 * Walk the tree and produce one Skill per readable SKILL.md.
 *
 * Scope is read off the DIRECTORY for approved skills — where the owner put
 * the file is the approval act, and outranks anything the frontmatter claims.
 * Pending drafts live in `pending/` by definition, so for them the frontmatter
 * `project` key carries the *target* scope instead: where the file will move
 * on approval.
 *
 * A missing root is an empty result, not an error — a daemon that has never
 * learned anything has no skills directory, and that is the normal state.
 */
export function scanSkillsTree(root: string): ScanResult {
  const skills: Skill[] = [];
  const problems: SkillProblem[] = [];

  for (const scopeDir of listDirs(root)) {
    const scopePath = join(root, scopeDir);
    const scopeSlug = ProjectSlugSchema.safeParse(scopeDir);
    if (!scopeSlug.success) {
      problems.push({ path: scopePath, reason: "directory name is not a valid slug — skipped" });
      continue;
    }

    for (const skillDir of listDirs(scopePath)) {
      const path = join(scopePath, skillDir, SKILL_FILENAME);
      try {
        skills.push(readSkill(path, scopeDir, skillDir));
      } catch (err) {
        problems.push({ path, reason: (err as Error).message });
      }
    }
  }

  return { skills, problems };
}

function readSkill(path: string, scopeDir: string, skillDir: string): Skill {
  const slug = SkillSlugSchema.safeParse(skillDir);
  if (!slug.success) throw new Error("directory name is not a valid skill slug");

  const { frontmatter } = parseSkillMd(readFileSync(path, "utf8"));
  if (frontmatter.name !== slug.data) {
    // The slug is the address (`load_skill <slug>`, the digest line) and the
    // directory is what the owner sees — silence about a mismatch would make
    // the file un-loadable under the name the digest advertises.
    throw new Error(`frontmatter name "${frontmatter.name}" != directory "${skillDir}"`);
  }

  const pending = scopeDir === "pending";
  const projectSlug = pending
    ? (frontmatter.project ?? null)
    : scopeDir === "global"
      ? null
      : scopeDir;

  return SkillSchema.parse({
    slug: slug.data,
    status: pending ? "pending" : "approved",
    scope: projectSlug === null ? "global" : "project",
    projectSlug,
    path,
    description: frontmatter.description,
    learnedFrom: frontmatter.learned_from ?? null,
    uses: frontmatter.uses ?? 0,
    updatedAt: Math.trunc(statSync(path).mtimeMs),
  });
}

/**
 * Read the full body of a skill for `load_skill`. The caller passes a path
 * that came from the index, so failures here mean the tree changed under us —
 * let it throw; the tool layer renders tool errors already.
 */
export function readSkillBody(path: string): string {
  return parseSkillMd(readFileSync(path, "utf8")).body;
}

/** Reserved scope directories that are never project slugs. Re-exported for tests. */
export const SCOPE_DIRS = RESERVED_PROJECT_SLUGS;

function listDirs(path: string): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}
