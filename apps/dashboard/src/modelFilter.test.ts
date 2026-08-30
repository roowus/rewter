/**
 * The filter's rules, away from the DOM.
 *
 * The two that matter are the ones a naive implementation gets wrong: matching
 * the full id rather than the shortened one (otherwise two providers' copies of
 * the same model are indistinguishable), and matching card tags (otherwise the
 * registry cannot answer the question it exists to answer).
 */
import type { CapabilityCard, Model } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { emptyFilter, filterModels, isUnfiltered } from "./modelFilter.js";

const model = (over: Record<string, unknown> = {}): Model =>
  ({
    id: "anthropic/claude-sonnet-5",
    providerId: "prv_aaaaaaaaaaaa",
    upstreamId: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    },
    modalities: ["text"],
    supports: { tools: true, streaming: true, vision: false, caching: true },
    source: "synced",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as Model;

const card = (modelId: string, bestAt: string[]): CapabilityCard =>
  ({
    modelId,
    summary: "",
    strengths: [],
    weaknesses: [],
    bestAt,
    notes: null,
    userOverrides: null,
    generatedBy: null,
    generatedAt: null,
    updatedAt: 1,
  }) as unknown as CapabilityCard;

const ids = (models: Model[]): string[] => models.map((m) => m.id);
const noCards = new Map<string, CapabilityCard>();

describe("filterModels", () => {
  it("returns everything under an empty filter", () => {
    const all = [model(), model({ id: "ollama/qwen3-4b" })];
    expect(filterModels(all, noCards, emptyFilter())).toHaveLength(2);
    expect(isUnfiltered(emptyFilter())).toBe(true);
  });

  it("matches the provider half of the id, which the table does not show", () => {
    // The whole point: both of these render as `glm-5.3` in the table, so the
    // provider prefix is the only thing that can tell them apart.
    const all = [model({ id: "zai/glm-5.3" }), model({ id: "9router/glm/glm-5.3" })];
    const found = filterModels(all, noCards, { ...emptyFilter(), query: "9router" });
    expect(ids(found)).toEqual(["9router/glm/glm-5.3"]);
  });

  it("matches a card's bestAt tags", () => {
    // "which of my models is good at OCR" is the question the registry is for.
    const vision = model({ id: "google/gemini-3-flash" });
    const all = [model(), vision];
    const cards = new Map([[vision.id, card(vision.id, ["ocr", "vision"])]]);
    const found = filterModels(all, cards, { ...emptyFilter(), query: "ocr" });
    expect(ids(found)).toEqual(["google/gemini-3-flash"]);
  });

  it("matches the display name too, case-insensitively", () => {
    const found = filterModels([model()], noCards, { ...emptyFilter(), query: "SONNET" });
    expect(found).toHaveLength(1);
  });

  it("narrows to one provider", () => {
    const all = [model(), model({ id: "ollama/qwen3-4b", providerId: "prv_bbbbbbbbbbbb" })];
    const found = filterModels(all, noCards, { ...emptyFilter(), providerId: "prv_bbbbbbbbbbbb" });
    expect(ids(found)).toEqual(["ollama/qwen3-4b"]);
  });

  it("separates disabled models from enabled ones", () => {
    const all = [model(), model({ id: "ollama/qwen3-4b", enabled: false })];
    expect(ids(filterModels(all, noCards, { ...emptyFilter(), enabled: "off" }))).toEqual([
      "ollama/qwen3-4b",
    ]);
    expect(ids(filterModels(all, noCards, { ...emptyFilter(), enabled: "on" }))).toEqual([
      "anthropic/claude-sonnet-5",
    ]);
  });

  it("combines the three independently", () => {
    const all = [
      model({ id: "9router/glm/glm-5.3", providerId: "prv_9" }),
      model({ id: "9router/glm/glm-4.6", providerId: "prv_9", enabled: false }),
      model({ id: "zai/glm-5.3", providerId: "prv_z" }),
    ];
    const found = filterModels(all, noCards, {
      query: "glm",
      providerId: "prv_9",
      enabled: "on",
    });
    expect(ids(found)).toEqual(["9router/glm/glm-5.3"]);
  });

  it("keeps the daemon's order rather than ranking by relevance", () => {
    // A row that jumps to the top mid-keystroke moves the Edit button out from
    // under the pointer.
    const all = [
      model({ id: "a/zzz-glm" }),
      model({ id: "b/glm-exact" }),
      model({ id: "c/mid-glm-mid" }),
    ];
    const found = filterModels(all, noCards, { ...emptyFilter(), query: "glm" });
    expect(ids(found)).toEqual(["a/zzz-glm", "b/glm-exact", "c/mid-glm-mid"]);
  });

  it("finds nothing rather than everything when the query matches no row", () => {
    // The failure that would hide a typo: a filter that falls back to "show all"
    // reads as "you have these models", which is the opposite of the truth.
    expect(filterModels([model()], noCards, { ...emptyFilter(), query: "nope" })).toEqual([]);
  });
});
