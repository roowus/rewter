import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "./config/config.js";
import { type RunningDaemon, bootSummary, startDaemon } from "./daemon.js";

let dir: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewter-daemon-"));
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** Boot on port 0 (OS-assigned) with the DB inside the temp dir. */
async function boot(overrides: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
  const config = ConfigSchema.parse({
    dbPath: join(dir, "nested", "rewter.db"),
    logger: false,
    ...overrides,
  });
  daemon = await startDaemon({ config, env, port: 0 });
  return daemon;
}

describe("startDaemon", () => {
  it("listens and serves health", async () => {
    const d = await boot();
    const res = await fetch(`${d.url}/internal/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("creates the database directory if it does not exist", async () => {
    // A first run on a fresh machine must not fail because ~/.rewter is absent.
    const d = await boot();
    expect(d.db.$client.open).toBe(true);
  });

  it("seeds the registry from config and serves it on /v1/models", async () => {
    const d = await boot(
      {
        providers: [{ preset: "anthropic" }],
        models: [{ id: "anthropic/claude-sonnet-5", provider: "anthropic" }],
      },
      { ANTHROPIC_API_KEY: "sk-test" },
    );
    const body = (await (await fetch(`${d.url}/v1/models`)).json()) as {
      data: { id: string }[];
    };
    const ids = body.data.map((m) => m.id);
    expect(ids[0]).toBe("auto/orchestrator");
    expect(ids).toContain("anthropic/claude-sonnet-5");
  });

  it("hides models of a provider whose key env var is unset", async () => {
    // The provider is seeded disabled, so its models resolve to a 503 that
    // names them rather than silently disappearing from the picker's reach.
    const d = await boot({
      providers: [{ preset: "anthropic" }],
      models: [{ id: "anthropic/claude-sonnet-5", provider: "anthropic" }],
    });
    const res = await fetch(`${d.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain("claude-sonnet-5");
  });

  it("reads the bearer token from the environment by variable name", async () => {
    const d = await boot({ apiKeyEnv: "MY_REWTER_TOKEN" }, { MY_REWTER_TOKEN: "s3cret" });

    const denied = await fetch(`${d.url}/v1/models`);
    expect(denied.status).toBe(401);

    const allowed = await fetch(`${d.url}/v1/models`, {
      headers: { authorization: "Bearer s3cret" },
    });
    expect(allowed.status).toBe(200);
  });

  it("leaves /v1 open when the token env var is unset", async () => {
    const d = await boot({ apiKeyEnv: "UNSET_TOKEN_VAR" });
    expect((await fetch(`${d.url}/v1/models`)).status).toBe(200);
  });

  it("never gates /internal, even with a token configured", async () => {
    // The dashboard is same-origin and holds no key; /internal is loopback-only.
    const d = await boot({ apiKeyEnv: "MY_REWTER_TOKEN" }, { MY_REWTER_TOKEN: "s3cret" });
    expect((await fetch(`${d.url}/internal/health`)).status).toBe(200);
  });

  it("persists the registry across restarts of the same database", async () => {
    const dbPath = join(dir, "persist.db");
    const cfg = {
      dbPath,
      providers: [{ preset: "anthropic" }],
      models: [{ id: "anthropic/claude-sonnet-5", provider: "anthropic" }],
    };
    const first = await boot(cfg, { ANTHROPIC_API_KEY: "sk-test" });
    const providerId = first.repos.listProviders()[0]?.id;
    await first.stop();
    daemon = undefined;

    const second = await boot(cfg, { ANTHROPIC_API_KEY: "sk-test" });
    expect(second.repos.listProviders()).toHaveLength(1);
    expect(second.repos.listProviders()[0]?.id).toBe(providerId);
    expect(second.repos.listModels()).toHaveLength(1);
  });

  it("boots with an empty registry rather than refusing", async () => {
    // Nothing configured yet is a normal first-run state, not an error.
    const d = await boot();
    const body = (await (await fetch(`${d.url}/v1/models`)).json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1); // the orchestrator pseudo-model only
  });

  it("stop() closes both the server and the database", async () => {
    const d = await boot();
    const url = d.url;
    await d.stop();
    daemon = undefined;
    expect(d.db.$client.open).toBe(false);
    await expect(fetch(`${url}/internal/health`)).rejects.toThrow();
  });
});

describe("bootSummary", () => {
  it("reports the URL and enabled counts, and no secrets", async () => {
    const d = await boot(
      {
        providers: [{ preset: "anthropic" }],
        models: [{ id: "anthropic/claude-sonnet-5", provider: "anthropic" }],
      },
      { ANTHROPIC_API_KEY: "sk-test" },
    );
    const summary = bootSummary(d);
    expect(summary).toContain(d.url);
    expect(summary).toContain("1 provider(s)");
    expect(summary).toContain("1 model(s)");
    expect(summary).not.toContain("sk-test");
  });

  it("counts only enabled providers", async () => {
    const d = await boot({ providers: [{ preset: "anthropic" }] });
    expect(bootSummary(d)).toContain("0 provider(s)");
  });
});
