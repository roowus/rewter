/**
 * The skills digest has the registry digest's contract: deterministic bytes
 * (per-project prompt caching depends on it) and an honest budget (a dropped
 * skill is *stated*, never silently absent).
 */
import { ProjectSlugSchema, type Skill, SkillSchema, SkillSlugSchema } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { renderSkillsDigest } from "./digest.js";

function skill(over: Partial<Omit<Skill, "slug">> & { slug: string }): Skill {
  return SkillSchema.parse({
    status: "approved",
    scope: "global",
    projectSlug: null,
    path: `/skills/global/${over.slug}/SKILL.md`,
    description: `does ${over.slug}`,
    learnedFrom: null,
    uses: 0,
    updatedAt: 1_700_000_000_000,
    ...over,
    slug: SkillSlugSchema.parse(over.slug),
  });
}

describe("renderSkillsDigest", () => {
  it("renders one line per skill: slug — description", () => {
    const out = renderSkillsDigest([
      skill({ slug: "deploy-checklist", description: "Run the deploy checklist end to end" }),
      skill({ slug: "release-notes", description: "Write release notes from the changelog" }),
    ]);
    expect(out).toBe(
      [
        "deploy-checklist — Run the deploy checklist end to end",
        "release-notes — Write release notes from the changelog",
      ].join("\n"),
    );
  });

  it("marks project-scoped skills, because shadowing is a fact worth seeing", () => {
    const out = renderSkillsDigest([
      skill({
        slug: "deploy-checklist",
        scope: "project",
        projectSlug: ProjectSlugSchema.parse("acme"),
        path: "/skills/acme/deploy-checklist/SKILL.md",
        description: "Acme's deploy checklist",
      }),
    ]);
    expect(out).toBe("deploy-checklist (project) — Acme's deploy checklist");
  });

  it("renders the empty library as an empty string", () => {
    expect(renderSkillsDigest([])).toBe("");
  });

  it("is deterministic: same input, same bytes", () => {
    const skills = [skill({ slug: "a" }), skill({ slug: "b" }), skill({ slug: "c" })];
    expect(renderSkillsDigest(skills)).toBe(renderSkillsDigest(skills));
  });

  it("preserves the caller's order — visibility already sorted it", () => {
    const out = renderSkillsDigest([skill({ slug: "zulu" }), skill({ slug: "alpha" })]);
    expect(out.split("\n")[0]).toContain("zulu");
  });

  it("drops from the end past the budget and says so", () => {
    const skills = [
      skill({ slug: "first", description: "short" }),
      skill({ slug: "second", description: "x".repeat(400) }),
      skill({ slug: "third", description: "y".repeat(400) }),
    ];
    const out = renderSkillsDigest(skills, { maxTokens: 30 });
    expect(out).toContain("first — short");
    expect(out).not.toContain("second");
    expect(out).not.toContain("third");
    expect(out).toContain("(2 further skill(s) omitted for space.)");
  });

  it("keeps everything when the budget allows", () => {
    const out = renderSkillsDigest([skill({ slug: "a" }), skill({ slug: "b" })], {
      maxTokens: 1000,
    });
    expect(out).not.toContain("omitted");
    expect(out.split("\n")).toHaveLength(2);
  });
});
