/**
 * The digest is the rules themselves, so what matters is: every fact is
 * carried verbatim, project facts are marked, the order is the input's stable
 * order, and going over budget is *stated* rather than silently truncated.
 */
import type { Practice } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_PRACTICES_MAX_TOKENS, renderPracticesDigest } from "./digest.js";

const practice = (slug: string, fact: string, projectSlug: string | null = null): Practice =>
  ({
    slug,
    status: "approved",
    scope: projectSlug === null ? "global" : "project",
    projectSlug,
    path: `/practices/${projectSlug ?? "global"}/${slug}/PRACTICE.md`,
    fact,
    learnedFrom: null,
    updatedAt: 1,
  }) as Practice;

describe("renderPracticesDigest", () => {
  it("renders one line per fact, marking project scope, in the given order", () => {
    const out = renderPracticesDigest([
      practice("a-rule", "Always run pnpm check before committing."),
      practice("b-rule", "Tests live next to the source file.", "rewter"),
    ]);
    expect(out).toBe(
      "- Always run pnpm check before committing.\n- Tests live next to the source file. (project)",
    );
  });

  it("renders nothing for no practices", () => {
    expect(renderPracticesDigest([])).toBe("");
  });

  it("drops the facts that do not fit and says how many", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      practice(`rule-${i}`, `Rule number ${i}: ${"words ".repeat(30)}`),
    );
    const out = renderPracticesDigest(many, { maxTokens: 200 });
    expect(out).toContain("Rule number 0:");
    expect(out).not.toContain("Rule number 39:");
    expect(out).toMatch(/\(\d+ further practice\(s\) omitted for space/);
  });

  it("default budget holds a realistic handful", () => {
    const ten = Array.from({ length: 10 }, (_, i) =>
      practice(`rule-${i}`, `Rule ${i}: keep commits small and focused, one concern each.`),
    );
    const out = renderPracticesDigest(ten);
    expect(out).not.toContain("omitted");
    expect(out.split("\n")).toHaveLength(10);
    expect(DEFAULT_PRACTICES_MAX_TOKENS).toBe(400);
  });

  it("is deterministic — same library, same bytes", () => {
    const lib = [practice("x", "X."), practice("y", "Y.", "p")];
    expect(renderPracticesDigest(lib)).toBe(renderPracticesDigest(lib));
  });
});
