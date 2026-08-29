/**
 * The registry-edit rules.
 *
 * Almost all of these are about one decision: when a hand edit takes a row off
 * the sync path. Getting it wrong in either direction is quiet. Too eager and
 * every model drifts to `manual` on the first Save, so `sync-models` stops
 * refreshing prices and nobody notices until a provider's price change never
 * arrives. Too shy and the correction survives exactly until the next sync,
 * which is worse, because the number was right when the user checked it.
 */
import { describe, expect, it } from "vitest";
import type { Model } from "./entities.js";
import {
  CardOverridesSchema,
  ModelCreateSchema,
  ModelPatchSchema,
  applyModelPatch,
  promotesToManual,
} from "./registry.js";

const NOW = 1_756_252_800_000;
const LATER = NOW + 60_000;

function model(over: Partial<Model> = {}): Model {
  return {
    id: "anthropic/claude-sonnet-5",
    providerId: "prv_aaaaaaaaaaaa",
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

describe("applyModelPatch", () => {
  it("promotes a synced row to manual when a fact changes", () => {
    // The reason the editor exists: a corrected price that sync would put back
    // is not a correction, it is a countdown.
    const next = applyModelPatch(
      model(),
      { pricing: { ...model().pricing, inputPerMTok: 2.5 } },
      LATER,
    );
    expect(next?.source).toBe("manual");
    expect(next?.pricing.inputPerMTok).toBe(2.5);
    expect(next?.updatedAt).toBe(LATER);
  });

  it("does not promote when the value is unchanged", () => {
    // A form that POSTs every field on every save must not promote a row
    // because someone opened it and pressed Save.
    const existing = model();
    expect(
      promotesToManual(existing, { pricing: existing.pricing, displayName: existing.displayName }),
    ).toBe(false);
    expect(applyModelPatch(existing, { displayName: existing.displayName }, LATER)).toBeUndefined();
  });

  it("treats enabling and disabling as the user's switch, not a fact", () => {
    // sync already never flips `enabled`. Turning a model off should not
    // silently take its prices off the sync path forever.
    const next = applyModelPatch(model(), { enabled: false }, LATER);
    expect(next?.enabled).toBe(false);
    expect(next?.source).toBe("synced");
  });

  it("leaves an already-manual row manual", () => {
    const next = applyModelPatch(model({ source: "manual" }), { enabled: false }, LATER);
    expect(next?.source).toBe("manual");
  });

  it("returns undefined for a patch that changes nothing", () => {
    // Same rule as sync's mergeModel: bumping updatedAt for a no-op save makes
    // the row claim an edit that never happened.
    expect(applyModelPatch(model(), {}, LATER)).toBeUndefined();
    expect(applyModelPatch(model(), { enabled: true }, LATER)).toBeUndefined();
  });

  it("compares pricing structurally, not by identity", () => {
    const existing = model();
    const identical = { ...existing.pricing };
    expect(promotesToManual(existing, { pricing: identical })).toBe(false);
    expect(promotesToManual(existing, { pricing: { ...identical, cacheReadPerMTok: 0.31 } })).toBe(
      true,
    );
  });

  it("counts a null as a real change — clearing a price is an edit", () => {
    // "We do not know this price" is a different claim than "$3/MTok", and the
    // cost report reads them differently.
    const next = applyModelPatch(model(), { contextWindow: null }, LATER);
    expect(next?.contextWindow).toBeNull();
    expect(next?.source).toBe("manual");
  });

  it("keeps createdAt — an edit is not a new row", () => {
    const next = applyModelPatch(model(), { displayName: "Sonnet" }, LATER);
    expect(next?.createdAt).toBe(NOW);
  });
});

describe("ModelPatchSchema", () => {
  it("rejects an unknown field rather than ignoring it", () => {
    // The failure that looks like success: 200, row unchanged, user believes
    // the price is fixed.
    expect(ModelPatchSchema.safeParse({ pricing_input: 2 }).success).toBe(false);
    expect(ModelPatchSchema.safeParse({ source: "manual" }).success).toBe(false);
  });

  it("rejects a negative price and a zero context window", () => {
    expect(
      ModelPatchSchema.safeParse({
        pricing: {
          inputPerMTok: -1,
          outputPerMTok: 1,
          cacheReadPerMTok: null,
          cacheWritePerMTok: null,
        },
      }).success,
    ).toBe(false);
    expect(ModelPatchSchema.safeParse({ contextWindow: 0 }).success).toBe(false);
  });

  it("requires all four pricing fields, so a partial price cannot half-apply", () => {
    expect(ModelPatchSchema.safeParse({ pricing: { inputPerMTok: 2 } }).success).toBe(false);
  });

  it("accepts an empty patch — the route decides that means no-op", () => {
    expect(ModelPatchSchema.safeParse({}).success).toBe(true);
  });
});

describe("ModelCreateSchema", () => {
  it("defaults a hand-typed model to text-only, unpriced, enabled", () => {
    const parsed = ModelCreateSchema.parse({
      id: "ollama/qwen3-coder",
      providerId: "prv_aaaaaaaaaaaa",
      upstreamId: "qwen3-coder",
      displayName: "Qwen3 Coder",
    });
    expect(parsed.pricing).toEqual({
      inputPerMTok: null,
      outputPerMTok: null,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    });
    expect(parsed.modalities).toEqual(["text"]);
    expect(parsed.enabled).toBe(true);
  });

  it("has no source field — a typed row is manual by construction", () => {
    // Accepting `source: "synced"` would hand sync permission to overwrite a
    // row nothing upstream has ever heard of.
    expect(
      ModelCreateSchema.safeParse({
        id: "ollama/x",
        providerId: "prv_aaaaaaaaaaaa",
        upstreamId: "x",
        displayName: "X",
        source: "synced",
      }).success,
    ).toBe(false);
  });

  it("rejects a model id that is not a slug", () => {
    expect(
      ModelCreateSchema.safeParse({
        id: "has spaces",
        providerId: "prv_aaaaaaaaaaaa",
        upstreamId: "x",
        displayName: "X",
      }).success,
    ).toBe(false);
  });
});

describe("CardOverridesSchema", () => {
  it("rejects a tag outside the fixed vocabulary", () => {
    // The vocabulary doubles as the phase-2 stats key; a freehand tag would
    // join to nothing.
    expect(CardOverridesSchema.safeParse({ bestAt: ["vibes"] }).success).toBe(false);
    expect(CardOverridesSchema.safeParse({ bestAt: ["coding", "ocr"] }).success).toBe(true);
  });

  it("refuses to rewrite provenance out loud", () => {
    // mergeCardOverrides drops these silently, which is right in the DB and
    // wrong at the boundary — a caller that tried should hear about it.
    expect(CardOverridesSchema.safeParse({ generatedBy: "anthropic/x" }).success).toBe(false);
    expect(CardOverridesSchema.safeParse({ modelId: "anthropic/x" }).success).toBe(false);
  });
});
