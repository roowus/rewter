/**
 * The filter's rules, away from the DOM.
 *
 * The two that matter are the ones a naive implementation gets wrong: matching
 * the full id rather than the shortened one (otherwise two providers' copies of
 * the same model are indistinguishable), and matching card tags (otherwise the
 * registry cannot answer the question it exists to answer).
 */
import type { CapabilityCard, Model, Provider } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import {
  countCategories,
  emptyFilter,
  filterModels,
  isUnfiltered,
  localProviderIds,
} from "./modelFilter.js";

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
/** The one keyless provider these fixtures use. */
const local = new Set(["prv_local"]);

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

  it("combines the axes independently", () => {
    const all = [
      model({ id: "9router/glm/glm-5.3", providerId: "prv_9" }),
      model({ id: "9router/glm/glm-4.6", providerId: "prv_9", enabled: false }),
      model({ id: "zai/glm-5.3", providerId: "prv_z" }),
    ];
    const found = filterModels(all, noCards, {
      ...emptyFilter(),
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

  it("narrows to one category", () => {
    const all = [model(), model({ id: "ollama/qwen3-4b", providerId: "prv_local" })];
    const found = filterModels(all, noCards, { ...emptyFilter(), category: "local" }, local);
    expect(ids(found)).toEqual(["ollama/qwen3-4b"]);
  });

  it("cannot call anything local when it does not know which providers are", () => {
    // The default: `filterModels` without the set is the old three-axis
    // behaviour, and must not guess `local` from a model id that starts
    // "ollama/" — a proxied Ollama through a hosted aggregator still bills.
    const all = [model({ id: "ollama/qwen3-4b", providerId: "prv_local" })];
    expect(filterModels(all, noCards, { ...emptyFilter(), category: "local" })).toEqual([]);
  });
});

/**
 * The categories, which are the part a reader is trusting at a glance.
 *
 * The distinction worth defending in a test is free-vs-unpriced: both would
 * render as `$0` and they mean opposite things.
 */
describe("categories", () => {
  const unpriced = {
    inputPerMTok: null,
    outputPerMTok: null,
    cacheReadPerMTok: null,
    cacheWritePerMTok: null,
  };

  it("reads local off the absence of a key, not off the model id", () => {
    const providers = [
      { id: "prv_local", apiKeyRef: null } as Provider,
      { id: "prv_aaaaaaaaaaaa", apiKeyRef: "ANTHROPIC_API_KEY" } as Provider,
    ];
    expect(localProviderIds(providers)).toEqual(new Set(["prv_local"]));
  });

  it("separates a free model from one whose price nobody recorded", () => {
    // `$0` renders the same for both, and the costs panel bills the second as
    // zero — so counting them apart is how a fictional spend figure surfaces.
    const counts = countCategories(
      [
        model({ id: "x/free", pricing: { ...unpriced, inputPerMTok: 0, outputPerMTok: 0 } }),
        model({ id: "x/unknown", pricing: unpriced }),
      ],
      new Set(),
    );
    expect(counts.free).toBe(1);
    expect(counts.unpriced).toBe(1);
    expect(counts.paid).toBe(0);
  });

  it("calls a half-priced model paid rather than free", () => {
    // Something about it bills. Calling it free on the strength of the half we
    // happen to know is how a surprise arrives.
    const counts = countCategories(
      [model({ id: "x/half", pricing: { ...unpriced, inputPerMTok: 0, outputPerMTok: 15 } })],
      new Set(),
    );
    expect(counts.paid).toBe(1);
    expect(counts.free).toBe(0);
  });

  it("counts a local model in both its buckets", () => {
    // The axes are independent: a free local model is one row and two counts,
    // which is why the four never sum to the registry size.
    const counts = countCategories(
      [
        model({
          id: "ollama/qwen3-4b",
          providerId: "prv_local",
          pricing: { ...unpriced, inputPerMTok: 0, outputPerMTok: 0 },
        }),
      ],
      local,
    );
    expect(counts.local).toBe(1);
    expect(counts.free).toBe(1);
  });

  it("reports every category, including the empty ones", () => {
    // A chip that vanishes at zero makes the row jump when a sync lands, and
    // "0 unpriced" is a reassuring fact worth showing.
    expect(Object.keys(countCategories([], new Set())).sort()).toEqual([
      "free",
      "local",
      "paid",
      "unpriced",
    ]);
  });
});
