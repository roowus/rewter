import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveSkill, rejectSkill } from "./stage.js";
import { scanSkillsTree } from "./store.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rewter-stage-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function draft(slug: string, opts: { project?: string; name?: string; raw?: string } = {}) {
  const dir = join(root, "pending", slug);
  mkdirSync(dir, { recursive: true });
  const fm = [
    "---",
    `name: ${opts.name ?? slug}`,
    "description: what it is for",
    ...(opts.project !== undefined ? [`project: ${opts.project}`] : []),
    "---",
    "",
    "## Steps",
    "",
    "1. do",
    "",
  ].join("\n");
  writeFileSync(join(dir, "SKILL.md"), opts.raw ?? fm);
}

describe("approveSkill", () => {
  it("moves a bare draft into global/ and the scanner accepts it there", () => {
    draft("a-skill");
    const out = approveSkill(root, "a-skill");
    expect(out).toMatchObject({
      ok: true,
      scope: "global",
      projectSlug: null,
      path: join(root, "global", "a-skill", "SKILL.md"),
    });
    expect(existsSync(join(root, "pending", "a-skill"))).toBe(false);

    const scan = scanSkillsTree(root);
    expect(scan.problems).toEqual([]);
    expect(scan.skills).toMatchObject([{ slug: "a-skill", status: "approved", scope: "global" }]);
  });

  it("routes a project-targeted draft into that project's directory", () => {
    draft("a-skill", { project: "clarity" });
    const out = approveSkill(root, "a-skill", { projectExists: (p) => p === "clarity" });
    expect(out).toMatchObject({ ok: true, scope: "project", projectSlug: "clarity" });
    expect(existsSync(join(root, "clarity", "a-skill", "SKILL.md"))).toBe(true);
  });

  it("refuses a target project that does not exist, leaving the draft in place", () => {
    draft("a-skill", { project: "ghost" });
    const out = approveSkill(root, "a-skill", { projectExists: () => false });
    expect(out).toMatchObject({ ok: false, code: "unknown_project" });
    expect(existsSync(join(root, "pending", "a-skill", "SKILL.md"))).toBe(true);
  });

  it("refuses a slug collision unless overwrite is explicit", () => {
    draft("a-skill");
    expect(approveSkill(root, "a-skill").ok).toBe(true);

    draft("a-skill", { raw: "---\nname: a-skill\ndescription: v2\n---\n\nnew body\n" });
    const refused = approveSkill(root, "a-skill");
    expect(refused).toMatchObject({ ok: false, code: "conflict" });
    // Both copies survive the refusal.
    expect(existsSync(join(root, "global", "a-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "pending", "a-skill", "SKILL.md"))).toBe(true);

    const replaced = approveSkill(root, "a-skill", { overwrite: true });
    expect(replaced.ok).toBe(true);
    expect(readFileSync(join(root, "global", "a-skill", "SKILL.md"), "utf8")).toContain("new body");
    expect(existsSync(join(root, "pending", "a-skill"))).toBe(false);
  });

  it("refuses an unparseable draft and a name/slug mismatch without moving anything", () => {
    draft("broken", { raw: "no frontmatter at all" });
    expect(approveSkill(root, "broken")).toMatchObject({ ok: false, code: "invalid" });
    expect(existsSync(join(root, "pending", "broken", "SKILL.md"))).toBe(true);

    draft("renamed", { name: "something-else" });
    const out = approveSkill(root, "renamed");
    expect(out).toMatchObject({ ok: false, code: "invalid" });
    expect(out.ok === false && out.reason).toContain("does not match slug");
  });

  it("reports not_found for a slug with no draft", () => {
    expect(approveSkill(root, "nope")).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("rejectSkill", () => {
  it("deletes the pending directory and only the pending directory", () => {
    draft("a-skill");
    approveSkill(root, "a-skill");
    draft("a-skill"); // a fresh draft of the same slug
    expect(rejectSkill(root, "a-skill")).toEqual({ ok: true });
    expect(existsSync(join(root, "pending", "a-skill"))).toBe(false);
    // The approved copy is untouched.
    expect(existsSync(join(root, "global", "a-skill", "SKILL.md"))).toBe(true);
  });

  it("reports not_found for a slug with no draft", () => {
    expect(rejectSkill(root, "nope")).toMatchObject({ ok: false, code: "not_found" });
  });
});
