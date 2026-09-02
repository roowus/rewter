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
import type { CapabilityCard, Model, ModelStat } from "@rewter/shared";
import { estimateTokens } from "./tokens.js";

export interface DigestEntry {
  model: Model;
  card?: CapabilityCard | undefined;
  /**
   * Learned outcomes for this model (`model_stats` rows, any order). Rendered
   * as one `stats:[…]` fact after the card. These are the one input that
   * changes between orchestrations — every tagged worker that finishes moves a
   * number — so they cost a cache miss each time they move. Accepted: a
   * statistic that never changed would not be worth showing, and it moves at
   * most once per worker, never mid-orchestration (the digest is built once per
   * initiator session).
   */
  stats?: ModelStat[] | undefined;
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

const DEFAULT_MAX_TOKENS = 4000;

/**
 * Render one line per model, stable-sorted by id.
 *
 * Format: `<id> — $in/$out per MTok, <ctx> ctx[, vision][, tools] — best:[…] — avoid:[…]`
 * then `— stats:[…]` when the model has learned outcomes, then `— <summary>`
 * when the card has one. Absent facts are omitted
 * rather than rendered as "unknown": a line of nulls is noise, and the
 * initiator can only act on what is present anyway.
 */
export function renderDigest(entries: DigestEntry[], opts: DigestOptions = {}): string {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const sorted = [...entries].sort((a, b) => (a.model.id < b.model.id ? -1 : 1));

  const lines: string[] = [];
  let budget = maxTokens;
  let dropped = 0;

  for (const entry of sorted) {
    const line = renderLine(entry);
    // +1 for the newline joining lines; tokenizers charge for it.
    const cost = estimateTokens(line) + 1;
    if (cost > budget) {
      dropped++;
      continue;
    }
    budget -= cost;
    lines.push(line);
  }

  if (dropped > 0) {
    lines.push(`(${dropped} further model(s) omitted for space.)`);
  }
  return lines.join("\n");
}

function renderLine({ model, card, stats }: DigestEntry): string {
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
  }

  const statsFact = statsFactOf(stats ?? []);
  if (statsFact !== undefined) parts.push(statsFact);

  // The summary stays last: it is the one free-text part, and a reader scanning
  // for the bracketed facts should find them at fixed positions before it.
  if (card !== undefined && card.summary !== "") parts.push(card.summary);

  return parts.join(" — ");
}

/**
 * `stats:[coding 4/5 ok ~$0.012 ~14s, summarization 2/2 ok ~$0.001 ~3s]`
 *
 * Ordered by tag so two renders of the same rows are the same bytes, and the
 * row is *counts*, not a percentage: "4/5" tells the initiator how much
 * evidence there is, which "80%" hides, and a 1/1 should not read like a 10/10.
 * Cost and latency are omitted when never measured (a free local model has no
 * cost rows; an item with no finish time has no latency).
 */
function statsFactOf(stats: ModelStat[]): string | undefined {
  if (stats.length === 0) return undefined;
  const rows = [...stats]
    .filter((s) => s.attempts > 0)
    .sort((a, b) => (a.taskTag < b.taskTag ? -1 : a.taskTag > b.taskTag ? 1 : 0))
    .map((s) => {
      const bits = [s.taskTag, `${s.successes}/${s.attempts} ok`];
      if (s.avgCostUsd !== null) bits.push(`~$${money(s.avgCostUsd)}`);
      if (s.avgLatencyMs !== null) bits.push(`~${duration(s.avgLatencyMs)}`);
      return bits.join(" ");
    });
  if (rows.length === 0) return undefined;
  return `stats:[${rows.join(", ")}]`;
}

/** Whole seconds under a minute, tenths of a minute above: coarse on purpose. */
function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  return `${Number((s / 60).toFixed(1))}m`;
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
 *
 * Each test is against the literal, because these are tri-state: `null` means
 * no upstream reported it. Unknown renders as nothing at all — the initiator
 * reading this line should not be told "no tools" about a model whose catalog
 * was simply an id list, and it should not be promised vision on that basis
 * either. Silence is the honest rendering of silence.
 */
function capabilityFacts(model: Model): (string | undefined)[] {
  return [
    model.supports.vision === true ? "vision" : undefined,
    model.supports.tools === false ? "no tools" : undefined,
    model.supports.caching === true ? "caching" : undefined,
  ];
}
