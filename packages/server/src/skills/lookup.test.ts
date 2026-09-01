/**
 * `load_skill`'s contract, pinned where it is implemented once for both
 * callers (initiator and tier-2 workers): the return value is always a tool
 * result string, and retrieval goes through `visibleSkills` — which is what
 * makes "a pending draft is never retrieved" a property of the system rather
 * than of each call site's discipline.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectSlugSchema, type Skill, SkillSchema, SkillSlugSchema } from "@rewter/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkillResult } from "./lookup.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rewter-lookup-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a real SKILL.md and return an index row pointing at it. */
function skillOnDisk(
  slug: string,
  over: Partial<Omit<Skill, "slug" | "path">> = {},
  body = `Steps for ${slug}.`,
): Skill {
  const scopeDir = over.scope === "project" ? (over.projectSlug ?? "proj") : "global";
  const dir = join(root, over.status === "pending" ? "pending" : scopeDir, slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, `---\nname: ${slug}\ndescription: does ${slug}\n---\n\n${body}\n`);
  return SkillSchema.parse({
    status: "approved",
    scope: "global",
    projectSlug: null,
    description: `does ${slug}`,
    learnedFrom: null,
    uses: 0,
    updatedAt: 1_700_000_000_000,
    ...over,
    slug: SkillSlugSchema.parse(slug),
    path,
  });
}

describe("loadSkillResult", () => {
  it("returns the slug, description and full body for a visible skill", () => {
    const s = skillOnDisk("deploy-checklist", {}, "1. run tests\n2. tag\n3. ship");
    const out = loadSkillResult([s], null, "deploy-checklist");
    expect(out).toContain("Skill: deploy-checklist");
    expect(out).toContain("does deploy-checklist");
    expect(out).toContain("3. ship");
  });

  it("refuses an unknown slug by naming what IS available", () => {
    // A bare "not found" costs the model a guess-and-retry loop over slugs it
    // cannot see — same rule as parseToolArgs on unknown tool names.
    const out = loadSkillResult([skillOnDisk("alpha"), skillOnDisk("beta")], null, "gamma");
    expect(out).toContain('no skill "gamma"');
    expect(out).toContain("alpha, beta");
  });

  it("says plainly when the library is empty for this task", () => {
    const out = loadSkillResult([], null, "anything");
    expect(out).toContain("no skills are available");
  });

  it("never retrieves a pending draft, even by exact slug", () => {
    // THE invariant of the approval gate (locked decision 4). The draft exists
    // on disk with valid frontmatter and the caller names it exactly — and the
    // answer is still the refusal, because `visibleSkills` filters on status.
    const draft = skillOnDisk("sneaky-draft", { status: "pending" });
    const approved = skillOnDisk("honest-skill");
    const out = loadSkillResult([draft, approved], null, "sneaky-draft");
    expect(out).toContain('no skill "sneaky-draft"');
    expect(out).not.toContain("Steps for sneaky-draft");
    expect(out).toContain("honest-skill");
  });

  it("does not leak another project's skills into this task", () => {
    const theirs = skillOnDisk("their-procedure", {
      scope: "project",
      projectSlug: ProjectSlugSchema.parse("other-proj"),
    });
    const out = loadSkillResult([theirs], "my-proj", "their-procedure");
    expect(out).toContain('no skill "their-procedure"');
  });

  it("serves the project copy when a project skill shadows a global one", () => {
    const global = skillOnDisk("deploy", {}, "the generic procedure");
    // Same slug, different file — write the project copy by hand so the two
    // bodies differ.
    const dir = join(root, "acme", "deploy");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    writeFileSync(
      path,
      "---\nname: deploy\ndescription: does deploy\n---\n\nthe ACME-specific procedure\n",
    );
    const project = SkillSchema.parse({
      ...global,
      scope: "project",
      projectSlug: ProjectSlugSchema.parse("acme"),
      path,
    });
    const out = loadSkillResult([global, project], "acme", "deploy");
    expect(out).toContain("ACME-specific");
    expect(out).not.toContain("generic");
  });

  it("turns a file that vanished under the index into advice, not a throw", () => {
    const s = skillOnDisk("gone");
    rmSync(s.path);
    const out = loadSkillResult([s], null, "gone");
    expect(out).toContain('skill "gone" could not be read');
    expect(out).toContain("Proceed without it");
  });
});
