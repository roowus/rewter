import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./index.js";

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run", () => {
  it("prints usage for `help`", async () => {
    expect(await run(["help"])).toBe(0);
    expect(out.join("")).toContain("rewter start");
  });

  it("prints usage when given no command", async () => {
    expect(await run([])).toBe(0);
    expect(out.join("")).toContain("Usage:");
  });

  it("documents that keys are read by env var name, not stored", async () => {
    // The one thing a new user must not get wrong.
    await run(["help"]);
    expect(out.join("")).toMatch(/variable \*name\*/);
  });

  it("prints the version", async () => {
    expect(await run(["version"])).toBe(0);
    expect(out.join("")).toMatch(/^rewter \d+\.\d+\.\d+\n$/);
  });

  it("exits non-zero on an unknown command and shows usage", async () => {
    expect(await run(["frobnicate"])).toBe(1);
    expect(err.join("")).toContain("unknown command: frobnicate");
    expect(err.join("")).toContain("Usage:");
  });

  it("says which milestone an unimplemented M8 command is waiting on", async () => {
    for (const cmd of ["stop", "status", "logs", "install-service", "gc"]) {
      expect(await run([cmd])).toBe(1);
      expect(err.join("")).toContain("M8");
      err = [];
    }
  });

  it("says which milestone an unimplemented M4 command is waiting on", async () => {
    for (const cmd of ["sync-models", "card"]) {
      expect(await run([cmd])).toBe(1);
      expect(err.join("")).toContain("M4");
      err = [];
    }
  });

  it("rejects a non-numeric --port before touching the database", async () => {
    expect(await run(["start", "--port", "eighty"])).toBe(1);
    expect(err.join("")).toContain("--port is not a number");
  });
});
