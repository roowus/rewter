/**
 * The sandbox boundary. Every test here is an attempt to get `inside: true` for
 * a path that is not inside — because that boolean is the only thing standing
 * between a worker and an ungated write to someone's home directory.
 */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TaskId } from "@rewter/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { type Workspace, classify, contains, openWorkspace } from "./workspace.js";

const TASK = "task_abc" as TaskId;

let base: string;
let ws: Workspace;

beforeEach(() => {
  // realpath'd, because macOS hands out `/var/folders/…` for a directory that
  // really lives at `/private/var/folders/…`, and the workspace resolves symlinks.
  base = realpathSync(mkdtempSync(join(tmpdir(), "rewter-ws-")));
  ws = openWorkspace({ taskId: TASK, baseDir: base });
});

describe("openWorkspace", () => {
  it("creates the task's directory and points cwd at it", () => {
    expect(ws.cwd).toBe(ws.root);
    // Created, not merely computed — a worker's first write must not ENOENT.
    expect(classify(ws, ".").inside).toBe(true);
  });

  it("gives each task its own root", () => {
    const other = openWorkspace({ taskId: "task_xyz" as TaskId, baseDir: base });
    expect(other.root).not.toBe(ws.root);
    expect(classify(ws, other.root).inside).toBe(false);
  });

  it("puts cwd outside the zone when the task names a project directory", () => {
    // The point of `workspaceDir`: the worker edits real code, so every write is
    // outside the auto-approve zone by construction and gets gated.
    const project = realpathSync(mkdtempSync(join(tmpdir(), "rewter-proj-")));
    const pointed = openWorkspace({ taskId: TASK, baseDir: base, workspaceDir: project });
    expect(pointed.cwd).not.toBe(pointed.root);
    expect(classify(pointed, "src/index.ts").inside).toBe(false);
  });

  it("does not create a project directory that does not exist", () => {
    // A typo in a project path must fail on first use, not silently mkdir next
    // to the directory the user meant.
    const missing = join(base, "not-a-real-project");
    const pointed = openWorkspace({ taskId: TASK, baseDir: base, workspaceDir: missing });
    expect(pointed.cwd).toBe(missing);
    expect(() => classify(pointed, "x.txt")).not.toThrow();
  });

  it("treats an empty workspaceDir as unset rather than as the process cwd", () => {
    // `resolve("")` is the daemon's own cwd — a config field left as "" must not
    // silently point a worker at wherever the daemon happens to be running.
    for (const value of ["", "   ", null, undefined]) {
      const w = openWorkspace({ taskId: TASK, baseDir: base, workspaceDir: value });
      expect(w.cwd).toBe(w.root);
    }
  });
});

describe("classify", () => {
  it("resolves relative paths against cwd", () => {
    const p = classify(ws, "notes/plan.md");
    expect(p.absolute).toBe(resolve(ws.cwd, "notes/plan.md"));
    expect(p.inside).toBe(true);
  });

  it("keeps the path as written, for the approval prompt", () => {
    // An approval card that says "/private/var/folders/T/rewter-ws-x9/task_abc/../../etc"
    // is unreadable; the user needs to see what the worker actually asked for.
    expect(classify(ws, "../../etc/passwd").requested).toBe("../../etc/passwd");
  });

  it("catches traversal out of the zone", () => {
    expect(classify(ws, "../escape.txt").inside).toBe(false);
    expect(classify(ws, "a/b/../../../escape.txt").inside).toBe(false);
    expect(classify(ws, "/etc/passwd").inside).toBe(false);
  });

  it("catches a symlink that points out of the zone", () => {
    // The string check passes here and the path is still outside. This is why
    // classification resolves symlinks instead of comparing prefixes.
    const outside = join(base, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "s");
    symlinkSync(outside, join(ws.root, "link"));

    expect(classify(ws, "link/secret.txt").inside).toBe(false);
    expect(classify(ws, "link").inside).toBe(false);
  });

  it("checks a path whose parent does not exist yet", () => {
    // The write case: you cannot realpath a file you are about to create, and
    // skipping the check for those is the only hole that matters.
    expect(classify(ws, "new/deep/dir/file.txt").inside).toBe(true);
    expect(classify(ws, "../new/deep/file.txt").inside).toBe(false);
  });

  it("does not confuse a sibling whose name starts with the root's", () => {
    // `/…/task_abc-evil` is not inside `/…/task_abc`, however the strings sort.
    const sibling = `${ws.root}-evil`;
    mkdirSync(sibling, { recursive: true });
    expect(classify(ws, join(sibling, "f.txt")).inside).toBe(false);
  });

  it("counts the root itself as inside", () => {
    expect(classify(ws, ws.root).inside).toBe(true);
    expect(classify(ws, ".").inside).toBe(true);
  });
});

describe("contains", () => {
  it("requires a separator boundary", () => {
    expect(contains("/a/b", "/a/b")).toBe(true);
    expect(contains("/a/b", "/a/b/c")).toBe(true);
    expect(contains("/a/b", "/a/bc")).toBe(false);
    expect(contains("/a/b", "/a")).toBe(false);
  });

  it("handles a parent with a trailing separator", () => {
    expect(contains("/a/b/", "/a/b/c")).toBe(true);
  });
});
