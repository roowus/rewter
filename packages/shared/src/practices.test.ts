/**
 * The invariants that make always-in-context memory safe with a drafting
 * pipeline behind it: pending is NEVER visible, project shadows global, and a
 * fact cannot outgrow the prompt budget it lives in.
 */
import { describe, expect, it } from "vitest";
import { PracticeSlugSchema, ProjectSlugSchema, TaskIdSchema } from "./ids.js";
import {
  PRACTICE_MAX_CHARS,
  type Practice,
  PracticeFrontmatterSchema,
  PracticeSchema,
  visiblePractices,
} from "./practices.js";

function practice(over: Partial<Omit<Practice, "slug">> & { slug: string }): Practice {
  return PracticeSchema.parse({
    status: "approved",
    scope: "global",
    projectSlug: null,
    path: `/practices/global/${over.slug}/PRACTICE.md`,
    fact: `always ${over.slug}`,
    learnedFrom: null,
    updatedAt: 1_700_000_000_000,
    ...over,
    slug: PracticeSlugSchema.parse(over.slug),
  });
}

const proj = (slug: string) => ProjectSlugSchema.parse(slug);

describe("PracticeFrontmatterSchema", () => {
  it("accepts name alone, and the provenance keys", () => {
    expect(PracticeFrontmatterSchema.parse({ name: "prefer-pnpm" }).name).toBe("prefer-pnpm");
    const fm = PracticeFrontmatterSchema.parse({
      name: "prefer-pnpm",
      learned_from: TaskIdSchema.parse("task_abc123def456"),
      project: "clarity",
    });
    expect(fm.learned_from).toBe("task_abc123def456");
    expect(fm.project).toBe("clarity");
  });

  it("is strict — this is LLM output, and there is no foreign format to tolerate", () => {
    expect(() => PracticeFrontmatterSchema.parse({ name: "Bad Name!" })).toThrow();
    expect(() => PracticeFrontmatterSchema.parse({ name: "ok", description: "x" })).toThrow();
    expect(() =>
      PracticeFrontmatterSchema.parse({ name: "ok", learned_from: "not-a-task-id" }),
    ).toThrow();
  });
});

describe("PracticeSchema", () => {
  it("caps the fact at the always-in-context ceiling", () => {
    expect(() => practice({ slug: "long", fact: "x".repeat(PRACTICE_MAX_CHARS) })).not.toThrow();
    expect(() => practice({ slug: "long", fact: "x".repeat(PRACTICE_MAX_CHARS + 1) })).toThrow();
    expect(() => practice({ slug: "empty", fact: "" })).toThrow();
  });
});

describe("visiblePractices", () => {
  it("never returns a pending practice, whatever the scope arguments say", () => {
    const all = [
      practice({ slug: "safe" }),
      practice({ slug: "draft", status: "pending", path: "/practices/pending/draft/PRACTICE.md" }),
      practice({
        slug: "draft-for-proj",
        status: "pending",
        scope: "project",
        projectSlug: proj("clarity"),
        path: "/practices/pending/draft-for-proj/PRACTICE.md",
      }),
    ];
    expect(visiblePractices(all, null).map((p) => p.slug)).toEqual(["safe"]);
    expect(visiblePractices(all, "clarity").map((p) => p.slug)).toEqual(["safe"]);
  });

  it("shows global ∪ project for a project task, project shadowing global on collision", () => {
    const all = [
      practice({ slug: "commit-style" }),
      practice({
        slug: "commit-style",
        scope: "project",
        projectSlug: proj("clarity"),
        path: "/practices/clarity/commit-style/PRACTICE.md",
        fact: "conventional commits",
      }),
      practice({ slug: "prefer-pnpm" }),
      practice({
        slug: "portfolio-only",
        scope: "project",
        projectSlug: proj("portfolio"),
        path: "/practices/portfolio/portfolio-only/PRACTICE.md",
      }),
    ];
    const visible = visiblePractices(all, "clarity");
    expect(visible.map((p) => p.slug)).toEqual(["commit-style", "prefer-pnpm"]);
    expect(visible[0]?.fact).toBe("conventional commits");
    expect(visiblePractices(all, null).map((p) => p.slug)).toEqual(["commit-style", "prefer-pnpm"]);
    expect(visiblePractices(all, null)[0]?.fact).toBe("always commit-style");
  });

  it("is stable-sorted by slug and does not mutate the input", () => {
    const all = [practice({ slug: "zeta" }), practice({ slug: "alpha" })];
    expect(visiblePractices(all, null).map((p) => p.slug)).toEqual(["alpha", "zeta"]);
    expect(all.map((p) => p.slug)).toEqual(["zeta", "alpha"]);
  });
});
