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
import { effectiveTaskSettings, minCap, primaryWorkspace } from "./projects.js";

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
