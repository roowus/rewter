import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PIDFILE,
  type Pidfile,
  pidfilePath,
  readPidfile,
  removePidfile,
  writePidfile,
} from "./pidfile.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewter-pidfile-"));
  path = join(dir, "rewter.pid");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ENTRY: Pidfile = {
  pid: 4242,
  url: "http://127.0.0.1:8787",
  startedAt: 1_700_000_000_000,
  version: "0.1.0",
};

describe("writePidfile / readPidfile", () => {
  it("round-trips the claim a daemon leaves behind", () => {
    writePidfile(path, ENTRY);
    expect(readPidfile(path)).toEqual(ENTRY);
  });

  it("records the URL, not just the pid", () => {
    // The whole design rests on this: liveness is decided by asking the URL,
    // so a pidfile that carried only a pid would be unusable.
    writePidfile(path, ENTRY);
    expect(readPidfile(path)?.url).toBe("http://127.0.0.1:8787");
  });

  it("creates the directory rather than failing on a fresh machine", () => {
    const nested = join(dir, "a", "b", "rewter.pid");
    writePidfile(nested, ENTRY);
    expect(readPidfile(nested)).toEqual(ENTRY);
  });

  it("commits by rename, leaving no draft behind", () => {
    // A reader during a write sees the whole old file or the whole new one —
    // never a half-written pid it might go on to signal.
    writePidfile(path, ENTRY);
    expect(readdirSync(dir)).toEqual(["rewter.pid"]);
  });

  it("overwrites a previous daemon's claim", () => {
    writePidfile(path, ENTRY);
    const next = { ...ENTRY, pid: 99, url: "http://127.0.0.1:9000" };
    writePidfile(path, next);
    expect(readPidfile(path)).toEqual(next);
  });

  it("writes something a human can read in an editor", () => {
    writePidfile(path, ENTRY);
    expect(readFileSync(path, "utf8")).toMatch(/^\{\n {2}"pid": 4242,/);
  });
});

describe("readPidfile — the file is a claim, and claims can be malformed", () => {
  it("is undefined when there is no file", () => {
    expect(readPidfile(join(dir, "nothing.pid"))).toBeUndefined();
  });

  it("is undefined for a file truncated by a crash mid-write", () => {
    writeFileSync(path, '{"pid": 42, "url": "http');
    expect(readPidfile(path)).toBeUndefined();
  });

  it("is undefined for a shape an older version wrote", () => {
    // No error path of its own: the file is ours to rewrite, and every caller
    // wants the same answer — "there is no usable claim here".
    writeFileSync(path, JSON.stringify({ pid: 42 }));
    expect(readPidfile(path)).toBeUndefined();
  });

  it("rejects a pid that could not be a process", () => {
    for (const pid of [0, -1, 1.5]) {
      writeFileSync(path, JSON.stringify({ ...ENTRY, pid }));
      expect(readPidfile(path)).toBeUndefined();
    }
  });

  it("rejects an empty URL, which nothing could be probed at", () => {
    writeFileSync(path, JSON.stringify({ ...ENTRY, url: "" }));
    expect(readPidfile(path)).toBeUndefined();
  });

  it("is undefined when the path is a directory", () => {
    expect(readPidfile(dir)).toBeUndefined();
  });
});

describe("removePidfile", () => {
  it("removes it", () => {
    writePidfile(path, ENTRY);
    removePidfile(path);
    expect(readPidfile(path)).toBeUndefined();
  });

  it("is silent when it is already gone — absent is the desired state", () => {
    expect(() => removePidfile(join(dir, "never-existed.pid"))).not.toThrow();
  });
});

describe("pidfilePath", () => {
  it("defaults alongside the database, under ~/.rewter", () => {
    expect(pidfilePath("/Users/x")).toBe("/Users/x/.rewter/rewter.pid");
    expect(DEFAULT_PIDFILE).toBe("~/.rewter/rewter.pid");
  });

  it("expands ~ in an override the same way", () => {
    expect(pidfilePath("/Users/x", "~/scratch/one.pid")).toBe("/Users/x/scratch/one.pid");
  });

  it("leaves an absolute override alone", () => {
    expect(pidfilePath("/Users/x", "/tmp/two.pid")).toBe("/tmp/two.pid");
  });

  it("does not expand a bare ~ that is part of a name", () => {
    expect(pidfilePath("/Users/x", "~weird.pid")).toBe("~weird.pid");
  });
});
