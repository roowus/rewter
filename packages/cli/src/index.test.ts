import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./index.js";

let out: string[];
let err: string[];
let dir: string;

beforeEach(() => {
  out = [];
  err = [];
  dir = mkdtempSync(join(tmpdir(), "rewter-cli-"));
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
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A scratch config + database in a temp dir, and an env that points the CLI at
 * them. Nothing here touches `~/.rewter`, and no test is allowed a real key.
 */
function scratch(config: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  return { REWTER_CONFIG: path, REWTER_DB: join(dir, "rewter.db"), ...env };
}

/** Answers a catalog request per host, so a sync can hit two upstreams. */
function routedFetch(byHost: Record<string, unknown>): typeof globalThis.fetch {
  return (async (url: string | URL) => {
    const body = byHost[new URL(String(url)).host];
    if (body === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

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

  it("rejects a non-numeric --port before touching the database", async () => {
    expect(await run(["start", "--port", "eighty"])).toBe(1);
    expect(err.join("")).toContain("--port is not a number");
  });
});

/**
 * These drive the real command against a scratch config and database with a
 * stubbed `fetch` — the point is the wiring (config → registry → sync → exit
 * code), not the merge policy, which `sync.test.ts` owns.
 */
describe("run — sync-models", () => {
  const OPENAI = { data: [{ id: "gpt-5" }, { id: "gpt-4o" }] };
  const OPENROUTER = {
    data: [
      {
        id: "openai/gpt-5",
        name: "OpenAI: GPT-5",
        context_length: 400_000,
        pricing: { prompt: "0.00000125", completion: "0.00001" },
      },
    ],
  };

  it("writes the synced models into the daemon's own database", async () => {
    const env = scratch({ providers: [{ preset: "openai" }] }, { OPENAI_API_KEY: "sk-test" });
    const code = await run(["sync-models", "--no-enrich"], {
      env,
      fetch: routedFetch({ "api.openai.com": OPENAI }),
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("openai: 2 added");
    // …and the rows survive the process: a second run sees them already there.
    out = [];
    await run(["sync-models", "--no-enrich"], {
      env,
      fetch: routedFetch({ "api.openai.com": OPENAI }),
    });
    expect(out.join("")).toContain("openai: 0 added");
  });

  it("writes nothing on --dry-run", async () => {
    const env = scratch({ providers: [{ preset: "openai" }] }, { OPENAI_API_KEY: "sk-test" });
    const opts = { env, fetch: routedFetch({ "api.openai.com": OPENAI }) };
    expect(await run(["sync-models", "--dry-run", "--no-enrich"], opts)).toBe(0);
    expect(out.join("")).toContain("nothing written");

    out = [];
    await run(["sync-models", "--no-enrich"], opts);
    expect(out.join("")).toContain("2 added");
  });

  it("fills a thin catalog's prices from OpenRouter by default", async () => {
    const env = scratch(
      { providers: [{ preset: "openai" }, { preset: "openrouter" }] },
      { OPENAI_API_KEY: "sk-test", OPENROUTER_API_KEY: "sk-or" },
    );
    await run(["sync-models"], {
      env,
      fetch: routedFetch({
        "api.openai.com": { data: [{ id: "gpt-5" }] },
        "openrouter.ai": OPENROUTER,
      }),
    });
    expect(err.join("")).not.toContain("prices will not be filled");
  });

  it("warns that --provider filtered enrichment into a no-op", async () => {
    // Enrichment reads OpenRouter out of the same provider list, so scoping it
    // away leaves the prices null — silently, unless we say so.
    const env = scratch(
      { providers: [{ preset: "openai" }, { preset: "openrouter" }] },
      { OPENAI_API_KEY: "sk-test", OPENROUTER_API_KEY: "sk-or" },
    );
    await run(["sync-models", "--provider", "openai"], {
      env,
      fetch: routedFetch({ "api.openai.com": OPENAI }),
    });
    expect(err.join("")).toContain("prices will not be filled");
  });

  it("refuses a --provider that is not in the config", async () => {
    const env = scratch({ providers: [{ preset: "openai" }] }, { OPENAI_API_KEY: "sk-test" });
    expect(await run(["sync-models", "--provider", "groq"], { env })).toBe(1);
    expect(err.join("")).toContain('no provider named "groq"');
  });

  it("exits non-zero when a provider failed, so a cron'd sync goes red", async () => {
    const env = scratch({ providers: [{ preset: "openai" }] }, { OPENAI_API_KEY: "sk-test" });
    const code = await run(["sync-models", "--no-enrich"], {
      env,
      // Nothing answers api.openai.com → 404.
      fetch: routedFetch({}),
    });
    expect(code).toBe(1);
    expect(out.join("")).toContain("openai: failed");
  });
});

/**
 * Card generation through the CLI. The parsing and normalization live in
 * `registry/cards.test.ts`; what is under test here is the wiring and the
 * guards that stand between a typo and a bill.
 */
describe("run — card", () => {
  const CONFIG = {
    providers: [{ preset: "openai" }],
    models: [
      { id: "openai/gpt-5", provider: "openai" },
      { id: "openai/gpt-4o", provider: "openai" },
    ],
  };

  const CARD = JSON.stringify({
    summary: "Fast general-purpose model.",
    strengths: ["coding", "reasoning"],
    weaknesses: [],
    bestAt: ["coding"],
    notes: null,
  });

  /**
   * An OpenAI-shaped SSE completion carrying `content`. The router streams
   * everything — even a one-shot `complete()` collects a stream — so a plain
   * JSON body would be read as a stream that ended without a finish_reason.
   */
  function completionFetch(content: string): typeof globalThis.fetch {
    const chunk = (delta: unknown, finish: string | null = null) =>
      JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o",
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
    const usage = JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o",
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    });
    const body = [
      `data: ${chunk({ role: "assistant", content: "" })}\n\n`,
      `data: ${chunk({ content })}\n\n`,
      `data: ${chunk({}, "stop")}\n\n`,
      `data: ${usage}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    return (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof globalThis.fetch;
  }

  it("writes a card and prints it", async () => {
    const env = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    const opts = { env, fetch: completionFetch(CARD) };
    expect(await run(["card", "openai/gpt-5", "--using", "openai/gpt-4o"], opts)).toBe(0);
    expect(out.join("")).toContain("best at:    coding");

    // …and it persisted: `--show` reads it back out of the same database.
    out = [];
    expect(await run(["card", "openai/gpt-5", "--show"], { env })).toBe(0);
    expect(out.join("")).toContain("Fast general-purpose model.");
  });

  it("requires --using rather than picking a generator for you", async () => {
    // The generator is billed and its judgement outlives the call; choosing it
    // silently is the wrong kind of convenience.
    const env = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    expect(await run(["card", "openai/gpt-5"], { env })).toBe(1);
    expect(err.join("")).toContain("--using");
  });

  it("refuses an unknown --using before spending anything", async () => {
    const env = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    let called = false;
    const fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    expect(await run(["card", "openai/gpt-5", "--using", "nope/nope"], { env, fetch })).toBe(1);
    expect(err.join("")).toContain("unknown model: nope/nope");
    expect(called).toBe(false);
  });

  it("refuses an unknown target model", async () => {
    const env = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    expect(await run(["card", "openai/ghost", "--using", "openai/gpt-4o"], { env })).toBe(1);
    expect(err.join("")).toContain("unknown model(s): openai/ghost");
  });

  it("does not treat a bare `card` as every model", async () => {
    // A synced registry is hundreds of rows; an implicit --all is hundreds of
    // billed calls.
    const env = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    expect(await run(["card", "--using", "openai/gpt-4o"], { env })).toBe(1);
    expect(err.join("")).toContain("--all");
  });

  it("writes nothing on --dry-run", async () => {
    const env = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    const opts = { env, fetch: completionFetch(CARD) };
    expect(await run(["card", "openai/gpt-5", "--using", "openai/gpt-4o", "--dry-run"], opts)).toBe(
      0,
    );
    expect(out.join("")).toContain("nothing written");

    out = [];
    expect(await run(["card", "openai/gpt-5", "--show"], { env })).toBe(1);
    expect(out.join("")).toContain("no cards yet");
  });

  it("exits non-zero when the generator's reply had no card in it", async () => {
    const env = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    const opts = { env, fetch: completionFetch("I'm sorry, I can't help with that.") };
    expect(await run(["card", "openai/gpt-5", "--using", "openai/gpt-4o"], opts)).toBe(1);
    expect(out.join("")).toContain("failed");
  });

  it("skips a model that already has a card unless told to regenerate", async () => {
    const env = scratch(CONFIG, { OPENAI_API_KEY: "sk-test" });
    const opts = { env, fetch: completionFetch(CARD) };
    await run(["card", "openai/gpt-5", "--using", "openai/gpt-4o"], opts);

    out = [];
    expect(await run(["card", "openai/gpt-5", "--using", "openai/gpt-4o"], opts)).toBe(0);
    expect(out.join("")).toContain("already has a card");

    out = [];
    const args = ["card", "openai/gpt-5", "--using", "openai/gpt-4o", "--regenerate"];
    expect(await run(args, opts)).toBe(0);
    expect(out.join("")).toContain("best at:    coding");
  });
});
