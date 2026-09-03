/**
 * Approve = move, reject = delete; both re-read nothing they don't have to and
 * refuse before they touch anything. The failure codes are what the HTTP layer
 * maps, so each is pinned here.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvePractice, rejectPractice } from "./stage.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rewter-practices-stage-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function draft(slug: string, frontmatter = `name: ${slug}`, body = "The fact.") {
  const dir = join(root, "pending", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PRACTICE.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe("approvePractice", () => {
  it("moves a global draft into global/ and reports where", () => {
    draft("no-force-push");
    const res = approvePractice(root, "no-force-push");
    expect(res).toEqual({
      ok: true,
      path: join(root, "global", "no-force-push", "PRACTICE.md"),
      scope: "global",
      projectSlug: null,
    });
    expect(existsSync(join(root, "pending", "no-force-push"))).toBe(false);
    expect(readFileSync(join(root, "global", "no-force-push", "PRACTICE.md"), "utf8")).toContain(
      "The fact.",
    );
  });

  it("moves a project draft into <project>/", () => {
    draft("use-uv", "name: use-uv\nproject: clarity");
    const res = approvePractice(root, "use-uv", { projectExists: (s) => s === "clarity" });
    expect(res).toMatchObject({ ok: true, scope: "project", projectSlug: "clarity" });
    expect(existsSync(join(root, "clarity", "use-uv", "PRACTICE.md"))).toBe(true);
  });

  it("refuses a draft whose project does not exist", () => {
    draft("use-uv", "name: use-uv\nproject: ghost");
    const res = approvePractice(root, "use-uv", { projectExists: () => false });
    expect(res).toMatchObject({ ok: false, code: "unknown_project" });
    expect(existsSync(join(root, "pending", "use-uv"))).toBe(true);
  });

  it("not_found for a slug with no draft", () => {
    expect(approvePractice(root, "nope")).toMatchObject({ ok: false, code: "not_found" });
  });

  it("invalid when the edited draft no longer parses or was renamed", () => {
    draft("wordy", "name: wordy", "x".repeat(500));
    expect(approvePractice(root, "wordy")).toMatchObject({ ok: false, code: "invalid" });
    draft("renamed", "name: other");
    expect(approvePractice(root, "renamed")).toMatchObject({ ok: false, code: "invalid" });
  });

  it("conflict on an approved twin unless overwrite is explicit", () => {
    draft("rule");
    approvePractice(root, "rule");
    draft("rule", "name: rule", "The newer fact.");
    expect(approvePractice(root, "rule")).toMatchObject({ ok: false, code: "conflict" });
    expect(approvePractice(root, "rule", { overwrite: true })).toMatchObject({ ok: true });
    expect(readFileSync(join(root, "global", "rule", "PRACTICE.md"), "utf8")).toContain(
      "The newer fact.",
    );
  });
});

describe("rejectPractice", () => {
  it("deletes the draft directory", () => {
    draft("rule");
    expect(rejectPractice(root, "rule")).toEqual({ ok: true });
    expect(existsSync(join(root, "pending", "rule"))).toBe(false);
  });

  it("not_found when there is nothing to reject", () => {
    expect(rejectPractice(root, "nope")).toMatchObject({ ok: false, code: "not_found" });
  });
});
