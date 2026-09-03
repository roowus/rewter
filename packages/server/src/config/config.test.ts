import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_PORT, expandPath, isLoopbackHost, loadConfig } from "./config.js";

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
    expect(config.internalKeyEnv).toBe("REWTER_INTERNAL_KEY");
  });

  it("resolves the default path against the passed HOME, not the process's", () => {
    // This test only fails on a machine that has a real ~/.rewter/config.json,
    // which is why it went unnoticed until the M8 acceptance created one. Under
    // launchd — or `sudo -u`, or a test — reading the invoking user's home
    // instead of the named one loads a stranger's providers. (#15)
    const home = mkdtempSync(join(tmpdir(), "rewter-home-"));
    try {
      writeFileSync(join(home, ".rewter-marker"), "x");
      expect(loadConfig({ env: { HOME: home } }).source).toBeNull();

      mkdirSync(join(home, ".rewter"));
      writeFileSync(join(home, ".rewter", "config.json"), JSON.stringify({ port: 20177 }));
      const loaded = loadConfig({ env: { HOME: home } });
      expect(loaded.source).toBe(join(home, ".rewter", "config.json"));
      expect(loaded.config.port).toBe(20177);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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

  it("tolerates line comments — the README's example is annotated", () => {
    // The quickstart hands people a jsonc block. Copying it verbatim is the
    // first thing a new user does, so it has to load. (#13)
    const path = writeConfig(`{
  "providers": [
    { "preset": "anthropic" },              // reads $ANTHROPIC_API_KEY
    { "preset": "zai" }                     // reads $ZAI_API_KEY
  ],
  "port": 20130
}`);
    const { config } = loadConfig({ path, env: {} });
    expect(config.providers.map((p) => p.preset)).toEqual(["anthropic", "zai"]);
    expect(config.port).toBe(20130);
  });

  it("tolerates block comments, including mid-line and multi-line", () => {
    const path = writeConfig(`{
  /* the cheap one first
     — it is the default for fan-out */
  "port": /* inline */ 20131,
  "providers": []
}`);
    expect(loadConfig({ path, env: {} }).config.port).toBe(20131);
  });

  it("does not strip a // inside a string value", () => {
    // The trap a naive comment-stripper falls into: every base URL contains
    // `//`, and eating it truncates the string into a parse error pointing at
    // the wrong line.
    const path = writeConfig(`{
  "providers": [
    { "slug": "local", "kind": "openai-compat", "baseUrl": "http://localhost:11434/v1" } // ollama
  ]
}`);
    const { config } = loadConfig({ path, env: {} });
    expect(config.providers[0]?.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("does not strip a comment marker hidden behind an escaped quote", () => {
    const path = writeConfig(`{ "providers": [], "models": [], "dbPath": "a\\"// not a comment" }`);
    expect(loadConfig({ path, env: {} }).config.dbPath).toBe('a"// not a comment');
  });

  it("still points at the real syntax error when a comment precedes it", () => {
    // Comments are blanked rather than removed, so byte offsets — and the
    // excerpt JSON.parse quotes back — match the file the operator has open.
    const path = writeConfig(`{\n  // a note\n  "port": oops\n}`);
    expect(() => loadConfig({ path, env: {} })).toThrow(/"port": oops/);
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

describe("harnesses.generic", () => {
  it("defaults to an empty list — no config, no generic harnesses", () => {
    const { config } = loadConfig({ env: { HOME: dir } });
    expect(config.harnesses.generic).toEqual([]);
  });

  it("accepts a full entry and preserves every field", () => {
    const path = writeConfig({
      harnesses: {
        generic: [
          {
            id: "aider",
            displayName: "Aider",
            binary: "/opt/homebrew/bin/aider",
            args: ["--message", "{instructions}", "--yes"],
            parse: "plain",
            donePattern: "^Applied edits",
            resumeArgs: ["--restore-chat-history"],
          },
        ],
      },
    });
    const { config } = loadConfig({ path, env: {} });
    const entry = config.harnesses.generic[0];
    expect(entry?.id).toBe("aider");
    expect(entry?.displayName).toBe("Aider");
    expect(entry?.binary).toBe("/opt/homebrew/bin/aider");
    expect(entry?.args).toEqual(["--message", "{instructions}", "--yes"]);
    expect(entry?.parse).toBe("plain");
    expect(entry?.donePattern).toBe("^Applied edits");
    expect(entry?.resumeArgs).toEqual(["--restore-chat-history"]);
  });

  it("a minimal jsonl entry needs only id, binary, and parse", () => {
    const path = writeConfig({
      harnesses: { generic: [{ id: "mytool", binary: "/usr/local/bin/mytool", parse: "jsonl" }] },
    });
    const { config } = loadConfig({ path, env: {} });
    expect(config.harnesses.generic[0]?.id).toBe("mytool");
  });

  it("rejects an id with a slash — it must compose into harness/<id>", () => {
    // The composite cost model id is `harness/<id>`; a slash inside the id
    // would make it unparseable as a ModelId.
    const path = writeConfig({
      harnesses: { generic: [{ id: "my/tool", binary: "x", parse: "plain" }] },
    });
    expect(() => loadConfig({ path, env: {} })).toThrow(/lowercase alphanumeric/);
  });

  it("rejects duplicate ids", () => {
    const path = writeConfig({
      harnesses: {
        generic: [
          { id: "twin", binary: "a", parse: "plain" },
          { id: "twin", binary: "b", parse: "plain" },
        ],
      },
    });
    expect(() => loadConfig({ path, env: {} })).toThrow(/unique/);
  });

  it('rejects an entry that shadows the built-in "claude-code"', () => {
    // Costs, allowedHarnesses, and re-adoption all key on the id; letting a
    // config entry claim "claude-code" would silently split that identity.
    const path = writeConfig({
      harnesses: { generic: [{ id: "claude-code", binary: "x", parse: "jsonl" }] },
    });
    expect(() => loadConfig({ path, env: {} })).toThrow(/claude-code/);
  });

  it("rejects a donePattern that is not a valid regular expression", () => {
    const path = writeConfig({
      harnesses: { generic: [{ id: "t", binary: "x", parse: "plain", donePattern: "([" }] },
    });
    expect(() => loadConfig({ path, env: {} })).toThrow(/valid regular expression/);
  });

  it("rejects a donePattern on a jsonl entry — the sentinel is a plain-mode idea", () => {
    const path = writeConfig({
      harnesses: { generic: [{ id: "t", binary: "x", parse: "jsonl", donePattern: "^DONE$" }] },
    });
    expect(() => loadConfig({ path, env: {} })).toThrow(/only applies to parse/);
  });
});

describe("search", () => {
  it("defaults to no provider — an old config boots with web_search undeclared", () => {
    const path = writeConfig({ port: 1234 });
    const { config } = loadConfig({ path, env: {} });
    expect(config.search).toEqual({
      provider: null,
      baseUrl: null,
      apiKeyEnv: null,
      maxResults: 8,
    });
  });

  it("accepts a full block", () => {
    const path = writeConfig({
      search: {
        provider: "searxng",
        baseUrl: "https://searx.example",
        apiKeyEnv: "SEARX_TOKEN",
        maxResults: 12,
      },
    });
    const { config } = loadConfig({ path, env: {} });
    expect(config.search.provider).toBe("searxng");
    expect(config.search.baseUrl).toBe("https://searx.example");
    expect(config.search.apiKeyEnv).toBe("SEARX_TOKEN");
    expect(config.search.maxResults).toBe(12);
  });

  it("rejects a provider it has no backend for", () => {
    const path = writeConfig({ search: { provider: "google" } });
    expect(() => loadConfig({ path, env: {} })).toThrow(/provider/);
  });

  it("caps maxResults at 20 — the tool's own schema caps a call there too", () => {
    const path = writeConfig({ search: { provider: "brave", maxResults: 21 } });
    expect(() => loadConfig({ path, env: {} })).toThrow(/maxResults/);
  });

  it("rejects a baseUrl that is not a URL", () => {
    const path = writeConfig({ search: { provider: "searxng", baseUrl: "searx.example" } });
    expect(() => loadConfig({ path, env: {} })).toThrow(/baseUrl/);
  });

  it("never holds a key — only the name of the variable that does", () => {
    // The block has no field a raw key could go in. Anything that looks like
    // one is an unknown key and refused, so a copy-pasted secret cannot land in
    // a config file that is routinely shared.
    const path = writeConfig({ search: { provider: "brave", apiKey: "BSA-secret" } });
    expect(() => loadConfig({ path, env: {} })).toThrow();
  });
});

describe("isLoopbackHost", () => {
  it("recognizes the loopback spellings", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
  });

  it("treats everything else — including nonsense — as non-loopback", () => {
    // The answer gates the fail-closed boot check; an unrecognized string that
    // slipped through as "loopback" would be the incident the check prevents.
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("100.71.4.20")).toBe(false); // a tailnet address
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("my-mac.tail1234.ts.net")).toBe(false);
    expect(isLoopbackHost("localhostx")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
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
