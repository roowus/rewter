/**
 * Digest tests. The interesting ones are not "does it render" but "does it
 * render the *same bytes* given the same registry" — the digest sits behind a
 * prompt-cache breakpoint, so instability is a cost bug, not a cosmetic one.
 */
import type { CapabilityCard, Model } from "@rewter/shared";
import { ModelIdSchema, ProviderIdSchema } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { renderDigest } from "./digest.js";

const prv = ProviderIdSchema.parse("prv_testxx000000");

function model(id: string, over: Partial<Model> = {}): Model {
  return {
    id: ModelIdSchema.parse(id),
    providerId: prv,
    upstreamId: id.split("/")[1] ?? id,
    displayName: id,
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    pricing: {
      inputPerMTok: 0.6,
      outputPerMTok: 2.2,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    },
    modalities: ["text"],
    supports: { tools: true, streaming: true, vision: false, caching: false },
    source: "manual",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function card(id: string, over: Partial<CapabilityCard> = {}): CapabilityCard {
  return {
    modelId: ModelIdSchema.parse(id),
    summary: "",
    strengths: [],
    weaknesses: [],
    bestAt: [],
    notes: null,
    userOverrides: null,
    generatedBy: null,
    generatedAt: null,
    updatedAt: 1,
    ...over,
  };
}

describe("renderDigest", () => {
  it("renders one line per model with price and context", () => {
    const out = renderDigest([{ model: model("zai/glm-5.3") }]);
    expect(out).toBe("zai/glm-5.3 — $0.6/$2.2 per MTok, 200K ctx");
  });

  it("appends card facts after the hard specs", () => {
    const out = renderDigest([
      {
        model: model("zai/glm-5.3"),
        card: card("zai/glm-5.3", {
          bestAt: ["coding", "fast_cheap"],
          weaknesses: ["vision"],
          summary: "quick generalist",
        }),
      },
    ]);
    expect(out).toBe(
      "zai/glm-5.3 — $0.6/$2.2 per MTok, 200K ctx — best:[coding,fast_cheap] — avoid:[vision] — quick generalist",
    );
  });

  // ── Stability: the cacheability property ──────────────────────────────────

  it("is byte-identical across renders and independent of input order", () => {
    const entries = [
      { model: model("zai/glm-5.3") },
      { model: model("anthropic/claude-sonnet-5") },
      { model: model("openai/gpt-5") },
    ];
    const a = renderDigest(entries);
    const b = renderDigest([...entries].reverse());

    expect(a).toBe(b);
    expect(a.split("\n").map((l) => l.split(" ")[0])).toEqual([
      "anthropic/claude-sonnet-5",
      "openai/gpt-5",
      "zai/glm-5.3",
    ]);
  });

  it("does not move bytes when a price carries float noise", () => {
    // 0.1 + 0.5 is 0.6000000000000001 in IEEE 754. It is the same price, and a
    // digest that renders it differently invalidates the prompt cache over
    // arithmetic — which is exactly how a synced price arrives.
    const a = renderDigest([{ model: model("m/x") }]);
    const b = renderDigest([
      {
        model: model("m/x", {
          pricing: {
            inputPerMTok: 0.1 + 0.5,
            outputPerMTok: 2.2,
            cacheReadPerMTok: null,
            cacheWritePerMTok: null,
          },
        }),
      },
    ]);
    expect(a).toBe(b);
  });

  it("does not leak timestamps into the output", () => {
    const a = renderDigest([{ model: model("m/x", { updatedAt: 1 }) }]);
    const b = renderDigest([{ model: model("m/x", { updatedAt: 999_999 }) }]);
    expect(a).toBe(b);
  });

  it("does not mutate the caller's array while sorting", () => {
    const entries = [{ model: model("z/z") }, { model: model("a/a") }];
    renderDigest(entries);
    expect(entries[0]?.model.id).toBe("z/z");
  });

  // ── Density and honest omission ───────────────────────────────────────────

  it("omits absent facts rather than printing unknowns", () => {
    const out = renderDigest([
      {
        model: model("local/mystery", {
          contextWindow: null,
          pricing: {
            inputPerMTok: null,
            outputPerMTok: null,
            cacheReadPerMTok: null,
            cacheWritePerMTok: null,
          },
        }),
      },
    ]);
    expect(out).toBe("local/mystery");
  });

  it("calls a zero-priced model free rather than $0/$0", () => {
    const out = renderDigest([
      {
        model: model("ollama/llama3", {
          pricing: {
            inputPerMTok: 0,
            outputPerMTok: 0,
            cacheReadPerMTok: null,
            cacheWritePerMTok: null,
          },
        }),
      },
    ]);
    expect(out).toContain("— free,");
  });

  it("notes vision and caching, and the *absence* of tools", () => {
    const out = renderDigest([
      {
        model: model("x/vlm", {
          supports: { tools: false, streaming: true, vision: true, caching: true },
        }),
      },
    ]);
    expect(out).toContain("vision, no tools, caching");
  });

  it("says so when it drops models for space instead of silently truncating", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      // Zero-padded so sort order is the obvious one.
      ({ model: model(`p/m${String(i).padStart(2, "0")}`) }),
    );
    const out = renderDigest(many, { maxTokens: 50 });

    expect(out.split("\n").length).toBeLessThan(50);
    expect(out).toMatch(/\(\d+ further model\(s\) omitted for space\.\)/);
  });

  it("renders an empty registry as an empty string, not a stray header", () => {
    expect(renderDigest([])).toBe("");
  });

  it("abbreviates a million-token window as 1M", () => {
    const out = renderDigest([{ model: model("m/big", { contextWindow: 1_000_000 }) }]);
    expect(out).toContain("1M ctx");
  });
});
