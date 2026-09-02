/**
 * Digest tests. The interesting ones are not "does it render" but "does it
 * render the *same bytes* given the same registry" — the digest sits behind a
 * prompt-cache breakpoint, so instability is a cost bug, not a cosmetic one.
 */
import type { CapabilityCard, CapabilityTag, Model, ModelStat } from "@rewter/shared";
import { ModelIdSchema, ProviderIdSchema } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { renderDigest } from "./digest.js";

const prv = ProviderIdSchema.parse("prv_testxx000000");

function stat(id: string, taskTag: CapabilityTag, over: Partial<ModelStat> = {}): ModelStat {
  return {
    modelId: ModelIdSchema.parse(id),
    taskTag,
    attempts: 1,
    successes: 1,
    avgCostUsd: null,
    avgLatencyMs: null,
    updatedAt: 1,
    ...over,
  };
}

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

  // ── Learned stats ─────────────────────────────────────────────────────────

  it("renders stats as counts with rounded means, between the card facts and the summary", () => {
    const out = renderDigest([
      {
        model: model("zai/glm-5.3"),
        card: card("zai/glm-5.3", { bestAt: ["coding"], summary: "quick generalist" }),
        stats: [
          stat("zai/glm-5.3", "summarization", {
            attempts: 2,
            successes: 2,
            avgCostUsd: 0.0012,
            avgLatencyMs: 3400,
          }),
          stat("zai/glm-5.3", "coding", {
            attempts: 5,
            successes: 4,
            avgCostUsd: 0.01234,
            avgLatencyMs: 14_200,
          }),
        ],
      },
    ]);
    expect(out).toBe(
      "zai/glm-5.3 — $0.6/$2.2 per MTok, 200K ctx — best:[coding] — " +
        "stats:[coding 4/5 ok ~$0.0123 ~14s, summarization 2/2 ok ~$0.0012 ~3s] — quick generalist",
    );
  });

  it("omits an unmeasured mean, and the whole fact when there is nothing to say", () => {
    const free = renderDigest([
      {
        model: model("local/llama"),
        stats: [
          stat("local/llama", "ocr", {
            attempts: 1,
            successes: 0,
            avgCostUsd: null,
            avgLatencyMs: 90_000,
          }),
        ],
      },
    ]);
    expect(free).toContain("stats:[ocr 0/1 ok ~1.5m]");

    const empty = renderDigest([{ model: model("zai/glm-5.3"), stats: [] }]);
    expect(empty).toBe("zai/glm-5.3 — $0.6/$2.2 per MTok, 200K ctx");
  });

  it("orders stats by tag whatever order the rows arrive in", () => {
    const rows = [
      stat("zai/glm-5.3", "coding"),
      stat("zai/glm-5.3", "math"),
      stat("zai/glm-5.3", "extraction"),
    ];
    const a = renderDigest([{ model: model("zai/glm-5.3"), stats: rows }]);
    const b = renderDigest([{ model: model("zai/glm-5.3"), stats: [...rows].reverse() }]);
    expect(a).toBe(b);
    expect(a).toContain("stats:[coding 1/1 ok, extraction 1/1 ok, math 1/1 ok]");
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

  it("says nothing at all about a capability nobody reported", () => {
    const out = renderDigest([
      {
        model: model("ollama/mystery", {
          supports: { tools: null, streaming: true, vision: null, caching: null },
        }),
      },
    ]);
    // Unknown is not a denial. "no tools" here would rule a local model out of
    // every tier-2 subtask on the strength of its catalog being an id list, and
    // "vision" would promise a capability on the same non-evidence.
    expect(out).not.toContain("no tools");
    expect(out).not.toContain("vision");
    expect(out).not.toContain("caching");
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
