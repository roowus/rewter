/**
 * Capability-card generation: ask a model to describe another model, and turn
 * its prose into a row the digest renderer can print.
 *
 * The card is what the orchestrator reads when it decides who does what, so
 * everything here is written against one assumption: **the generator is an
 * unreliable narrator**. It will invent tags outside the vocabulary, write a
 * paragraph where a clause was asked for, wrap JSON in prose, and occasionally
 * claim a model is both good and bad at the same thing. None of that may cost
 * us the card, and none of it may put a value into the registry that the digest
 * or the tag vocabulary cannot represent. So the response is extracted, parsed,
 * filtered, and normalized — and what was discarded is reported rather than
 * swallowed, because a card built from half a response should say so.
 *
 * What generation deliberately cannot do is touch a hand correction:
 * `upsertCard` writes only the generated half (see [Capability cards] in
 * ARCHITECTURE). Regenerating is therefore always safe, which is why `card`
 * needs no confirmation prompt.
 */
import {
  type CapabilityCard,
  CapabilityCardSchema,
  type CapabilityTag,
  CapabilityTagSchema,
  type ChatMessage,
  type ChatResponse,
  type Model,
  ModelIdSchema,
} from "@rewter/shared";
import { z } from "zod";
import { clamp, collapse, extractJsonObject } from "../llm/text.js";

/** Bumped when the prompt changes shape; snapshot-tested for stability. */
export const CARD_PROMPT_VERSION = 2;

/**
 * A summary is one clause on one digest line. Longer, and a hundred models push
 * the digest past its token budget and start dropping models the orchestrator
 * would have chosen.
 */
const SUMMARY_MAX_CHARS = 180;
const NOTES_MAX_CHARS = 600;
/**
 * Cards are ~80 tokens of JSON, so this is a runaway guard rather than a target
 * — but it has to clear the *thinking* a reasoning model does first, which is
 * charged as completion tokens and emitted before a single byte of the answer.
 * At 800 a card generator would truncate mid-JSON and report "no JSON object",
 * blaming the model for what was our ceiling.
 */
const MAX_TOKENS = 4_000;

export class CardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardError";
  }
}

// ── Prompt ──────────────────────────────────────────────────────────────────

/**
 * The vocabulary is interpolated from the schema rather than retyped, so a tag
 * added in `shared` cannot silently go un-offered to the generator — which
 * would leave it permanently unused.
 */
export const CAPABILITY_TAGS: readonly CapabilityTag[] = CapabilityTagSchema.options;

export const CARD_SYSTEM_PROMPT = `You write capability cards for an AI model router.

A card tells an orchestrator AI when to pick this model over the others it has. Write for
that reader: concrete, comparative, and short. Do not market the model.

Reply with a single JSON object and nothing else — no prose, no code fence:

{
  "summary": "one clause, under ${SUMMARY_MAX_CHARS} characters, no line breaks",
  "strengths": ["tag", ...],
  "weaknesses": ["tag", ...],
  "bestAt": ["tag", ...],
  "notes": "optional free text, or null"
}

Every tag must come from exactly this vocabulary; anything else is discarded:
${CAPABILITY_TAGS.join(", ")}

Rules:
- "bestAt" is the short list — at most three tags — of work this model should be
  *preferred* for. "strengths" is the wider list of what it is competent at.
- "weaknesses" is what it should be routed *away* from. Leave it empty rather than
  padding it; a false weakness costs the router an option it needed.
- Never put the same tag in both "strengths" and "weaknesses".
- "summary" states what distinguishes this model, not what all models do. "an AI model
  that can answer questions" is useless; "cheap 1M-context workhorse, weak at math" is not.
- "notes" is for anything a router should know that the tags cannot express — quirks,
  rate limits, prompt-format sensitivities. Use null when there is nothing.
- State no specification you were not given. Parameter counts, training-data cutoffs,
  architectures and benchmark numbers are exactly the details that get invented; the router
  cannot check them, and a wrong one is quoted back as fact. Judgement about what the model
  is good at is what you are here for.
- If you do not know this model, say so in "summary" and leave the tag lists empty.
  A card that admits ignorance is useful; a fabricated one is worse than none.`;

/**
 * The facts we already hold are stated rather than asked for: the generator's
 * job is judgement about a model, and it should not be guessing at a price we
 * have in the database — nor overwriting it, since the card carries no pricing.
 */
export function buildCardMessages(model: Model): ChatMessage[] {
  const facts = [
    `id: ${model.id}`,
    `upstream id: ${model.upstreamId}`,
    `display name: ${model.displayName}`,
    `context window: ${model.contextWindow === null ? "unknown" : `${model.contextWindow} tokens`}`,
    `price per Mtok: in ${price(model.pricing.inputPerMTok)}, out ${price(model.pricing.outputPerMTok)}`,
    `modalities: ${model.modalities.join(", ")}`,
    `supports: ${supportsFact(model)}`,
  ];
  return [
    { role: "system", content: CARD_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Write the capability card for this model.\n\n${facts.join("\n")}`,
    },
  ];
}

/**
 * Reported capabilities, with the unreported ones named as unknown rather than
 * dropped. The prompt above forbids stating a specification it was not given —
 * so an omitted `vision` reads as "not in the facts", which is the same silence
 * as `vision: false`, and the generator has no way to tell them apart. Saying
 * "unknown" out loud is what lets it write a card that admits the gap.
 */
function supportsFact(model: Model): string {
  const yes = Object.entries(model.supports)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  const unknown = Object.entries(model.supports)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  return [
    yes.length === 0 ? "none reported" : yes.join(", "),
    ...(unknown.length === 0 ? [] : [`(unknown: ${unknown.join(", ")})`]),
  ].join(" ");
}

function price(n: number | null): string {
  return n === null ? "unknown" : `$${n}`;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * What a generator is allowed to produce. Tags are `string` here rather than the
 * enum on purpose: an invented tag must be *dropped*, not fatal, and a
 * `z.enum()` would reject the whole array — losing four good tags to one bad one.
 */
const DraftSchema = z.object({
  summary: z.string().min(1),
  strengths: z.array(z.string()).default([]),
  weaknesses: z.array(z.string()).default([]),
  bestAt: z.array(z.string()).default([]),
  notes: z.string().nullable().default(null),
});

export interface CardDraft {
  summary: string;
  strengths: CapabilityTag[];
  weaknesses: CapabilityTag[];
  bestAt: CapabilityTag[];
  notes: string | null;
}

export interface ParsedCard {
  draft: CardDraft;
  /** Tags outside the vocabulary, in the order seen, deduped. Reported, not fatal. */
  unknownTags: string[];
  /** Tags claimed as both a strength and a weakness; resolved as weaknesses. */
  contradictions: CapabilityTag[];
}

/**
 * Extract and normalize a card from a generator's raw reply.
 *
 * Throws only when there is no card to be had at all — no JSON object, or one
 * missing a summary. Everything else degrades: unknown tags are dropped, an
 * over-long summary is truncated, whitespace is collapsed.
 */
export function parseCardJson(raw: string): ParsedCard {
  const json = extractJsonObject(raw);
  if (json === undefined) throw new CardError("no JSON object in the generator's reply");

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    throw new CardError(`generator produced invalid JSON: ${message(err)}`);
  }

  const parsed = DraftSchema.safeParse(value);
  if (!parsed.success) {
    throw new CardError(
      `generator's card does not fit the schema: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}`,
    );
  }

  const unknown: string[] = [];
  const strengths = tags(parsed.data.strengths, unknown);
  const weaknesses = tags(parsed.data.weaknesses, unknown);
  const bestAt = tags(parsed.data.bestAt, unknown);

  // A tag claimed as both is a slip, and the two readings are not symmetric: a
  // false strength gets the model *chosen* for work it will do badly and bill
  // for, a false weakness only forgoes an option. So the weakness wins.
  const contradictions = strengths.filter((t) => weaknesses.includes(t));
  const keep = (list: CapabilityTag[]) => list.filter((t) => !contradictions.includes(t));

  return {
    draft: {
      summary: clamp(collapse(parsed.data.summary), SUMMARY_MAX_CHARS),
      strengths: keep(strengths),
      weaknesses,
      bestAt: keep(bestAt),
      notes: parsed.data.notes === null ? null : clamp(parsed.data.notes.trim(), NOTES_MAX_CHARS),
    },
    unknownTags: [...new Set(unknown)],
    contradictions,
  };
}

/** Keep vocabulary tags in order, dedupe, and collect what was thrown away. */
function tags(values: string[], unknown: string[]): CapabilityTag[] {
  const kept: CapabilityTag[] = [];
  for (const value of values) {
    const parsed = CapabilityTagSchema.safeParse(value.trim().toLowerCase());
    if (!parsed.success) {
      unknown.push(value);
      continue;
    }
    if (!kept.includes(parsed.data)) kept.push(parsed.data);
  }
  return kept;
}

// ── Generation ──────────────────────────────────────────────────────────────

/** The slice of `Router` generation needs — so tests need no adapters. */
export interface CardGenerator {
  resolve(model: string): { model: Model };
  complete(
    req: { model: string; messages: ChatMessage[]; maxTokens?: number; temperature?: number },
    signal?: AbortSignal,
  ): Promise<ChatResponse>;
}

/** The slice of `Repos` generation needs. */
export interface CardTarget {
  getModel(id: string): Model | undefined;
  listModels(opts?: { enabledOnly?: boolean }): Model[];
  getCard(id: string): CapabilityCard | undefined;
  upsertCard(card: CapabilityCard): CapabilityCard;
}

export interface GenerateOptions {
  /** Model that writes the cards. Resolved up front, so a typo fails before spending. */
  using: string;
  /** Produce the card but do not store it. */
  dryRun?: boolean;
  now?: () => number;
  signal?: AbortSignal;
}

export interface CardResult {
  modelId: string;
  card?: CapabilityCard;
  unknownTags: string[];
  contradictions: string[];
  error?: string;
}

export interface CardReport {
  generatedBy: string;
  results: CardResult[];
  dryRun: boolean;
}

/**
 * Write one card. The generated card is returned even under `dryRun`, so the
 * CLI can print exactly what it would have stored.
 *
 * Cost is not accounted for here: the call goes through `Router`, which records
 * a CostRecord for every completion, so card generation shows up in the same
 * spend ledger as everything else.
 */
export async function generateCard(
  generator: CardGenerator,
  target: CardTarget,
  model: Model,
  opts: GenerateOptions,
): Promise<CardResult> {
  const generatedBy = generator.resolve(opts.using).model.id;
  const now = opts.now ?? Date.now;

  let response: ChatResponse;
  try {
    response = await generator.complete(
      {
        model: generatedBy,
        messages: buildCardMessages(model),
        maxTokens: MAX_TOKENS,
        // Cards are facts about a model, not prose: two runs should differ
        // because the registry changed, not because sampling did.
        temperature: 0,
      },
      opts.signal,
    );
  } catch (err) {
    return { modelId: model.id, unknownTags: [], contradictions: [], error: message(err) };
  }

  let parsed: ParsedCard;
  try {
    parsed = parseCardJson(response.message.content ?? "");
  } catch (err) {
    // A generator that ran out of room did not "produce no JSON" — it produced
    // half of one, and the ceiling is ours. Say which it was, or the next person
    // debugs the model instead of the cap.
    const truncated =
      response.finishReason === "length"
        ? ` (the reply hit the ${MAX_TOKENS}-token ceiling and was cut off — a reasoning model may spend it all before answering)`
        : "";
    return {
      modelId: model.id,
      unknownTags: [],
      contradictions: [],
      error: `${message(err)}${truncated}`,
    };
  }

  const card = CapabilityCardSchema.parse({
    modelId: model.id,
    ...parsed.draft,
    // Never authored here: `upsertCard` leaves the override column alone, and a
    // generated value would be a claim about a half of the row we cannot see.
    userOverrides: null,
    generatedBy: ModelIdSchema.parse(generatedBy),
    generatedAt: now(),
    updatedAt: now(),
  });

  const stored = opts.dryRun === true ? card : target.upsertCard(card);
  return {
    modelId: model.id,
    card: stored,
    unknownTags: parsed.unknownTags,
    contradictions: parsed.contradictions,
  };
}

export interface GenerateCardsOptions extends GenerateOptions {
  /** Rewrite cards that already exist. Off by default: regeneration costs money. */
  regenerate?: boolean;
}

/**
 * Write cards for a set of models, one at a time.
 *
 * Sequential on purpose. This is an interactive command against a single
 * upstream, and a burst of parallel calls buys a few seconds at the price of
 * rate-limit failures halfway through a run the user then has to repeat.
 */
export async function generateCards(
  generator: CardGenerator,
  target: CardTarget,
  models: Model[],
  opts: GenerateCardsOptions,
): Promise<CardReport> {
  const generatedBy = generator.resolve(opts.using).model.id;
  const results: CardResult[] = [];

  for (const model of models) {
    if (opts.regenerate !== true && target.getCard(model.id) !== undefined) continue;
    results.push(await generateCard(generator, target, model, opts));
  }

  return { generatedBy, results, dryRun: opts.dryRun === true };
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** The card as a human reads it — what `--dry-run` and `--show` print. */
export function formatCard(card: CapabilityCard): string {
  const lines = [
    `${card.modelId}`,
    `  summary:    ${card.summary}`,
    `  best at:    ${list(card.bestAt)}`,
    `  strengths:  ${list(card.strengths)}`,
    `  weaknesses: ${list(card.weaknesses)}`,
  ];
  if (card.notes !== null) lines.push(`  notes:      ${card.notes}`);
  if (card.userOverrides !== null) {
    lines.push(`  overridden: ${Object.keys(card.userOverrides).sort().join(", ")}`);
  }
  if (card.generatedBy !== null) lines.push(`  written by: ${card.generatedBy}`);
  return lines.join("\n");
}

function list(tags: readonly string[]): string {
  return tags.length === 0 ? "—" : tags.join(", ");
}

export function formatCardReport(report: CardReport): string {
  const lines: string[] = [];
  for (const result of report.results) {
    if (result.error !== undefined) {
      lines.push(`${result.modelId}: failed — ${result.error}`);
      continue;
    }
    if (result.card !== undefined) lines.push(formatCard(result.card));
    // Say what was thrown away. A card silently missing the one tag the
    // generator cared about looks like the generator's opinion, not ours.
    if (result.unknownTags.length > 0) {
      lines.push(
        `  ignored ${result.unknownTags.length} tag(s) outside the vocabulary: ${result.unknownTags.join(", ")}`,
      );
    }
    if (result.contradictions.length > 0) {
      lines.push(
        `  claimed both good and bad at: ${result.contradictions.join(", ")} — kept as weaknesses`,
      );
    }
  }
  if (lines.length === 0) lines.push("nothing to do — every model already has a card");
  else if (report.dryRun) lines.push("(dry run — nothing written)");
  return lines.join("\n");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
