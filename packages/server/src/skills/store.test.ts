/**
 * The store faces an owner-edited, owner-imported tree, so the scanner's
 * contract is: parse what's valid, NAME what isn't, never throw. The pending/
 * approved distinction is directory placement, not frontmatter — these tests
 * pin both.
 */
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSkillMd, readSkillBody, scanSkillsTree } from "./store.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rewter-skills-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSkill(scopeDir: string, slug: string, frontmatter: string, body = "Do the thing.") {
  const dir = join(root, scopeDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
  return join(dir, "SKILL.md");
}

describe("parseSkillMd", () => {
  it("splits frontmatter from body", () => {
    const { frontmatter, body } = parseSkillMd(
      "---\nname: deploy\ndescription: Ship it safely\n---\n\n# Steps\n1. test\n",
    );
    expect(frontmatter.name).toBe("deploy");
    expect(body).toContain("# Steps");
  });

  it("names the failure for a file without frontmatter", () => {
    expect(() => parseSkillMd("# just markdown\n")).toThrow(/missing frontmatter/);
    expect(() => parseSkillMd("---\nname: x\ndescription: y\n")).toThrow(/unterminated/);
  });

  it("names the failure for broken YAML and for rejected keys", () => {
    expect(() => parseSkillMd("---\nname: [unclosed\n---\nbody")).toThrow(/not valid YAML/);
    expect(() => parseSkillMd("---\nname: Bad Name\ndescription: x\n---\nbody")).toThrow(
      /frontmatter rejected: name/,
    );
  });

  it("keeps unknown keys from imported skills", () => {
    const { frontmatter } = parseSkillMd(
      "---\nname: imported\ndescription: from elsewhere\nlicense: MIT\n---\nbody",
    );
    expect((frontmatter as Record<string, unknown>).license).toBe("MIT");
  });
});

describe("scanSkillsTree", () => {
  it("returns empty for a root that does not exist — the never-learned daemon", () => {
    expect(scanSkillsTree(join(root, "nope"))).toEqual({ skills: [], problems: [] });
  });

  it("reads scope off the directory: global, project, pending", () => {
    writeSkill("global", "deploy", "name: deploy\ndescription: Ship");
    writeSkill("clarity", "calibrate", "name: calibrate\ndescription: Tune thresholds");
    writeSkill("pending", "draft", "name: draft\ndescription: Not yet approved");

    const { skills, problems } = scanSkillsTree(root);
    expect(problems).toEqual([]);
    const bySlug = new Map<string, (typeof skills)[number]>(skills.map((s) => [s.slug, s]));
    expect(bySlug.get("deploy")).toMatchObject({
      status: "approved",
      scope: "global",
      projectSlug: null,
    });
    expect(bySlug.get("calibrate")).toMatchObject({
      status: "approved",
      scope: "project",
      projectSlug: "clarity",
    });
    expect(bySlug.get("draft")).toMatchObject({ status: "pending", scope: "global" });
  });

  it("pending drafts carry their frontmatter target project as scope", () => {
    writeSkill("pending", "for-clarity", "name: for-clarity\ndescription: X\nproject: clarity");
    const { skills } = scanSkillsTree(root);
    expect(skills[0]).toMatchObject({
      status: "pending",
      scope: "project",
      projectSlug: "clarity",
    });
  });

  it("directory placement outranks a frontmatter project claim for approved skills", () => {
    // An approved skill in global/ that still says `project: clarity` (say,
    // approved-by-move without editing) is GLOBAL — the move was the decision.
    writeSkill("global", "moved", "name: moved\ndescription: X\nproject: clarity");
    const { skills } = scanSkillsTree(root);
    expect(skills[0]).toMatchObject({ scope: "global", projectSlug: null });
  });

  it("files a problem, not an exception, for each bad skill — and keeps the good ones", () => {
    writeSkill("global", "good", "name: good\ndescription: Works");
    writeSkill("global", "broken", "name: [unclosed");
    // Frontmatter name disagreeing with the directory: the digest would
    // advertise a slug load_skill can't resolve.
    writeSkill("global", "misnamed", "name: other-name\ndescription: X");
    const dir = join(root, "global", "empty");
    mkdirSync(dir, { recursive: true }); // no SKILL.md at all

    const { skills, problems } = scanSkillsTree(root);
    expect(skills.map((s) => s.slug)).toEqual(["good"]);
    expect(problems).toHaveLength(3);
    expect(problems.map((p) => p.reason).join("\n")).toMatch(/name "other-name" != directory/);
  });

  it("skips a scope directory whose name is not a valid slug", () => {
    writeSkill(".hidden", "x", "name: x\ndescription: X");
    const { skills, problems } = scanSkillsTree(root);
    expect(skills).toEqual([]);
    expect(problems[0]?.reason).toMatch(/not a valid slug/);
  });

  it("uses the file mtime as updatedAt", () => {
    const path = writeSkill("global", "aged", "name: aged\ndescription: X");
    utimesSync(path, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const { skills } = scanSkillsTree(root);
    expect(skills[0]?.updatedAt).toBe(1_700_000_000_000);
  });
});

describe("readSkillBody", () => {
  it("returns the body for load_skill", () => {
    const path = writeSkill("global", "deploy", "name: deploy\ndescription: Ship", "# Steps\nGo.");
    expect(readSkillBody(path)).toBe("# Steps\nGo.\n");
  });
});
