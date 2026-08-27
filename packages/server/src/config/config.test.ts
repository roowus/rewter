import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_PORT, expandPath, loadConfig } from "./config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewter-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(contents: unknown | string): string {
  const path = join(dir, "config.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

describe("loadConfig", () => {
  it("applies defaults when no config file exists", () => {
    // A fresh machine with no config still boots — on loopback, with an empty
    // registry, which /v1/models will honestly report as empty.
    const { config, source } = loadConfig({ path: undefined, env: { HOME: dir } });
    expect(source).toBeNull();
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.providers).toEqual([]);
    expect(config.models).toEqual([]);
  });

  it("reads a config file and reports its path as the source", () => {
    const path = writeConfig({ port: 9999, providers: [{ preset: "anthropic" }] });
    const { config, source } = loadConfig({ path, env: {} });
    expect(source).toBe(path);
    expect(config.port).toBe(9999);
    expect(config.providers[0]?.preset).toBe("anthropic");
  });

  it("errors when an explicitly requested config file is missing", () => {
    // Silently falling back to defaults would boot an empty daemon and leave
    // the operator hunting for why their models vanished.
    expect(() => loadConfig({ path: join(dir, "nope.json"), env: {} })).toThrow(ConfigError);
  });

  it("does not error when the default config file is missing", () => {
    expect(() => loadConfig({ env: { HOME: dir } })).not.toThrow();
  });

  it("reports invalid JSON with the file path", () => {
    const path = writeConfig("{ not json");
    expect(() => loadConfig({ path, env: {} })).toThrow(/invalid JSON/);
    expect(() => loadConfig({ path, env: {} })).toThrow(path);
  });

  it("rejects a non-object config", () => {
    const path = writeConfig([1, 2, 3]);
    expect(() => loadConfig({ path, env: {} })).toThrow(/must be a JSON object/);
  });

  it("rejects a provider with neither preset nor slug+kind", () => {
    const path = writeConfig({ providers: [{ name: "mystery" }] });
    expect(() => loadConfig({ path, env: {} })).toThrow(/preset/);
  });

  it("accepts a provider defined without a preset", () => {
    const path = writeConfig({
      providers: [{ slug: "custom", kind: "openai-compat", baseUrl: "https://x.test/v1" }],
    });
    const { config } = loadConfig({ path, env: {} });
    expect(config.providers[0]?.slug).toBe("custom");
  });

  it("environment overrides win over the file", () => {
    const path = writeConfig({ port: 1111, host: "0.0.0.0", dbPath: "/from/file.db" });
    const { config } = loadConfig({
      path,
      env: { REWTER_PORT: "2222", REWTER_HOST: "127.0.0.1", REWTER_DB: "/from/env.db" },
    });
    expect(config.port).toBe(2222);
    expect(config.host).toBe("127.0.0.1");
    expect(config.dbPath).toBe("/from/env.db");
  });

  it("REWTER_CONFIG selects the file", () => {
    const path = writeConfig({ port: 4242 });
    const { config, source } = loadConfig({ env: { REWTER_CONFIG: path } });
    expect(source).toBe(path);
    expect(config.port).toBe(4242);
  });

  it("refuses a non-numeric REWTER_PORT rather than falling back", () => {
    // Falling back to the default would start a daemon nobody can find.
    expect(() => loadConfig({ env: { HOME: dir, REWTER_PORT: "eighty" } })).toThrow(/not a number/);
  });

  it("ignores an empty environment override", () => {
    const path = writeConfig({ port: 1234 });
    const { config } = loadConfig({ path, env: { REWTER_PORT: "", REWTER_HOST: "" } });
    expect(config.port).toBe(1234);
    expect(config.host).toBe("127.0.0.1");
  });

  it("fills model defaults, leaving unspecified prices null rather than free", () => {
    const path = writeConfig({
      providers: [{ preset: "anthropic" }],
      models: [{ id: "anthropic/claude-sonnet-5", provider: "anthropic" }],
    });
    const { config } = loadConfig({ path, env: {} });
    const model = config.models[0];
    expect(model?.pricing.inputPerMTok).toBeUndefined();
    expect(model?.modalities).toEqual(["text"]);
    expect(model?.supports.streaming).toBe(true);
    expect(model?.enabled).toBe(true);
  });

  it("rejects an out-of-range port", () => {
    const path = writeConfig({ port: 70_000 });
    expect(() => loadConfig({ path, env: {} })).toThrow(ConfigError);
  });
});

describe("expandPath", () => {
  it("expands a leading tilde", () => {
    expect(expandPath("~/.rewter/x.db", "/Users/test")).toBe("/Users/test/.rewter/x.db");
  });

  it("expands a bare tilde", () => {
    expect(expandPath("~", "/Users/test")).toBe("/Users/test");
  });

  it("leaves an absolute path alone", () => {
    expect(expandPath("/var/lib/rewter.db", "/Users/test")).toBe("/var/lib/rewter.db");
  });

  it("does not expand a tilde mid-path", () => {
    expect(expandPath("/tmp/~backup/x.db", "/Users/test")).toBe("/tmp/~backup/x.db");
  });

  it("makes a relative path absolute", () => {
    expect(expandPath("rewter.db", "/Users/test")).toBe(join(process.cwd(), "rewter.db"));
  });
});
