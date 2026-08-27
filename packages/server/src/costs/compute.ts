/**
 * Cost computation. Prices are quoted per million tokens; a null price means
 * "unknown", not "free" — those components contribute 0 but are flagged so the
 * dashboard can distinguish a genuinely free local model from an unpriced one.
 *
 * Cost is computed once, at write time, from a snapshot of the pricing that was
 * in effect. Re-deriving it later from current prices would silently rewrite
 * history every time a vendor changes a rate.
 */
import type { ModelPricing, Usage } from "@rewter/shared";

const PER_MILLION = 1_000_000;

export interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  totalUsd: number;
  /** True when a component had tokens but no price — the total is a lower bound. */
  incomplete: boolean;
}

export function computeCost(usage: Usage, pricing: ModelPricing): CostBreakdown {
  let incomplete = false;

  const component = (tokens: number, perMTok: number | null): number => {
    if (perMTok === null) {
      if (tokens > 0) incomplete = true;
      return 0;
    }
    return (tokens / PER_MILLION) * perMTok;
  };

  const inputUsd = component(usage.inputTokens, pricing.inputPerMTok);
  const outputUsd = component(usage.outputTokens, pricing.outputPerMTok);
  // Cache reads/writes fall back to the base input rate when unpriced: most
  // upstreams that bill cache tokens at all bill them relative to input, and a
  // silent 0 here would under-report a cache-heavy orchestration run.
  const cacheReadUsd = component(
    usage.cacheReadTokens,
    pricing.cacheReadPerMTok ?? pricing.inputPerMTok,
  );
  const cacheWriteUsd = component(
    usage.cacheWriteTokens,
    pricing.cacheWritePerMTok ?? pricing.inputPerMTok,
  );

  return {
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    totalUsd: inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd,
    incomplete,
  };
}

/** Zero pricing — used for models with no price data at all (local runtimes). */
export const FREE_PRICING: ModelPricing = {
  inputPerMTok: 0,
  outputPerMTok: 0,
  cacheReadPerMTok: 0,
  cacheWritePerMTok: 0,
};
