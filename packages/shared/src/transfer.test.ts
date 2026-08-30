/**
 * The import planner, and the promise the bundle format makes.
 *
 * Two claims carry the file. The first is structural: an export cannot contain
 * a credential, and the test for it is not "we remembered to omit apiKeyRef"
 * but that the schema *rejects* one — so a future field on Provider cannot ride
 * out on a spread. The second is behavioural: an import merges the way sync
 * merges. It never overwrites a human unless asked, and it never deletes.
 */
import { describe, expect, it } from "vitest";
import type { CapabilityCard, Model, Provider } from "./entities.js";
import { ModelIdSchema, ProviderIdSchema } from "./ids.js";
import {
  BundleProviderSchema,
  type RegistryBundle,
  RegistryBundleSchema,
  RegistryImportRequestSchema,
  buildBundle,
  planImport,
  summarizeDecisions,
} from "./transfer.js";

const NOW = 1_756_252_800_000;
const PRV = ProviderIdSchema.parse("prv_aaaaaaaaaaaa");
const OTHER = ProviderIdSchema.parse("prv_bbbbbbbbbbbb");

function provider(over: Partial<Provider> = {}): Provider {
  return {
    id: PRV,
    name: "Anthropic",
    kind: "anthropic",
    baseUrl: null,
    apiKeyRef: "ANTHROPIC_API_KEY",
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as Provider;
}

function model(over: Partial<Model> = {}): Model {
  return {
    id: "anthropic/claude-sonnet-5",
    providerId: PRV,
    upstreamId: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    },
    modalities: ["text", "image"],
    supports: { tools: true, streaming: true, vision: true, caching: true },
    source: "synced",
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as Model;
}

function card(over: Partial<CapabilityCard> = {}): CapabilityCard {
  return {
    modelId: "anthropic/claude-sonnet-5",
    summary: "Balanced generalist.",
    strengths: ["coding", "reasoning"],
    weaknesses: [],
    bestAt: ["coding"],
    notes: null,
    userOverrides: null,
    generatedBy: null,
    generatedAt: NOW,
    updatedAt: NOW,
    ...over,
  } as CapabilityCard;
}

const bundle = (over: Partial<RegistryBundle> = {}): RegistryBundle =>
  RegistryBundleSchema.parse({
    version: 1,
    exportedAt: NOW,
    note: null,
    providers: [{ id: PRV, name: "Anthropic", kind: "anthropic", baseUrl: null }],
    models: [model()],
    cards: [card()],
    ...over,
  });

const local = (over: Partial<Parameters<typeof planImport>[1]> = {}) => ({
  models: [] as Model[],
  cards: [] as CapabilityCard[],
  providers: [{ id: PRV }],
  ...over,
});

describe("the bundle format", () => {
  it("has no field a key could travel in, even a mistyped one", () => {
    // The whole credential promise in one assertion. `.strict()` means a
    // provider entry that grew an `apiKeyRef` — by a future spread, or by
    // someone hand-editing a file — fails to parse rather than being carried.
    const withKey = { id: PRV, name: "A", kind: "anthropic", baseUrl: null, apiKeyRef: "K" };
    expect(BundleProviderSchema.safeParse(withKey).success).toBe(false);
  });

  it("exports providers by naming their fields, not by subtracting from the row", () => {
    const out = buildBundle(
      { providers: [provider()], models: [model()], cards: [card()] },
      { now: NOW },
    );
    // The source row had a key reference and lifecycle columns; none survive.
    expect(out.providers[0]).toEqual({
      id: PRV,
      name: "Anthropic",
      kind: "anthropic",
      baseUrl: null,
    });
    expect(JSON.stringify(out)).not.toContain("ANTHROPIC_API_KEY");
  });

  it("carries only providers something in the export refers to", () => {
    // A provider with nothing in the registry is this machine's setup, not
    // part of what is being described.
    const out = buildBundle(
      {
        providers: [provider(), provider({ id: OTHER, name: "OpenAI", kind: "openai-compat" })],
        models: [model()],
        cards: [],
      },
      { now: NOW },
    );
    expect(out.providers.map((p) => p.id)).toEqual([PRV]);
  });

  it("refuses a version it does not know rather than parsing what it recognises", () => {
    // A bundle from a future rewter whose fields moved would import as a pile
    // of silent defaults; the failure would then surface as a model that
    // routes wrong, which is much further from the cause.
    expect(RegistryBundleSchema.safeParse({ ...bundle(), version: 2 }).success).toBe(false);
  });

  it("defaults an import to the cautious half of the merge rule", () => {
    const parsed = RegistryImportRequestSchema.parse({ bundle: bundle() });
    expect(parsed.onConflict).toBe("skip");
    expect(parsed.dryRun).toBe(false);
  });
});

describe("planImport", () => {
  it("adds what is not here", () => {
    const plan = planImport(bundle(), local(), "skip");
    expect(plan.models).toEqual([
      { id: "anthropic/claude-sonnet-5", outcome: "added", reason: null },
    ]);
    expect(plan.cards[0]?.outcome).toBe("added");
  });

  it("leaves an existing model alone by default, and says how to mean otherwise", () => {
    // Rule 1. Running the same import twice must not be able to destroy work
    // done between the two runs.
    const plan = planImport(
      bundle(),
      local({ models: [model({ pricing: { ...model().pricing, inputPerMTok: 2 } })] }),
      "skip",
    );
    expect(plan.models[0]?.outcome).toBe("exists");
    expect(plan.models[0]?.reason).toContain("overwrite");
  });

  it("replaces only when overwrite was asked for", () => {
    const plan = planImport(bundle(), local({ models: [model()] }), "overwrite");
    expect(plan.models[0]?.outcome).toBe("replaced");
  });

  it("never mentions a local model the bundle has not heard of", () => {
    // Rule 2, stated as an absence: nothing in the plan can remove it, because
    // the plan only ever has opinions about rows the bundle contains.
    const plan = planImport(
      bundle(),
      local({ models: [model(), model({ id: ModelIdSchema.parse("local/mine") })] }),
      "overwrite",
    );
    expect(plan.models.map((d) => d.id)).toEqual(["anthropic/claude-sonnet-5"]);
  });

  it("skips a model whose provider is not configured here, and names the provider", () => {
    // Not "create the provider": a half-configured upstream with no key fails
    // later, further away, as a 503 from inside a task.
    const plan = planImport(bundle(), local({ providers: [] }), "skip");
    expect(plan.models[0]?.outcome).toBe("no_provider");
    expect(plan.models[0]?.reason).toContain("Anthropic");
  });

  it("groups missing providers with a count, rather than repeating the line", () => {
    const b = bundle({
      models: [model(), model({ id: ModelIdSchema.parse("anthropic/claude-opus-5") })],
      cards: [],
    });
    const plan = planImport(b, local({ providers: [] }), "skip");
    expect(plan.missingProviders).toEqual([{ id: PRV, name: "Anthropic", modelCount: 2 }]);
  });

  it("names an unconfigured provider even when the bundle forgot to describe it", () => {
    const b = bundle({ providers: [], cards: [] });
    const plan = planImport(b, local({ providers: [] }), "skip");
    expect(plan.missingProviders[0]?.name).toBe(PRV);
  });

  it("lands a card on a model arriving in the same bundle", () => {
    // Order within the file must not decide the outcome: the card's model is
    // being added by this very import.
    const plan = planImport(bundle(), local(), "skip");
    expect(plan.cards[0]?.outcome).toBe("added");
  });

  it("lands a card on a model that is here but was left alone", () => {
    // `exists` still means the model is present, and a machine with the model
    // but not its card is where importing the card is pure gain.
    const plan = planImport(bundle(), local({ models: [model()] }), "skip");
    expect(plan.models[0]?.outcome).toBe("exists");
    expect(plan.cards[0]?.outcome).toBe("added");
  });

  it("drops a card whose model was skipped for a missing provider", () => {
    // The model did not land, so there is nothing for the card to describe.
    const plan = planImport(bundle(), local({ providers: [] }), "skip");
    expect(plan.cards[0]?.outcome).toBe("no_model");
  });

  it("keeps a local card unless overwrite was asked for", () => {
    const plan = planImport(bundle(), local({ models: [model()], cards: [card()] }), "skip");
    expect(plan.cards[0]?.outcome).toBe("exists");
    expect(
      planImport(bundle(), local({ models: [model()], cards: [card()] }), "overwrite").cards[0]
        ?.outcome,
    ).toBe("replaced");
  });
});

describe("summarizeDecisions", () => {
  it("counts by outcome in a fixed order", () => {
    const line = summarizeDecisions([
      { id: "a", outcome: "exists", reason: null },
      { id: "b", outcome: "added", reason: null },
      { id: "c", outcome: "added", reason: null },
    ]);
    expect(line).toBe("2 added, 1 already here");
  });

  it("says so when an import did nothing at all", () => {
    expect(summarizeDecisions([])).toBe("nothing");
  });
});
