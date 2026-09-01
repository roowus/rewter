/**
 * Project semantics: policy folding and workspace selection.
 *
 * The cases that matter are the ones where a plausible implementation quietly
 * loosens a permission: an OR where the AND belongs, a null cap that beats a
 * number, a task inside a gated project running auto-approved. Every test here
 * is a "can the task end up with more than both sides agreed to" probe.
 */
import { describe, expect, it } from "vitest";
import { type Project, ProjectSchema, type TaskSettings, TaskSettingsSchema } from "./entities.js";
import { ModelIdSchema, ProjectSlugSchema, newProjectId } from "./ids.js";
import {
  ProjectCreateSchema,
  ProjectPatchSchema,
  applyProjectPatch,
  effectiveTaskSettings,
  minCap,
  primaryWorkspace,
} from "./projects.js";

function project(over: Record<string, unknown> = {}): Project {
  return ProjectSchema.parse({
    id: newProjectId(),
    slug: "test-proj",
    name: "Test Project",
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  });
}

function settings(over: Partial<TaskSettings> = {}): TaskSettings {
  return { ...TaskSettingsSchema.parse({}), ...over };
}

describe("ProjectSchema", () => {
  it("fills every optional field with a safe default", () => {
    const p = project();
    // The defaults ARE the safety story: no auto-approve, no resources, no
    // cap means the task's own cap governs.
    expect(p.description).toBe("");
    expect(p.resources).toEqual([]);
    expect(p.policy).toEqual({
      autoApprove: false,
      maxSpendUsd: null,
      allowedTools: null,
      allowedHarnesses: null,
    });
    expect(p.modelPrefs).toEqual({ initiatorPin: null, prefer: [], avoid: [] });
    expect(p.archived).toBe(false);
  });

  it("accepts a fully-populated project", () => {
    const p = project({
      description: "the big one",
      resources: [
        { kind: "repo", location: "/Users/x/projects/thing", note: "main checkout" },
        { kind: "url", location: "https://example.com/spec", note: null },
      ],
      policy: {
        autoApprove: true,
        maxSpendUsd: 2.5,
        allowedTools: ["shell"],
        allowedHarnesses: null,
      },
      modelPrefs: {
        initiatorPin: ModelIdSchema.parse("anthropic/claude-sonnet-5"),
        prefer: [ModelIdSchema.parse("zai/glm-5.3")],
        avoid: [],
      },
      archived: true,
    });
    expect(p.resources).toHaveLength(2);
    expect(p.policy.maxSpendUsd).toBe(2.5);
  });
});

describe("ProjectSlugSchema", () => {
  it.each(["a", "rewter", "my-proj-2", "a1-b2"])("accepts %j", (s) => {
    expect(ProjectSlugSchema.safeParse(s).success).toBe(true);
  });

  // The slug travels as a header value, a model-name suffix, and a directory
  // name — each rejected character breaks one of those channels.
  it.each([
    "", // empty
    "Has-Caps", // header canonicalization would fork lookups
    "under_score",
    "-leading",
    "trailing-",
    "double--dash",
    "sl/ash", // dirname
    "at@sign", // model-suffix delimiter
    "co:lon", // model-suffix delimiter
    "a".repeat(65), // max 64
  ])("rejects %j", (s) => {
    expect(ProjectSlugSchema.safeParse(s).success).toBe(false);
  });
});

describe("minCap", () => {
  it("null means no cap and loses to any number", () => {
    expect(minCap(null, null)).toBeNull();
    expect(minCap(null, 5)).toBe(5);
    expect(minCap(5, null)).toBe(5);
  });

  it("takes the lower of two numbers", () => {
    expect(minCap(2, 10)).toBe(2);
    expect(minCap(10, 2)).toBe(2);
    expect(minCap(3, 3)).toBe(3);
  });
});

describe("effectiveTaskSettings", () => {
  it("autoApprove requires BOTH sides — a gated project cannot be loosened per-task", () => {
    const gated = project({ policy: { autoApprove: false } });
    expect(effectiveTaskSettings(gated, settings({ autoApprove: true })).autoApprove).toBe(false);
  });

  it("a cautious task stays gated even inside a trusted project", () => {
    const trusted = project({ policy: { autoApprove: true } });
    expect(effectiveTaskSettings(trusted, settings({ autoApprove: false })).autoApprove).toBe(
      false,
    );
  });

  it("autoApprove on when both agree", () => {
    const trusted = project({ policy: { autoApprove: true } });
    expect(effectiveTaskSettings(trusted, settings({ autoApprove: true })).autoApprove).toBe(true);
  });

  it("spend cap is the lower of the two — a task can spend less than the project allows, never more", () => {
    const capped = project({ policy: { maxSpendUsd: 1 } });
    expect(effectiveTaskSettings(capped, settings({ maxSpendUsd: 5 })).maxSpendUsd).toBe(1);
    expect(effectiveTaskSettings(capped, settings({ maxSpendUsd: 0.5 })).maxSpendUsd).toBe(0.5);
  });

  it("an uncapped task inside a capped project gets the project cap", () => {
    const capped = project({ policy: { maxSpendUsd: 1 } });
    expect(effectiveTaskSettings(capped, settings({ maxSpendUsd: null })).maxSpendUsd).toBe(1);
  });

  it("uncapped on both sides stays uncapped", () => {
    expect(effectiveTaskSettings(project(), settings()).maxSpendUsd).toBeNull();
  });

  it("passes mechanics through untouched", () => {
    const p = project({ policy: { autoApprove: true, maxSpendUsd: 9 } });
    const folded = effectiveTaskSettings(
      p,
      settings({ workspaceDir: "/tmp/w", concurrency: 7, maxSpendUsd: 3 }),
    );
    expect(folded.workspaceDir).toBe("/tmp/w");
    expect(folded.concurrency).toBe(7);
    expect(folded.maxSpendUsd).toBe(3);
  });
});

describe("primaryWorkspace", () => {
  it("returns null when the project has no directory-shaped resource", () => {
    expect(primaryWorkspace(project())).toBeNull();
    expect(
      primaryWorkspace(project({ resources: [{ kind: "url", location: "https://x.test" }] })),
    ).toBeNull();
  });

  it("picks the FIRST dir even when a repo comes first", () => {
    const p = project({
      resources: [
        { kind: "repo", location: "/repo" },
        { kind: "dir", location: "/dir-a" },
        { kind: "dir", location: "/dir-b" },
      ],
    });
    expect(primaryWorkspace(p)?.location).toBe("/dir-a");
  });

  it("falls back to the first repo when no plain dir exists", () => {
    const p = project({
      resources: [
        { kind: "doc", location: "/notes.md" },
        { kind: "repo", location: "/repo-a" },
        { kind: "repo", location: "/repo-b" },
      ],
    });
    expect(primaryWorkspace(p)?.location).toBe("/repo-a");
  });
});

describe("ProjectCreateSchema", () => {
  it("fills the same safe defaults as ProjectSchema from just slug + name", () => {
    const c = ProjectCreateSchema.parse({ slug: "new-proj", name: "New" });
    expect(c.description).toBe("");
    expect(c.resources).toEqual([]);
    expect(c.policy.autoApprove).toBe(false);
    expect(c.policy.maxSpendUsd).toBeNull();
    expect(c.modelPrefs).toEqual({ initiatorPin: null, prefer: [], avoid: [] });
  });

  // The server mints id and timestamps; a project born archived is a
  // contradiction. A body that tries to supply them should fail loudly, not
  // be silently ignored — that's what .strict() buys.
  it.each(["id", "createdAt", "updatedAt", "archived", "nope"])(
    "rejects a body carrying %j",
    (key) => {
      const parsed = ProjectCreateSchema.safeParse({ slug: "s", name: "n", [key]: 1 });
      expect(parsed.success).toBe(false);
    },
  );

  it("requires a valid slug and a non-empty name", () => {
    expect(ProjectCreateSchema.safeParse({ slug: "Bad Slug", name: "n" }).success).toBe(false);
    expect(ProjectCreateSchema.safeParse({ slug: "ok", name: "" }).success).toBe(false);
  });
});

describe("ProjectPatchSchema", () => {
  it("accepts an empty patch (no-op is the route's problem, not the schema's)", () => {
    expect(ProjectPatchSchema.safeParse({}).success).toBe(true);
  });

  // The slug is the project's address (model suffix, header, skills dir) —
  // renaming it would strand every stored reference, so the schema refuses.
  it("rejects a slug change", () => {
    expect(ProjectPatchSchema.safeParse({ slug: "new-name" }).success).toBe(false);
  });

  it("rejects unknown fields — a misspelled PATCH field must not look like success", () => {
    expect(ProjectPatchSchema.safeParse({ nmae: "typo" }).success).toBe(false);
  });

  it("archived rides as a plain boolean in both directions", () => {
    expect(ProjectPatchSchema.safeParse({ archived: true }).success).toBe(true);
    expect(ProjectPatchSchema.safeParse({ archived: false }).success).toBe(true);
  });
});

describe("applyProjectPatch", () => {
  const NOW = 2000;

  it("returns undefined for an empty patch", () => {
    expect(applyProjectPatch(project(), {}, NOW)).toBeUndefined();
  });

  it("returns undefined when the patch restates current values — updatedAt stays honest", () => {
    const p = project({ description: "same" });
    expect(
      applyProjectPatch(p, { name: p.name, description: "same", archived: false }, NOW),
    ).toBeUndefined();
  });

  it("applies each field and bumps updatedAt", () => {
    const p = project();
    const next = applyProjectPatch(
      p,
      {
        name: "Renamed",
        description: "d",
        resources: [{ kind: "dir", location: "/w", note: null }],
        policy: { autoApprove: true, maxSpendUsd: 4, allowedTools: null, allowedHarnesses: null },
        modelPrefs: { initiatorPin: null, prefer: [], avoid: [] },
      },
      NOW,
    );
    expect(next).toBeDefined();
    expect(next?.name).toBe("Renamed");
    expect(next?.description).toBe("d");
    expect(next?.resources[0]?.location).toBe("/w");
    expect(next?.policy.maxSpendUsd).toBe(4);
    expect(next?.updatedAt).toBe(NOW);
    // Identity survives the patch — the address and the id never move.
    expect(next?.id).toBe(p.id);
    expect(next?.slug).toBe(p.slug);
    expect(next?.createdAt).toBe(p.createdAt);
  });

  it("archive and unarchive are the same edit", () => {
    const live = project();
    const archived = applyProjectPatch(live, { archived: true }, NOW);
    expect(archived?.archived).toBe(true);
    const revived = applyProjectPatch(archived as Project, { archived: false }, NOW + 1);
    expect(revived?.archived).toBe(false);
    expect(revived?.updatedAt).toBe(NOW + 1);
  });

  it("an untouched field keeps its value", () => {
    const p = project({ description: "keep me" });
    const next = applyProjectPatch(p, { name: "Only Name" }, NOW);
    expect(next?.description).toBe("keep me");
  });
});
