import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ENV_FILE, loadEnvFile, mergeEnv } from "./envfile.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewter-envfile-"));
  path = join(dir, "env");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes the file 0600, which is the mode the docs tell people to use. */
function write(body: string): string {
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

describe("loadEnvFile", () => {
  it("reads KEY=value lines", () => {
    write("ANTHROPIC_API_KEY=sk-ant-123\nOPENAI_API_KEY=sk-oai-456\n");
    const file = loadEnvFile(path);
    expect(file.values).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-123",
      OPENAI_API_KEY: "sk-oai-456",
    });
    expect(file.source).toBe(path);
    expect(file.warnings).toEqual([]);
  });

  it("treats a missing file as nothing to add, not an error", () => {
    // Running from a shell that already exports everything is the normal case.
    expect(loadEnvFile(join(dir, "absent"))).toEqual({ values: {}, source: null, warnings: [] });
  });

  it("ignores blanks and comments", () => {
    write("# providers\n\nANTHROPIC_API_KEY=sk-1\n\n  # trailing thought\n");
    expect(loadEnvFile(path).values).toEqual({ ANTHROPIC_API_KEY: "sk-1" });
  });

  it("tolerates `export ` because people copy these lines out of ~/.zshrc", () => {
    write("export ANTHROPIC_API_KEY=sk-1\n");
    expect(loadEnvFile(path).values).toEqual({ ANTHROPIC_API_KEY: "sk-1" });
  });

  it("strips matched quotes", () => {
    write(`A="sk-double"\nB='sk-single'\nC=sk-bare\n`);
    expect(loadEnvFile(path).values).toEqual({ A: "sk-double", B: "sk-single", C: "sk-bare" });
  });

  it("keeps an unmatched quote, which is a character in the value", () => {
    write(`A="sk-1\n`);
    expect(loadEnvFile(path).values.A).toBe(`"sk-1`);
  });

  it("keeps a `#` inside a key rather than reading it as a comment", () => {
    // Real tokens contain punctuation; only whitespace-then-# starts a comment.
    write("A=sk-with#hash\nB=sk-2 # the openai one\n");
    expect(loadEnvFile(path).values).toEqual({ A: "sk-with#hash", B: "sk-2" });
  });

  it("does not treat `#` inside quotes as a comment either", () => {
    write(`A="sk-2 # not a comment"\n`);
    expect(loadEnvFile(path).values.A).toBe("sk-2 # not a comment");
  });

  it("keeps `=` in the value — base64 tokens end in them", () => {
    write("A=abc==\n");
    expect(loadEnvFile(path).values.A).toBe("abc==");
  });

  it("expands escapes in double quotes only", () => {
    write(`A="one\\ntwo"\nB='one\\ntwo'\n`);
    expect(loadEnvFile(path).values.A).toBe("one\ntwo");
    expect(loadEnvFile(path).values.B).toBe("one\\ntwo");
  });

  it("accepts an empty value as a deliberate blank", () => {
    write("ANTHROPIC_API_KEY=\n");
    expect(loadEnvFile(path).values).toEqual({ ANTHROPIC_API_KEY: "" });
  });

  it("last line wins when a key repeats", () => {
    write("A=first\nA=second\n");
    expect(loadEnvFile(path).values.A).toBe("second");
  });

  it("names a malformed line without echoing it", () => {
    // The thing on a malformed line in this file is quite likely half a key.
    write("ANTHROPIC_API_KEY=sk-1\nsk-oops-pasted-a-bare-key\n");
    const file = loadEnvFile(path);
    expect(file.values).toEqual({ ANTHROPIC_API_KEY: "sk-1" });
    expect(file.warnings).toHaveLength(1);
    expect(file.warnings[0]).toContain(":2");
    expect(file.warnings[0]).not.toContain("sk-oops");
  });

  it("rejects a key that is not a shell identifier", () => {
    write("not a key=value\n");
    expect(loadEnvFile(path).values).toEqual({});
    expect(loadEnvFile(path).warnings).toHaveLength(1);
  });

  it("rejects a line starting with `=`", () => {
    write("=value\n");
    expect(loadEnvFile(path).values).toEqual({});
  });

  it("warns when the file is readable by anyone else", () => {
    // ~/.rewter/env is the one place a raw key lives; 0644 is the default
    // everywhere else, so this is the mistake to catch.
    write("A=sk-1\n");
    chmodSync(path, 0o644);
    const file = loadEnvFile(path);
    expect(file.warnings.join("")).toContain("0644");
    expect(file.warnings.join("")).toContain("chmod 600");
    // Loud, but still loaded: a daemon dead at login explains itself worse.
    expect(file.values.A).toBe("sk-1");
  });

  it("says nothing about a mode that is already owner-only", () => {
    write("A=sk-1\n");
    expect(loadEnvFile(path).warnings).toEqual([]);
  });

  it("never puts a value in a warning", () => {
    write("A=sk-secret-1\nbroken line\n");
    chmodSync(path, 0o644);
    expect(loadEnvFile(path).warnings.join("")).not.toContain("sk-secret");
  });
});

describe("mergeEnv", () => {
  it("adds what the environment does not have", () => {
    expect(mergeEnv({ PATH: "/bin" }, { A: "from-file" })).toMatchObject({
      PATH: "/bin",
      A: "from-file",
    });
  });

  it("lets the real environment win", () => {
    // `ANTHROPIC_API_KEY=sk-x rewter start` must still override for one run.
    expect(mergeEnv({ A: "from-env" }, { A: "from-file" }).A).toBe("from-env");
  });

  it("treats an exported empty string as set", () => {
    // `A= rewter start` is how you say "pretend I have no A".
    expect(mergeEnv({ A: "" }, { A: "from-file" }).A).toBe("");
  });

  it("does not mutate either input", () => {
    const env = { A: "env" };
    const file = { B: "file" };
    mergeEnv(env, file);
    expect(env).toEqual({ A: "env" });
    expect(file).toEqual({ B: "file" });
  });
});

describe("DEFAULT_ENV_FILE", () => {
  it("sits beside the config and the database", () => {
    expect(DEFAULT_ENV_FILE).toBe("~/.rewter/env");
  });
});
