/**
 * The two invariants that make the skills loop safe to ship with a learning
 * pipeline behind it live here: pending is NEVER visible, and project shadows
 * global on a slug collision. Everything else is shape validation.
 */
import { describe, expect, it } from "vitest";
import { ProjectSlugSchema, SkillSlugSchema, TaskIdSchema } from "./ids.js";
import { ProjectCreateSchema } from "./projects.js";
import {
  RESERVED_PROJECT_SLUGS,
  type Skill,
  SkillFrontmatterSchema,
  SkillSchema,
  visibleSkills,
} from "./skills.js";

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

const proj = (slug: string) => ProjectSlugSchema.parse(slug);

describe("SkillFrontmatterSchema", () => {
  it("accepts the agentskills.io minimum: name + description", () => {
    const fm = SkillFrontmatterSchema.parse({
      name: "deploy-checklist",
      description: "Run the deploy checklist",
    });
    expect(fm.name).toBe("deploy-checklist");
  });

  it("passes through unknown keys from imported skills instead of refusing them", () => {
    const fm = SkillFrontmatterSchema.parse({
      name: "imported",
      description: "from Claude Code",
      license: "MIT",
      "allowed-tools": ["Bash"],
      metadata: { author: "someone" },
    });
    expect((fm as Record<string, unknown>).license).toBe("MIT");
  });

  it("still validates known keys hard — this is LLM output in the distill path", () => {
    expect(() => SkillFrontmatterSchema.parse({ name: "Bad Name!", description: "x" })).toThrow();
    expect(() => SkillFrontmatterSchema.parse({ name: "ok", description: "" })).toThrow();
    expect(() =>
      SkillFrontmatterSchema.parse({ name: "ok", description: "x", learned_from: "not-a-task-id" }),
    ).toThrow();
    expect(() =>
      SkillFrontmatterSchema.parse({ name: "ok", description: "x", uses: -1 }),
    ).toThrow();
  });

  it("caps description at the agentskills.io ceiling (1024)", () => {
    expect(() =>
      SkillFrontmatterSchema.parse({ name: "ok", description: "x".repeat(1025) }),
    ).toThrow();
  });

  it("accepts rewter's provenance keys", () => {
    const fm = SkillFrontmatterSchema.parse({
      name: "learned",
      description: "distilled",
      learned_from: TaskIdSchema.parse("task_abc123def456"),
      uses: 3,
      project: "clarity",
    });
    expect(fm.learned_from).toBe("task_abc123def456");
    expect(fm.project).toBe("clarity");
  });
});

describe("visibleSkills", () => {
  it("never returns a pending skill, whatever the scope arguments say", () => {
    const all = [
      skill({ slug: "safe" }),
      skill({
        slug: "draft",
        status: "pending",
        path: "/skills/pending/draft/SKILL.md",
      }),
      skill({
        slug: "draft-for-proj",
        status: "pending",
        scope: "project",
        projectSlug: proj("clarity"),
        path: "/skills/pending/draft-for-proj/SKILL.md",
      }),
    ];
    expect(visibleSkills(all, null).map((s) => s.slug)).toEqual(["safe"]);
    expect(visibleSkills(all, "clarity").map((s) => s.slug)).toEqual(["safe"]);
  });

  it("shows global ∪ project for a project task, project shadowing global on collision", () => {
    const all = [
      skill({ slug: "deploy" }),
      skill({
        slug: "deploy",
        scope: "project",
        projectSlug: proj("clarity"),
        path: "/skills/clarity/deploy/SKILL.md",
      }),
      skill({ slug: "review" }),
      skill({
        slug: "calibrate",
        scope: "project",
        projectSlug: proj("clarity"),
        path: "/skills/clarity/calibrate/SKILL.md",
      }),
    ];
    const visible = visibleSkills(all, "clarity");
    expect(visible.map((s) => s.slug)).toEqual(["calibrate", "deploy", "review"]);
    expect(visible.find((s) => s.slug === "deploy")?.path).toBe("/skills/clarity/deploy/SKILL.md");
  });

  it("hides other projects' skills from a project task and from bare tasks", () => {
    const all = [
      skill({
        slug: "portfolio-only",
        scope: "project",
        projectSlug: proj("portfolio"),
        path: "/skills/portfolio/portfolio-only/SKILL.md",
      }),
    ];
    expect(visibleSkills(all, "clarity")).toEqual([]);
    expect(visibleSkills(all, null)).toEqual([]);
  });

  it("is stable-sorted by slug (digest cacheability)", () => {
    const all = [skill({ slug: "zeta" }), skill({ slug: "alpha" }), skill({ slug: "mid" })];
    expect(visibleSkills(all, null).map((s) => s.slug)).toEqual(["alpha", "mid", "zeta"]);
    expect(visibleSkills([...all].reverse(), null).map((s) => s.slug)).toEqual([
      "alpha",
      "mid",
      "zeta",
    ]);
  });

  it("does not mutate the caller's array", () => {
    const all = [skill({ slug: "b" }), skill({ slug: "a" })];
    visibleSkills(all, null);
    expect(all.map((s) => s.slug)).toEqual(["b", "a"]);
  });
});

describe("reserved project slugs", () => {
  it("refuses creating a project named after a skills scope directory", () => {
    for (const reserved of RESERVED_PROJECT_SLUGS) {
      expect(() => ProjectCreateSchema.parse({ slug: reserved, name: "X" })).toThrow(/reserved/);
    }
  });

  it("still accepts ordinary slugs", () => {
    expect(ProjectCreateSchema.parse({ slug: "clarity", name: "Clarity" }).slug).toBe("clarity");
  });
});
