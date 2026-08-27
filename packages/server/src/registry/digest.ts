/**
 * The registry digest: the block of text that teaches the initiator AI which
 * models exist and what they are good for. It is the second section of the
 * orchestrator's system prompt, between the static core and the user's task.
 *
 * Two properties drive every decision in this file.
 *
 * **Stability.** The digest sits behind a `cache_control` breakpoint on
 * Anthropic. Any byte that changes between requests invalidates the cache and
 * makes every orchestration pay full input price for a prompt that did not
 * meaningfully change. So the output is deterministic: stable sort by model id,
 * no timestamps, no wall-clock, no iteration order dependence, and prices
 * formatted from the number rather than interpolated raw (0.6 and 0.60 are the
 * same price and must render identically).
 *
 * **Density.** This competes for context with the actual task, and a model that
 * needs 200 tokens to describe itself has crowded out the work. One line per
 * model, abbreviations over prose, and a hard budget with honest truncation.
 */
import type { CapabilityCard, Model } from "@rewter/shared";

export interface DigestEntry {
  model: Model;
  card?: CapabilityCard | undefined;
}

export interface DigestOptions {
  /**
   * Approximate token ceiling. Models are dropped from the *end* of the sorted
   * list once exceeded, and the omission is stated in the digest rather than
   * left silent — an initiator that cannot see a model will not choose it, and
   * it should know that is why.
   */
  maxTokens?: number;
}

/** ~4 chars per token. Deliberately crude: the budget is a guardrail, not a meter. */
const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 4000;

/**
 * Render one line per model, stable-sorted by id.
 *
 * Format: `<id> — $in/$out per MTok, <ctx> ctx[, vision][, tools] — best:[…] — avoid:[…]`
 * with `— <summary>` appended when the card has one. Absent facts are omitted
 * rather than rendered as "unknown": a line of nulls is noise, and the
 * initiator can only act on what is present anyway.
 */
export function renderDigest(entries: DigestEntry[], opts: DigestOptions = {}): string {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const sorted = [...entries].sort((a, b) => (a.model.id < b.model.id ? -1 : 1));

  const lines: string[] = [];
  let budget = maxTokens * CHARS_PER_TOKEN;
  let dropped = 0;

  for (const entry of sorted) {
    const line = renderLine(entry);
    if (line.length + 1 > budget) {
      dropped++;
      continue;
    }
    budget -= line.length + 1;
    lines.push(line);
  }

  if (dropped > 0) {
    lines.push(`(${dropped} further model(s) omitted for space.)`);
  }
  return lines.join("\n");
}

function renderLine({ model, card }: DigestEntry): string {
  // Annotated: `model.id` is branded, and an inferred element type would reject
  // every plain string pushed after it.
  const parts: string[] = [model.id];

  const facts = [priceFact(model), contextFact(model), ...capabilityFacts(model)].filter(
    (f): f is string => f !== undefined,
  );
  if (facts.length > 0) parts.push(facts.join(", "));

  if (card !== undefined) {
    if (card.bestAt.length > 0) parts.push(`best:[${card.bestAt.join(",")}]`);
    if (card.weaknesses.length > 0) parts.push(`avoid:[${card.weaknesses.join(",")}]`);
    if (card.summary !== "") parts.push(card.summary);
  }

  return parts.join(" — ");
}

function priceFact(model: Model): string | undefined {
  const { inputPerMTok: i, outputPerMTok: o } = model.pricing;
  if (i === null && o === null) return undefined;
  // A free local model is a *fact*, and "$0/$0" reads like missing data.
  if (i === 0 && o === 0) return "free";
  return `$${money(i)}/$${money(o)} per MTok`;
}

/** Trim trailing zeros so a price change, not a formatting change, moves bytes. */
function money(n: number | null): string {
  if (n === null) return "?";
  return String(Number(n.toFixed(4)));
}

function contextFact(model: Model): string | undefined {
  if (model.contextWindow === null) return undefined;
  return `${compactCount(model.contextWindow)} ctx`;
}

/** 1000000 → 1M, 200000 → 200K. Shorter, and reads the way models are discussed. */
function compactCount(n: number): string {
  if (n >= 1_000_000 && n % 100_000 === 0) return `${Number((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1000 && n % 100 === 0) return `${Number((n / 1000).toFixed(1))}K`;
  return String(n);
}

/**
 * Only *notable* capabilities are listed. Streaming is universal and tools are
 * the norm, so their presence carries no information — but their **absence**
 * does, because it rules a model out of a whole tier of work.
 */
function capabilityFacts(model: Model): (string | undefined)[] {
  return [
    model.supports.vision ? "vision" : undefined,
    model.supports.tools ? undefined : "no tools",
    model.supports.caching ? "caching" : undefined,
  ];
}
