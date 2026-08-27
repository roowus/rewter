import type { ModelPricing, Usage } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { FREE_PRICING, computeCost } from "./compute.js";

const usage = (over: Partial<Usage> = {}): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

const pricing = (over: Partial<ModelPricing> = {}): ModelPricing => ({
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
  ...over,
});

describe("computeCost", () => {
  it("bills each component at its own per-million rate", () => {
    const c = computeCost(
      usage({
        inputTokens: 1_000_000,
        outputTokens: 2_000_000,
        cacheReadTokens: 10_000_000,
        cacheWriteTokens: 400_000,
      }),
      pricing(),
    );
    expect(c.inputUsd).toBeCloseTo(3, 9);
    expect(c.outputUsd).toBeCloseTo(30, 9);
    expect(c.cacheReadUsd).toBeCloseTo(3, 9);
    expect(c.cacheWriteUsd).toBeCloseTo(1.5, 9);
    expect(c.totalUsd).toBeCloseTo(37.5, 9);
    expect(c.incomplete).toBe(false);
  });

  it("scales sub-million counts proportionally", () => {
    const c = computeCost(usage({ inputTokens: 1_500, outputTokens: 300 }), pricing());
    expect(c.totalUsd).toBeCloseTo(0.0045 + 0.0045, 9);
  });

  it("falls back to the input rate when cache pricing is unknown", () => {
    // Upstreams that bill cache tokens price them relative to input; a silent 0
    // would under-report a cache-heavy orchestration run.
    const c = computeCost(
      usage({ cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }),
      pricing({ cacheReadPerMTok: null, cacheWritePerMTok: null }),
    );
    expect(c.cacheReadUsd).toBeCloseTo(3, 9);
    expect(c.cacheWriteUsd).toBeCloseTo(3, 9);
    expect(c.incomplete).toBe(false);
  });

  it("flags an unpriced component as incomplete rather than free", () => {
    const c = computeCost(
      usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      pricing({ outputPerMTok: null }),
    );
    expect(c.outputUsd).toBe(0);
    expect(c.totalUsd).toBeCloseTo(3, 9);
    // The total is a lower bound, and the dashboard must be able to say so.
    expect(c.incomplete).toBe(true);
  });

  it("does not flag an unpriced component that saw no tokens", () => {
    const c = computeCost(usage({ inputTokens: 1_000 }), pricing({ outputPerMTok: null }));
    expect(c.incomplete).toBe(false);
  });

  it("treats an explicit zero price as free, not unknown", () => {
    const c = computeCost(usage({ inputTokens: 5_000_000, outputTokens: 5_000_000 }), FREE_PRICING);
    expect(c.totalUsd).toBe(0);
    expect(c.incomplete).toBe(false);
  });

  it("costs an empty usage at zero", () => {
    expect(computeCost(usage(), pricing()).totalUsd).toBe(0);
  });
});
