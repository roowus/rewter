/**
 * The practices store faces an owner-edited tree, so the same contract as the
 * skills store: parse what's valid, NAME what isn't, never throw. What differs
 * is pinned here: the body IS the fact (collapsed, capped), the frontmatter is
 * strict, and placement decides pending/approved.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRACTICE_MAX_CHARS } from "@rewter/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePracticeMd, scanPracticesTree } from "./store.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rewter-practices-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writePractice(
  scopeDir: string,
  slug: string,
  frontmatter: string,
  body = "Never force-push a shared branch.",
) {
  const dir = join(root, scopeDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PRACTICE.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
  return join(dir, "PRACTICE.md");
}

describe("parsePracticeMd", () => {
  it("returns the body as one collapsed fact", () => {
    const { frontmatter, fact } = parsePracticeMd(
      "---\nname: no-force-push\n---\n\nNever   force-push\n\na shared branch.\n",
    );
    expect(frontmatter.name).toBe("no-force-push");
    expect(fact).toBe("Never force-push a shared branch.");
  });

  it("names the failure for a file without frontmatter", () => {
    expect(() => parsePracticeMd("just a fact\n")).toThrow(/missing frontmatter/);
    expect(() => parsePracticeMd("---\nname: x\n")).toThrow(/unterminated/);
  });

  it("rejects unknown keys — the frontmatter is strict, not passthrough", () => {
    expect(() => parsePracticeMd("---\nname: x\nlicense: MIT\n---\nfact")).toThrow(
      /frontmatter rejected/,
    );
    expect(() => parsePracticeMd("---\nname: Bad Name\n---\nfact")).toThrow(
      /frontmatter rejected: name/,
    );
  });

  it("refuses an empty body and an over-long one", () => {
    expect(() => parsePracticeMd("---\nname: x\n---\n\n\n")).toThrow(/body is empty/);
    expect(() =>
      parsePracticeMd(`---\nname: x\n---\n${"y".repeat(PRACTICE_MAX_CHARS + 1)}`),
    ).toThrow(/capped at/);
  });
});

describe("scanPracticesTree", () => {
  it("returns empty for a root that does not exist", () => {
    expect(scanPracticesTree(join(root, "nope"))).toEqual({ practices: [], problems: [] });
  });

  it("reads scope off the directory: global, project, pending", () => {
    writePractice("global", "no-force-push", "name: no-force-push");
    writePractice("clarity", "use-uv", "name: use-uv", "Use uv, never pip.");
    writePractice("pending", "draft", "name: draft\nlearned_from: task_0123456789ab");

    const { practices, problems } = scanPracticesTree(root);
    expect(problems).toEqual([]);
    const bySlug = new Map(practices.map((p) => [p.slug as string, p]));
    expect(bySlug.get("no-force-push")).toMatchObject({
      status: "approved",
      scope: "global",
      projectSlug: null,
      fact: "Never force-push a shared branch.",
      learnedFrom: null,
    });
    expect(bySlug.get("use-uv")).toMatchObject({
      status: "approved",
      scope: "project",
      projectSlug: "clarity",
      fact: "Use uv, never pip.",
    });
    expect(bySlug.get("draft")).toMatchObject({
      status: "pending",
      scope: "global",
      learnedFrom: "task_0123456789ab",
    });
  });

  it("pending drafts carry their frontmatter target project as scope", () => {
    writePractice("pending", "for-clarity", "name: for-clarity\nproject: clarity");
    const { practices } = scanPracticesTree(root);
    expect(practices[0]).toMatchObject({
      status: "pending",
      scope: "project",
      projectSlug: "clarity",
    });
  });

  it("directory placement outranks a frontmatter project claim once approved", () => {
    writePractice("global", "moved", "name: moved\nproject: clarity");
    const { practices } = scanPracticesTree(root);
    expect(practices[0]).toMatchObject({ scope: "global", projectSlug: null });
  });

  it("files a problem per bad practice and keeps the good ones", () => {
    writePractice("global", "good", "name: good");
    writePractice("global", "broken", "name: [unclosed");
    writePractice("global", "misnamed", "name: other-name");
    writePractice("global", "wordy", "name: wordy", "z".repeat(PRACTICE_MAX_CHARS + 1));
    mkdirSync(join(root, "global", "empty"), { recursive: true });

    const { practices, problems } = scanPracticesTree(root);
    expect(practices.map((p) => p.slug)).toEqual(["good"]);
    expect(problems).toHaveLength(4);
    const reasons = problems.map((p) => p.reason).join("\n");
    expect(reasons).toMatch(/name "other-name" != directory/);
    expect(reasons).toMatch(/capped at/);
  });

  it("skips a scope directory whose name is not a valid slug", () => {
    writePractice(".hidden", "x", "name: x");
    const { practices, problems } = scanPracticesTree(root);
    expect(practices).toEqual([]);
    expect(problems[0]?.reason).toMatch(/not a valid slug/);
  });

  it("uses the file mtime as updatedAt", () => {
    const path = writePractice("global", "aged", "name: aged");
    utimesSync(path, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const { practices } = scanPracticesTree(root);
    expect(practices[0]?.updatedAt).toBe(1_700_000_000_000);
  });
});
