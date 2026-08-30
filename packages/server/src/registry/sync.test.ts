/**
 * Sync policy. Parsing is `catalog.test.ts`'s job; these are about what sync is
 * *allowed to do* to a registry that a human has already touched — which is the
 * part that, done wrong, silently reverts someone's corrected pricing or
 * vaporizes a model that cost records still point at.
 */
import type { Model, Provider } from "@rewter/shared";
import { ModelIdSchema } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { providerIdForSlug } from "../providers/presets.js";
import { formatSyncReport, syncModels } from "./sync.js";

const PRV = providerIdForSlug("openai");

/**
 * Providers carry their preset's real id, because that is what sync inverts to
 * recover the slug — a display name is not a reliable slug source.
 */
function provider(slug: string, over: Partial<Provider> = {}): Provider {
  return {
    id: providerIdForSlug(slug),
    name: slug,
    kind: "openai-compat",
    baseUrl: null,
    apiKeyRef: "OPENAI_API_KEY",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function model(id: string, over: Partial<Model> = {}): Model {
  return {
    id: ModelIdSchema.parse(id),
    providerId: PRV,
    upstreamId: id.slice(id.indexOf("/") + 1),
    displayName: id,
    contextWindow: null,
    maxOutputTokens: null,
    pricing: {
      inputPerMTok: null,
      outputPerMTok: null,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    },
    modalities: ["text"],
    // Matches what the thin OpenAI-compatible catalog reports, so a re-sync of
    // an unchanged model produces no diff.
    supports: { tools: null, streaming: true, vision: null, caching: null },
    source: "synced",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/** In-memory stand-in for the model repo. */
function registry(seed: Model[] = []) {
  const rows = new Map<string, Model>(seed.map((m) => [m.id, m]));
  return {
    rows,
    upsertModel(m: Model) {
      rows.set(m.id, m);
      return m;
    },
    getModel(id: string) {
      return rows.get(id);
    },
    listModels(opts?: { providerId?: string }) {
      return [...rows.values()].filter(
        (m) => opts?.providerId === undefined || m.providerId === opts.providerId,
      );
    },
  };
}

function jsonFetch(body: unknown, status = 200): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof globalThis.fetch;
}

/** Answers per host so one sync can hit OpenRouter and a thin upstream both. */
function routedFetch(byHost: Record<string, unknown>): typeof globalThis.fetch {
  return (async (url: string | URL) => {
    const host = new URL(String(url)).host;
    const body = byHost[host];
    if (body === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

const ENV = { OPENAI_API_KEY: "sk-test", OPENROUTER_API_KEY: "sk-or" };
const OPENAI_LIST = { data: [{ id: "gpt-5" }, { id: "gpt-4o" }] };

describe("syncModels — adding", () => {
  it("creates missing models, disabled, so a 400-row catalog is not opt-out", async () => {
    const target = registry();
    const report = await syncModels(target, [provider("openai")], {
      env: ENV,
      fetch: jsonFetch(OPENAI_LIST),
      clock: () => 100,
    });
    expect(report.providers[0]?.added).toEqual(["openai/gpt-4o", "openai/gpt-5"]);
    expect(target.getModel("openai/gpt-5")?.enabled).toBe(false);
    expect(target.getModel("openai/gpt-5")?.source).toBe("synced");
  });

  it("writes nothing on a dry run but reports the same work", async () => {
    const target = registry();
    const report = await syncModels(target, [provider("openai")], {
      env: ENV,
      fetch: jsonFetch(OPENAI_LIST),
      dryRun: true,
    });
    expect(report.providers[0]?.added).toHaveLength(2);
    expect(target.rows.size).toBe(0);
    expect(report.dryRun).toBe(true);
  });

  it("skips providers that are disabled or publish no catalog", async () => {
    const target = registry();
    const report = await syncModels(
      target,
      [provider("openai", { enabled: false }), provider("zai")],
      { env: ENV, fetch: jsonFetch(OPENAI_LIST) },
    );
    // Z.AI's preset has listModels: false; OpenAI is switched off.
    expect(report.providers).toEqual([]);
  });

  it("counts an upstream id our slug format cannot express as malformed", async () => {
    const target = registry();
    const report = await syncModels(target, [provider("openai")], {
      env: ENV,
      fetch: jsonFetch({ data: [{ id: "gpt-5" }, { id: "has space" }] }),
    });
    expect(report.providers[0]?.added).toEqual(["openai/gpt-5"]);
    expect(report.providers[0]?.malformed).toBe(1);
  });
});

describe("syncModels — updating", () => {
  it("refreshes a synced row's facts", async () => {
    const target = registry([model("openai/gpt-5", { displayName: "stale" })]);
    const report = await syncModels(target, [provider("openai")], {
      env: ENV,
      fetch: jsonFetch({ data: [{ id: "gpt-5" }] }),
      clock: () => 500,
    });
    expect(report.providers[0]?.updated).toEqual(["openai/gpt-5"]);
    expect(target.getModel("openai/gpt-5")?.displayName).toBe("gpt-5");
    expect(target.getModel("openai/gpt-5")?.updatedAt).toBe(500);
  });

  it("does not claim an update when nothing about the model changed", async () => {
    // displayName matches what the thin catalog reports, so there is no diff.
    const target = registry([model("openai/gpt-5", { displayName: "gpt-5" })]);
    const report = await syncModels(target, [provider("openai")], {
      env: ENV,
      fetch: jsonFetch({ data: [{ id: "gpt-5" }] }),
      clock: () => 500,
    });
    expect(report.providers[0]?.updated).toEqual([]);
    // …and the row is untouched, not rewritten with a new timestamp.
    expect(target.getModel("openai/gpt-5")?.updatedAt).toBe(1);
  });

  it("never flips a synced model's enabled switch back on", async () => {
    const target = registry([model("openai/gpt-5", { enabled: false, displayName: "stale" })]);
    await syncModels(target, [provider("openai")], {
      env: ENV,
      fetch: jsonFetch({ data: [{ id: "gpt-5" }] }),
    });
    expect(target.getModel("openai/gpt-5")?.enabled).toBe(false);
  });
});

describe("syncModels — a human owns the row", () => {
  // Namespaced under the provider being synced, or sync would look up
  // `openrouter/gpt-5`, find nothing, and create a second row instead.
  const manual = model("openrouter/gpt-5", {
    providerId: providerIdForSlug("openrouter"),
    source: "manual",
    displayName: "GPT-5 (my name for it)",
    contextWindow: 400_000,
    pricing: {
      inputPerMTok: 1.25,
      outputPerMTok: null,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    },
  });

  const RICH = {
    data: [
      {
        id: "gpt-5",
        name: "OpenAI: GPT-5",
        context_length: 128_000,
        pricing: { prompt: "0.000002", completion: "0.00001" },
      },
    ],
  };

  it("leaves the stated price and name alone — the human's number is the correction", async () => {
    const target = registry([manual]);
    await syncModels(target, [provider("openrouter", { apiKeyRef: "OPENROUTER_API_KEY" })], {
      env: ENV,
      fetch: jsonFetch(RICH),
    });
    const row = target.getModel("openrouter/gpt-5");
    expect(row?.pricing.inputPerMTok).toBe(1.25);
    expect(row?.displayName).toBe("GPT-5 (my name for it)");
    expect(row?.contextWindow).toBe(400_000);
  });

  it("still fills the gaps the human left null", async () => {
    const target = registry([manual]);
    const report = await syncModels(
      target,
      [provider("openrouter", { apiKeyRef: "OPENROUTER_API_KEY" })],
      { env: ENV, fetch: jsonFetch(RICH) },
    );
    expect(target.getModel("openrouter/gpt-5")?.pricing.outputPerMTok).toBe(10);
    expect(report.providers[0]?.updated).toEqual(["openrouter/gpt-5"]);
  });

  it("reports a manual row as skipped when there is nothing left to fill", async () => {
    const complete = {
      ...manual,
      pricing: {
        inputPerMTok: 1.25,
        outputPerMTok: 9,
        cacheReadPerMTok: 0.1,
        cacheWritePerMTok: 0.2,
      },
      maxOutputTokens: 8192,
    };
    const target = registry([complete]);
    const report = await syncModels(
      target,
      [provider("openrouter", { apiKeyRef: "OPENROUTER_API_KEY" })],
      { env: ENV, fetch: jsonFetch(RICH) },
    );
    expect(report.providers[0]?.skippedManual).toEqual(["openrouter/gpt-5"]);
    expect(target.getModel("openrouter/gpt-5")?.pricing.outputPerMTok).toBe(9);
  });
});

describe("syncModels — disappearing models", () => {
  it("disables rather than deletes, so history keeps its referent", async () => {
    const target = registry([model("openai/gpt-5"), model("openai/gpt-4-turbo")]);
    const report = await syncModels(target, [provider("openai")], {
      env: ENV,
      fetch: jsonFetch({ data: [{ id: "gpt-5" }] }),
      clock: () => 900,
    });
    expect(report.providers[0]?.disappeared).toEqual(["openai/gpt-4-turbo"]);
    const gone = target.getModel("openai/gpt-4-turbo");
    expect(gone).toBeDefined();
    expect(gone?.enabled).toBe(false);
  });

  it("does not disable a model a human added by hand", async () => {
    const target = registry([model("openai/my-finetune", { source: "manual" })]);
    const report = await syncModels(target, [provider("openai")], {
      env: ENV,
      fetch: jsonFetch({ data: [{ id: "gpt-5" }] }),
    });
    expect(report.providers[0]?.disappeared).toEqual([]);
    expect(target.getModel("openai/my-finetune")?.enabled).toBe(true);
  });
});

describe("syncModels — enrichment and failure", () => {
  const OR_BODY = {
    data: [
      {
        id: "openai/gpt-5",
        name: "OpenAI: GPT-5",
        context_length: 400_000,
        pricing: { prompt: "0.00000125", completion: "0.00001" },
      },
    ],
  };

  it("fills a thin catalog's prices from OpenRouter's", async () => {
    const target = registry();
    const report = await syncModels(
      target,
      [
        provider("openai", { baseUrl: "https://api.openai.com/v1" }),
        provider("openrouter", {
          apiKeyRef: "OPENROUTER_API_KEY",
          baseUrl: "https://openrouter.ai/api/v1",
        }),
      ],
      {
        env: ENV,
        enrich: true,
        fetch: routedFetch({
          "api.openai.com": { data: [{ id: "gpt-5" }] },
          "openrouter.ai": OR_BODY,
        }),
      },
    );
    expect(report.enrichedFromOpenRouter).toBe(true);
    expect(target.getModel("openai/gpt-5")?.pricing.inputPerMTok).toBe(1.25);
    expect(target.getModel("openai/gpt-5")?.contextWindow).toBe(400_000);
  });

  it("degrades to an unenriched sync when OpenRouter itself fails", async () => {
    const target = registry();
    const report = await syncModels(
      target,
      [
        provider("openai", { baseUrl: "https://api.openai.com/v1" }),
        provider("openrouter", {
          apiKeyRef: "OPENROUTER_API_KEY",
          baseUrl: "https://openrouter.ai/api/v1",
        }),
      ],
      {
        env: ENV,
        enrich: true,
        // OpenRouter 404s; the rest of the sync must still happen.
        fetch: routedFetch({ "api.openai.com": { data: [{ id: "gpt-5" }] } }),
      },
    );
    expect(report.enrichedFromOpenRouter).toBe(false);
    expect(target.getModel("openai/gpt-5")).toBeDefined();
    expect(target.getModel("openai/gpt-5")?.pricing.inputPerMTok).toBeNull();
  });

  it("records a failing provider and syncs the rest anyway", async () => {
    const target = registry();
    const report = await syncModels(
      target,
      [
        provider("openai", { baseUrl: "https://api.openai.com/v1" }),
        provider("groq", { baseUrl: "https://api.groq.com/openai/v1" }),
      ],
      { env: ENV, fetch: routedFetch({ "api.openai.com": { data: [{ id: "gpt-5" }] } }) },
    );
    expect(report.providers[0]?.added).toEqual(["openai/gpt-5"]);
    expect(report.providers[1]?.error).toContain("404");
  });
});

describe("formatSyncReport", () => {
  it("names the provider that failed instead of swallowing it", () => {
    const line = formatSyncReport({
      dryRun: false,
      enrichedFromOpenRouter: false,
      providers: [
        {
          slug: "groq",
          added: [],
          updated: [],
          disappeared: [],
          skippedManual: [],
          malformed: 0,
          error: "HTTP 429",
        },
      ],
    });
    expect(line).toBe("groq: failed — HTTP 429");
  });

  it("says how to turn the new models on, since they arrive off", () => {
    const out = formatSyncReport({
      dryRun: false,
      enrichedFromOpenRouter: true,
      providers: [
        {
          slug: "openai",
          added: ["openai/gpt-5"],
          updated: [],
          disappeared: [],
          skippedManual: [],
          malformed: 0,
        },
      ],
    });
    expect(out).toContain("1 added");
    expect(out).toContain("New models arrive disabled");
  });
});
