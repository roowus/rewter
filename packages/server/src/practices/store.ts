/**
 * The PRACTICE.md tree: parse one file, scan the whole root.
 *
 * Mirrors `skills/store.ts` deliberately — the two trees sit side by side
 * under `~/.rewter/` and an owner who has learned one layout has learned the
 * other. Differences are what the content demands: the body is the fact and is
 * length-capped, the frontmatter is strict, and there is no `uses` counter
 * (a practice is in every prompt, so "uses" would just count tasks).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  PRACTICE_MAX_CHARS,
  type Practice,
  type PracticeFrontmatter,
  PracticeFrontmatterSchema,
  PracticeSchema,
  PracticeSlugSchema,
  ProjectSlugSchema,
  RESERVED_PROJECT_SLUGS,
} from "@rewter/shared";
import { parse as parseYaml } from "yaml";
import { collapse } from "../llm/text.js";

export const PRACTICE_FILENAME = "PRACTICE.md";

export interface ParsedPracticeMd {
  frontmatter: PracticeFrontmatter;
  /** The fact, whitespace-collapsed: exactly what a prompt will carry. */
  fact: string;
}

/**
 * Parse a PRACTICE.md. Throws with a reason that names the offending part —
 * the message ends up in a log line or a CLI error, next to the path.
 */
export function parsePracticeMd(raw: string): ParsedPracticeMd {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    throw new Error("missing frontmatter: file must start with ---");
  }
  const close = raw.indexOf("\n---", 3);
  if (close === -1) throw new Error("unterminated frontmatter: no closing ---");

  const yamlText = raw.slice(raw.indexOf("\n") + 1, close);
  let data: unknown;
  try {
    data = parseYaml(yamlText);
  } catch (err) {
    throw new Error(`frontmatter is not valid YAML: ${err instanceof Error ? err.message : err}`);
  }
  const parsed = PracticeFrontmatterSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `frontmatter rejected: ${issue?.path.join(".") ?? "?"} ${issue?.message ?? "invalid"}`,
    );
  }

  const afterClose = raw.indexOf("\n", close + 1);
  const body = afterClose === -1 ? "" : raw.slice(afterClose + 1);
  const fact = collapse(body);
  if (fact === "") throw new Error("body is empty: a practice must state its fact");
  if (fact.length > PRACTICE_MAX_CHARS) {
    throw new Error(
      `body is ${fact.length} chars; a practice is capped at ${PRACTICE_MAX_CHARS} — if it needs more, it is a skill`,
    );
  }
  return { frontmatter: parsed.data, fact };
}

export interface PracticeProblem {
  path: string;
  reason: string;
}

export interface PracticeScanResult {
  practices: Practice[];
  problems: PracticeProblem[];
}

/**
 * Walk `root/<scope>/<slug>/PRACTICE.md`. A missing root is an empty tree,
 * not an error — a fresh install has none. Unreadable entries become
 * `problems`; one bad file never hides the rest.
 */
export function scanPracticesTree(root: string): PracticeScanResult {
  const practices: Practice[] = [];
  const problems: PracticeProblem[] = [];

  for (const scopeDir of listDirs(root)) {
    if (!isScopeDir(scopeDir)) {
      problems.push({
        path: join(root, scopeDir),
        reason: "directory name is not a valid slug — skipped",
      });
      continue;
    }
    for (const practiceDir of listDirs(join(root, scopeDir))) {
      const path = join(root, scopeDir, practiceDir, PRACTICE_FILENAME);
      try {
        practices.push(readPractice(path, scopeDir, practiceDir));
      } catch (err) {
        problems.push({ path, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { practices, problems };
}

function readPractice(path: string, scopeDir: string, dir: string): Practice {
  const slug = PracticeSlugSchema.safeParse(dir);
  if (!slug.success) throw new Error("directory name is not a valid practice slug");

  const { frontmatter: fm, fact } = parsePracticeMd(readFileSync(path, "utf8"));
  if (fm.name !== slug.data) {
    throw new Error(`frontmatter name "${fm.name}" != directory "${dir}"`);
  }

  const pending = scopeDir === "pending";
  const projectSlug = pending ? (fm.project ?? null) : scopeDir === "global" ? null : scopeDir;

  return PracticeSchema.parse({
    slug: slug.data,
    status: pending ? "pending" : "approved",
    scope: projectSlug === null ? "global" : "project",
    projectSlug,
    path,
    fact,
    learnedFrom: fm.learned_from ?? null,
    updatedAt: Math.trunc(statSync(path).mtimeMs),
  });
}

const SCOPE_DIRS: readonly string[] = RESERVED_PROJECT_SLUGS;

function isScopeDir(name: string): boolean {
  return SCOPE_DIRS.includes(name) || ProjectSlugSchema.safeParse(name).success;
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}
