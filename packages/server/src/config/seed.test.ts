import { ModelIdSchema } from "@rewter/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { ConfigSchema, type ModelConfig, type ProviderConfig } from "./config.js";
import { SeedError, providerIdForSlug, seedRegistry } from "./seed.js";

let repos: Repos;

beforeEach(() => {
  const db = openDb(":memory:");
  const bus = new EventBus(db);
  repos = new Repos(db, bus);
});

/** Run config through the real schema so tests exercise the same defaults boot does. */
function cfg(providers: unknown[], models: unknown[] = []) {
  const parsed = ConfigSchema.parse({ providers, models });
  return {
    providers: parsed.providers as ProviderConfig[],
    models: parsed.models as ModelConfig[],
  };
}

const KEYED = { ANTHROPIC_API_KEY: "sk-test", OPENAI_API_KEY: "sk-test" };

describe("providerIdForSlug", () => {
  it("is deterministic", () => {
    expect(providerIdForSlug("anthropic")).toBe(providerIdForSlug("anthropic"));
  });

  it("differs between slugs", () => {
    expect(providerIdForSlug("anthropic")).not.toBe(providerIdForSlug("openai"));
  });

  it("stays distinct for slugs sharing a 6-char prefix", () => {
    expect(providerIdForSlug("openrouter-a")).not.toBe(providerIdForSlug("openrouter-b"));
  });

  it("produces a valid provider id for a short slug", () => {
    expect(providerIdForSlug("xai")).toMatch(/^prv_[0-9a-z]{12}$/);
  });

  it("produces a valid provider id for a slug with dashes", () => {
    expect(providerIdForSlug("github-models")).toMatch(/^prv_[0-9a-z]{12}$/);
  });

  it("keeps a readable prefix so ids are recognizable in logs", () => {
    expect(providerIdForSlug("anthropic").startsWith("prv_anthro")).toBe(true);
  });
});

describe("seedRegistry", () => {
  it("seeds a preset provider with the preset's kind, base URL and key env var", () => {
    const { providers } = seedRegistry(repos, { ...cfg([{ preset: "openai" }]), env: KEYED });
    expect(providers).toHaveLength(1);
    expect(providers[0]?.kind).toBe("openai-compat");
    expect(providers[0]?.baseUrl).toBe("https://api.openai.com/v1");
    expect(providers[0]?.apiKeyRef).toBe("OPENAI_API_KEY");
    expect(providers[0]?.enabled).toBe(true);
  });

  it("stores only the env var name, never a key value", () => {
    const { providers } = seedRegistry(repos, { ...cfg([{ preset: "openai" }]), env: KEYED });
    expect(providers[0]?.apiKeyRef).toBe("OPENAI_API_KEY");
    expect(JSON.stringify(providers[0])).not.toContain("sk-test");
  });

  it("seeds a provider disabled — not absent — when its key env var is unset", () => {
    // Disabled resolves to a 503 naming the model; absent resolves to "unknown
    // model", which sends you looking in the wrong place.
    const result = seedRegistry(repos, { ...cfg([{ preset: "anthropic" }]), env: {} });
    expect(result.providers[0]?.enabled).toBe(false);
    expect(result.missingKeys).toEqual([{ slug: "anthropic", env: "ANTHROPIC_API_KEY" }]);
  });

  it("treats an empty key env var as unset", () => {
    const result = seedRegistry(repos, {
      ...cfg([{ preset: "anthropic" }]),
      env: { ANTHROPIC_API_KEY: "" },
    });
    expect(result.providers[0]?.enabled).toBe(false);
  });

  it("enables a keyless local runtime", () => {
    const { providers, missingKeys } = seedRegistry(repos, {
      ...cfg([{ preset: "ollama" }]),
      env: {},
    });
    expect(providers[0]?.enabled).toBe(true);
    expect(missingKeys).toEqual([]);
  });

  it("honours an explicit enabled:false even with a key present", () => {
    const { providers } = seedRegistry(repos, {
      ...cfg([{ preset: "openai", enabled: false }]),
      env: KEYED,
    });
    expect(providers[0]?.enabled).toBe(false);
  });

  it("lets config override the preset base URL and key env var", () => {
    const { providers } = seedRegistry(repos, {
      ...cfg([{ preset: "vllm", baseUrl: "https://gpu.box.test/v1", apiKeyEnv: "MY_VLLM_KEY" }]),
      env: { MY_VLLM_KEY: "x" },
    });
    expect(providers[0]?.baseUrl).toBe("https://gpu.box.test/v1");
    expect(providers[0]?.apiKeyRef).toBe("MY_VLLM_KEY");
  });

  it("seeds a provider defined without a preset", () => {
    const { providers, warnings } = seedRegistry(repos, {
      ...cfg([{ slug: "homelab", kind: "openai-compat", baseUrl: "https://home.test/v1" }]),
      env: {},
    });
    expect(warnings).toEqual([]);
    expect(providers[0]?.name).toBe("homelab");
    expect(providers[0]?.kind).toBe("openai-compat");
  });

  it("warns and skips an unknown preset rather than failing the boot", () => {
    const { providers, warnings } = seedRegistry(repos, {
      ...cfg([{ preset: "nosuchvendor" }, { preset: "openai" }]),
      env: KEYED,
    });
    expect(providers).toHaveLength(1);
    expect(warnings[0]).toMatch(/nosuchvendor/);
  });

  it("throws on a duplicate provider slug", () => {
    // Two rows would collide on the deterministic id and silently overwrite.
    expect(() =>
      seedRegistry(repos, {
        ...cfg([{ preset: "openai" }, { preset: "openai", name: "second" }]),
        env: KEYED,
      }),
    ).toThrow(SeedError);
  });

  it("seeds models against their provider, deriving the upstream id from the slug", () => {
    const { models } = seedRegistry(repos, {
      ...cfg(
        [{ preset: "anthropic" }],
        [{ id: "anthropic/claude-sonnet-5", provider: "anthropic" }],
      ),
      env: KEYED,
    });
    expect(models[0]?.upstreamId).toBe("claude-sonnet-5");
    expect(models[0]?.providerId).toBe(providerIdForSlug("anthropic"));
    expect(models[0]?.source).toBe("manual");
  });

  it("respects an explicit upstreamId that differs from the slug", () => {
    const { models } = seedRegistry(repos, {
      ...cfg(
        [{ preset: "openrouter" }],
        [
          {
            id: "openrouter/sonnet",
            provider: "openrouter",
            upstreamId: "anthropic/claude-sonnet-5",
          },
        ],
      ),
      env: { OPENROUTER_API_KEY: "x" },
    });
    expect(models[0]?.upstreamId).toBe("anthropic/claude-sonnet-5");
  });

  it("leaves unspecified prices null, so an unpriced model is not billed as free", () => {
    const { models } = seedRegistry(repos, {
      ...cfg([{ preset: "anthropic" }], [{ id: "anthropic/x", provider: "anthropic" }]),
      env: KEYED,
    });
    expect(models[0]?.pricing).toEqual({
      inputPerMTok: null,
      outputPerMTok: null,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    });
  });

  it("carries configured prices through", () => {
    const { models } = seedRegistry(repos, {
      ...cfg(
        [{ preset: "anthropic" }],
        [
          {
            id: "anthropic/x",
            provider: "anthropic",
            pricing: { inputPerMTok: 3, outputPerMTok: 15 },
          },
        ],
      ),
      env: KEYED,
    });
    expect(models[0]?.pricing.inputPerMTok).toBe(3);
    expect(models[0]?.pricing.cacheReadPerMTok).toBeNull();
  });

  it("warns and skips a model naming a provider that was not seeded", () => {
    const { models, warnings } = seedRegistry(repos, {
      ...cfg([{ preset: "anthropic" }], [{ id: "ghost/x", provider: "ghost" }]),
      env: KEYED,
    });
    expect(models).toEqual([]);
    expect(warnings[0]).toMatch(/unknown provider "ghost"/);
  });

  it("is idempotent: re-seeding keeps ids and createdAt stable", () => {
    const input = {
      ...cfg([{ preset: "anthropic" }], [{ id: "anthropic/x", provider: "anthropic" }]),
      env: KEYED,
    };
    const first = seedRegistry(repos, { ...input, clock: () => 1000 });
    const second = seedRegistry(repos, { ...input, clock: () => 2000 });

    expect(second.providers[0]?.id).toBe(first.providers[0]?.id);
    expect(repos.listProviders()).toHaveLength(1);
    expect(repos.listModels()).toHaveLength(1);
    // createdAt survives a restart; updatedAt records the re-seed.
    expect(second.providers[0]?.createdAt).toBe(1000);
    expect(second.providers[0]?.updatedAt).toBe(2000);
    expect(second.models[0]?.createdAt).toBe(1000);
  });

  it("a re-seed that flips a provider off does not orphan its models", () => {
    const providers = [{ preset: "anthropic" }];
    const models = [{ id: "anthropic/x", provider: "anthropic" }];
    seedRegistry(repos, { ...cfg(providers, models), env: KEYED });
    // Key removed from the environment — same rows, now disabled.
    seedRegistry(repos, { ...cfg(providers, models), env: {} });

    const model = repos.getModel(ModelIdSchema.parse("anthropic/x"));
    expect(model).toBeDefined();
    expect(repos.getProvider(model?.providerId ?? "")?.enabled).toBe(false);
  });
});
