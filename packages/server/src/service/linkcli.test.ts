import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI_COMMAND, installCli, uninstallCli } from "./linkcli.js";

let root: string;
let home: string;
let binDir: string;
let target: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rewter-linkcli-"));
  home = join(root, "home");
  binDir = join(home, ".local", "bin");
  target = join(root, "checkout", "packages", "cli", "dist", "index.js");
  mkdirSync(join(root, "checkout", "packages", "cli", "dist"), { recursive: true });
  // `tsc` emits 644 — no execute bit. That is the state we have to handle.
  writeFileSync(target, "#!/usr/bin/env node\n", { mode: 0o644 });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function opts(extra: Record<string, unknown> = {}) {
  return { target, home, pathEnv: [binDir, "/usr/bin"].join(delimiter), ...extra };
}

describe("installCli", () => {
  it("links the command into a PATH directory and reports it will be found", () => {
    const result = installCli(opts());

    expect(result.action).toBe("linked");
    expect(result.linkPath).toBe(join(binDir, CLI_COMMAND));
    expect(result.onPath).toBe(true);
    expect(result.next).toEqual([]);
    expect(readlinkSync(result.linkPath)).toBe(target);
  });

  it("creates the bin directory when it does not exist yet", () => {
    expect(existsSync(binDir)).toBe(false);
    installCli(opts());
    expect(existsSync(binDir)).toBe(true);
  });

  it("makes the target executable — a shebang alone does not run", () => {
    expect(lstatSync(target).mode & 0o111).toBe(0);
    installCli(opts());
    expect(lstatSync(target).mode & 0o111).toBe(0o111);
  });

  it("links rather than copies, so a rebuild is picked up with no reinstall", () => {
    const result = installCli(opts());
    expect(lstatSync(result.linkPath).isSymbolicLink()).toBe(true);
    // Rebuilding writes a new target; the link keeps pointing at it.
    writeFileSync(target, "#!/usr/bin/env node\n// v2\n");
    expect(readlinkSync(result.linkPath)).toBe(target);
  });

  it("says nothing changed when the link is already correct", () => {
    installCli(opts());
    const again = installCli(opts());
    expect(again.action).toBe("unchanged");
  });

  it("refuses to clobber a link pointing somewhere else without --force", () => {
    const other = join(root, "someone-elses-rewter");
    writeFileSync(other, "");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(other, join(binDir, CLI_COMMAND));

    const result = installCli(opts());
    expect(result.action).toBe("exists");
    expect(result.next[0]).toContain("--force");
    // Untouched.
    expect(readlinkSync(join(binDir, CLI_COMMAND))).toBe(other);
  });

  it("refuses to clobber a real file without --force", () => {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, CLI_COMMAND), "#!/bin/sh\necho not us\n");

    expect(installCli(opts()).action).toBe("exists");
    // Still theirs.
    expect(lstatSync(join(binDir, CLI_COMMAND)).isSymbolicLink()).toBe(false);
  });

  it("replaces an obstruction when --force is passed", () => {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, CLI_COMMAND), "#!/bin/sh\necho not us\n");

    const result = installCli(opts({ force: true }));
    expect(result.action).toBe("relinked");
    expect(readlinkSync(result.linkPath)).toBe(target);
  });

  it("prints the export line instead of editing a shell rc when off PATH", () => {
    const result = installCli(opts({ pathEnv: "/usr/bin" }));

    expect(result.action).toBe("linked");
    expect(result.onPath).toBe(false);
    expect(result.next).toHaveLength(1);
    expect(result.next[0]).toContain(`export PATH="${binDir}`);
    expect(result.next[0]).toContain(".zshrc");
  });

  it("writes nothing on a dry run but still reports where it would go", () => {
    const result = installCli(opts({ dryRun: true }));

    expect(result.action).toBe("dry-run");
    expect(result.linkPath).toBe(join(binDir, CLI_COMMAND));
    expect(existsSync(join(binDir, CLI_COMMAND))).toBe(false);
    // And the target keeps its original mode.
    expect(lstatSync(target).mode & 0o111).toBe(0);
  });

  it("honours an explicit --dir, expanding ~ against the given home", () => {
    const result = installCli(opts({ dir: "~/bin" }));
    expect(result.linkPath).toBe(join(home, "bin", CLI_COMMAND));
  });

  it("falls back to ~/.local/bin when no candidate is on PATH", () => {
    const result = installCli(opts({ pathEnv: "/some/unrelated/dir" }));
    expect(result.linkPath).toBe(join(binDir, CLI_COMMAND));
    expect(result.onPath).toBe(false);
  });

  it("never falls back to a sudo-only directory just because it exists", () => {
    // `/usr/local/bin` exists on most macs and is writable only as root. Off
    // PATH, it must not be chosen — the run would die on EACCES rather than
    // creating a directory the user owns.
    const result = installCli(opts({ pathEnv: "/usr/bin" }));
    expect(result.linkPath).toBe(join(binDir, CLI_COMMAND));
  });

  it("matches a PATH entry that differs only by a trailing slash or dot segment", () => {
    const result = installCli(opts({ pathEnv: `${join(home, ".local", "bin")}/./` }));
    expect(result.onPath).toBe(true);
    expect(result.next).toEqual([]);
  });

  it("does not throw when the target is missing — the caller reports that", () => {
    rmSync(target);
    const result = installCli(opts());
    expect(result.action).toBe("linked");
    expect(readlinkSync(result.linkPath)).toBe(target);
  });

  it("leaves an already-executable target's other mode bits alone", () => {
    chmodSync(target, 0o640);
    installCli(opts());
    expect(lstatSync(target).mode & 0o777).toBe(0o751);
  });
});

describe("uninstallCli", () => {
  it("removes a link that is ours", () => {
    const { linkPath } = installCli(opts());
    const result = uninstallCli(opts());

    expect(result.removed).toBe(true);
    expect(result.linkPath).toBe(linkPath);
    expect(existsSync(linkPath)).toBe(false);
  });

  it("leaves a link pointing at a different rewter alone", () => {
    const other = join(root, "other", "index.js");
    mkdirSync(join(root, "other"), { recursive: true });
    writeFileSync(other, "");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(other, join(binDir, CLI_COMMAND));

    const result = uninstallCli(opts());
    expect(result.removed).toBe(false);
    expect(result.reason).toContain(other);
    expect(existsSync(join(binDir, CLI_COMMAND))).toBe(true);
  });

  it("never deletes a real file someone else put there", () => {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, CLI_COMMAND), "#!/bin/sh\n");

    const result = uninstallCli(opts());
    expect(result.removed).toBe(false);
    expect(result.reason).toContain("not a symlink");
    expect(existsSync(join(binDir, CLI_COMMAND))).toBe(true);
  });

  it("is quiet when there is nothing installed", () => {
    const result = uninstallCli(opts());
    expect(result.removed).toBe(false);
    expect(result.reason).toBeUndefined();
  });
});
