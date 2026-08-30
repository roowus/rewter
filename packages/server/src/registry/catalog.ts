/**
 * Reading a provider's model catalog off the wire.
 *
 * Three upstream shapes exist and they disagree about almost everything. The
 * useful axis is not the wire format but **how much they tell you**:
 *
 * - **OpenRouter** is the rich one: id, context length, per-token prices,
 *   modalities, and which parameters a model supports. It is the only upstream
 *   that hands over pricing, which is why it doubles as an enrichment source for
 *   everyone else (see `enrichFromOpenRouter`).
 * - **Google** gives limits but no prices: `inputTokenLimit`/`outputTokenLimit`
 *   and a list of generation methods.
 * - **Everyone else** — plain OpenAI `/models`, Anthropic `/v1/models`, and the
 *   dozen OpenAI-compatible vendors — gives you an id and, if you are lucky, a
 *   display name. A local aggregator (9router) is the exception that proves the
 *   rule: it hangs a non-standard `capabilities` object off each row, and since
 *   that is a *report* rather than an inference, the OpenAI parser reads it when
 *   present and stays silent when it is not.
 *
 * So a catalog entry is mostly nulls, and that is the honest result: a null
 * price is "we do not know", never zero. `costs/compute.ts` treats the two
 * differently and a guessed zero would silently under-report spend.
 *
 * Parsing is defensive — upstream catalogs are third-party JSON that changes
 * without notice, and one malformed row must not lose the other four hundred.
 */
import type { ModelPricing, ProviderKind } from "@rewter/shared";
import { z } from "zod";
import type { ProviderPreset } from "../providers/presets.js";

/** One upstream model, normalized. Everything optional is genuinely unknown. */
export interface CatalogEntry {
  upstreamId: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  pricing: ModelPricing;
  modalities: ("text" | "image" | "audio" | "video")[];
  /** `null` = the upstream did not say. See `ModelSchema.supports`. */
  supports: {
    tools: boolean | null;
    streaming: boolean | null;
    vision: boolean | null;
    caching: boolean | null;
  };
}

export interface CatalogResult {
  entries: CatalogEntry[];
  /** Rows the upstream sent that we could not parse. Reported, never thrown. */
  skipped: number;
}

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null = null,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

export interface CatalogOptions {
  apiKey: string | null;
  baseUrl?: string | null;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

/**
 * Fetch and normalize a provider's catalog.
 *
 * `slug` selects the OpenRouter-specific parse; `kind` selects the wire dialect
 * for everyone else. They are separate because OpenRouter *is* an
 * openai-compat provider — it just answers `/models` with far more than the
 * format requires.
 */
export async function fetchCatalog(
  provider: { slug: string; kind: ProviderKind },
  opts: CatalogOptions,
): Promise<CatalogResult> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const url = catalogUrl(provider, opts);
  const res = await doFetch(url, {
    headers: catalogHeaders(provider.kind, opts.apiKey),
    ...(opts.signal !== undefined && { signal: opts.signal }),
  });
  if (!res.ok) {
    throw new CatalogError(`${provider.slug} catalog: HTTP ${res.status}`, res.status);
  }

  const body: unknown = await res.json();
  if (provider.slug === "openrouter") return parseOpenRouter(body);
  switch (provider.kind) {
    case "google":
      return parseGoogle(body);
    case "anthropic":
      return parseAnthropic(body);
    case "openai-compat":
      return parseOpenAi(body);
  }
}

/** Catalog endpoints, which are not always `<baseUrl>/models`. */
export function catalogUrl(
  provider: { slug: string; kind: ProviderKind },
  opts: { baseUrl?: string | null; apiKey?: string | null },
): string {
  const base = opts.baseUrl ?? defaultBase(provider.kind);
  if (provider.kind === "google") {
    // Google authenticates the catalog by query parameter, not header.
    const key = opts.apiKey ?? "";
    return `${trim(base)}/models${key === "" ? "" : `?key=${encodeURIComponent(key)}`}`;
  }
  return `${trim(base)}/models`;
}

function defaultBase(kind: ProviderKind): string {
  switch (kind) {
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "google":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "openai-compat":
      return "https://api.openai.com/v1";
  }
}

function trim(url: string): string {
  return url.replace(/\/+$/, "");
}

function catalogHeaders(kind: ProviderKind, apiKey: string | null): Record<string, string> {
  if (kind === "anthropic") {
    return {
      "anthropic-version": "2023-06-01",
      ...(apiKey !== null && { "x-api-key": apiKey }),
    };
  }
  // Google's key rides in the query string; a bearer header would be ignored.
  if (kind === "google") return {};
  return apiKey === null ? {} : { authorization: `Bearer ${apiKey}` };
}

// ── Per-upstream parsers ────────────────────────────────────────────────────

const OpenRouterModel = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  context_length: z.number().nullish(),
  pricing: z
    .object({
      prompt: z.string().optional(),
      completion: z.string().optional(),
      input_cache_read: z.string().optional(),
      input_cache_write: z.string().optional(),
    })
    .optional(),
  architecture: z
    .object({
      input_modalities: z.array(z.string()).optional(),
      modality: z.string().optional(),
    })
    .optional(),
  top_provider: z.object({ max_completion_tokens: z.number().nullish() }).optional(),
  supported_parameters: z.array(z.string()).optional(),
});

function parseOpenRouter(body: unknown): CatalogResult {
  return parseList(body, "data", (row) => {
    const m = OpenRouterModel.parse(row);
    const modalities = orModalities(m);
    const params = new Set(m.supported_parameters ?? []);
    return {
      upstreamId: m.id,
      displayName: m.name ?? m.id,
      contextWindow: positive(m.context_length),
      maxOutputTokens: positive(m.top_provider?.max_completion_tokens),
      pricing: {
        // OpenRouter prices per *token*; the registry stores per million.
        inputPerMTok: perMTok(m.pricing?.prompt),
        outputPerMTok: perMTok(m.pricing?.completion),
        cacheReadPerMTok: perMTok(m.pricing?.input_cache_read),
        cacheWritePerMTok: perMTok(m.pricing?.input_cache_write),
      },
      modalities,
      supports: {
        // An absent `supported_parameters` is silence, not a denial — the one
        // field here that is a report rather than an inference.
        tools: m.supported_parameters === undefined ? null : params.has("tools"),
        streaming: true,
        vision: modalities.includes("image"),
        // A non-null cache price is the only honest evidence of caching here.
        caching: perMTok(m.pricing?.input_cache_read) !== null,
      },
    };
  });
}

function orModalities(m: z.infer<typeof OpenRouterModel>): CatalogEntry["modalities"] {
  const raw = m.architecture?.input_modalities ?? m.architecture?.modality?.split("->")[0] ?? "";
  const list = Array.isArray(raw) ? raw : raw.split("+");
  const out = list
    .map((s) => s.trim())
    .filter((s): s is CatalogEntry["modalities"][number] =>
      ["text", "image", "audio", "video"].includes(s),
    );
  return out.length > 0 ? out : ["text"];
}

const GoogleModel = z.object({
  name: z.string().min(1),
  displayName: z.string().optional(),
  inputTokenLimit: z.number().nullish(),
  outputTokenLimit: z.number().nullish(),
  supportedGenerationMethods: z.array(z.string()).optional(),
});

function parseGoogle(body: unknown): CatalogResult {
  const result = parseList(body, "models", (row) => {
    const m = GoogleModel.parse(row);
    // Google returns `models/gemini-2.5-pro`; the upstream id is the tail.
    const id = m.name.startsWith("models/") ? m.name.slice("models/".length) : m.name;
    const methods = m.supportedGenerationMethods ?? [];
    return {
      upstreamId: id,
      displayName: m.displayName ?? id,
      contextWindow: positive(m.inputTokenLimit),
      maxOutputTokens: positive(m.outputTokenLimit),
      pricing: nullPricing(),
      modalities: ["text" as const],
      // Google's catalog carries no tool flag; every generateContent model has
      // function calling, and a model that cannot generate is not a chat model.
      supports: {
        tools: methods.includes("generateContent"),
        streaming: methods.includes("streamGenerateContent"),
        // Gemini is multimodal across the line, but the catalog does not say so
        // per model, and this file only records what an upstream reported.
        vision: null,
        caching: null,
      },
    };
  });
  // Embedding-only endpoints are in the same list and are not chat models.
  return { ...result, entries: result.entries.filter((e) => e.supports.tools === true) };
}

const AnthropicModel = z.object({
  id: z.string().min(1),
  display_name: z.string().optional(),
});

function parseAnthropic(body: unknown): CatalogResult {
  return parseList(body, "data", (row) => {
    const m = AnthropicModel.parse(row);
    return {
      upstreamId: m.id,
      displayName: m.display_name ?? m.id,
      contextWindow: null,
      maxOutputTokens: null,
      pricing: nullPricing(),
      modalities: ["text" as const],
      // Not reported either, but unlike the bare OpenAI catalog this is a fact
      // about a single vendor's whole line rather than about "any of a dozen
      // upstreams" — every Claude model does tools, vision and prompt caching.
      supports: { tools: true, streaming: true, vision: true, caching: true },
    };
  });
}

/**
 * `capabilities` is not in the OpenAI spec, but some servers in front of it —
 * 9router is the one this was written against — attach exactly the facts a bare
 * `/models` list is missing. Every field is optional: this is a superset of the
 * spec, so a server that omits the whole object parses as it always did.
 */
const OpenAiCapabilities = z
  .object({
    tools: z.boolean().optional(),
    vision: z.boolean().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutput: z.number().int().positive().optional(),
  })
  .passthrough();

const OpenAiModel = z.object({
  id: z.string().min(1),
  capabilities: OpenAiCapabilities.optional(),
});

function parseOpenAi(body: unknown): CatalogResult {
  return parseList(body, "data", (row) => {
    const m = OpenAiModel.parse(row);
    const caps = m.capabilities;
    return {
      upstreamId: m.id,
      displayName: m.id,
      contextWindow: caps?.contextWindow ?? null,
      maxOutputTokens: caps?.maxOutput ?? null,
      pricing: nullPricing(),
      modalities: caps?.vision === true ? (["text", "image"] as const) : (["text"] as const),
      // Unknown unless the row said otherwise. This parser serves a dozen
      // unrelated vendors — OpenAI, xAI, Z.AI, Ollama, LM Studio — from what is
      // usually an id list and nothing more, so there is no line-wide fact to
      // lean on the way the Anthropic parser can. A `capabilities` object is
      // the exception: it is a report, and `?? null` keeps the absent case
      // silent rather than promoting it to a denial. Enrichment fills the rest
      // where OpenRouter also lists the model, which for a local Ollama model
      // is never; the registry editor is the other way in.
      supports: {
        tools: caps?.tools ?? null,
        streaming: true,
        vision: caps?.vision ?? null,
        caching: null,
      },
    };
  });
}

/**
 * Pull `key` off the body and map each row, counting rather than throwing on
 * the ones that fail. A vendor adding a row shape we have never seen should
 * cost us that row, not the sync.
 */
function parseList(body: unknown, key: string, map: (row: unknown) => CatalogEntry): CatalogResult {
  const rows = (body as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(rows)) {
    throw new CatalogError(`catalog response has no "${key}" array`);
  }
  const entries: CatalogEntry[] = [];
  let skipped = 0;
  for (const row of rows) {
    try {
      entries.push(map(row));
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

function nullPricing(): ModelPricing {
  return {
    inputPerMTok: null,
    outputPerMTok: null,
    cacheReadPerMTok: null,
    cacheWritePerMTok: null,
  };
}

/**
 * OpenRouter prices are decimal strings per token. `"-1"` means "varies" and
 * `""`/absent means "unknown" — both become null. `"0"` is a real price: free.
 */
function perMTok(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  // Round to a millionth of a dollar: the product of a per-token string and 1e6
  // carries float noise, and the digest is byte-compared.
  return Number((n * 1_000_000).toFixed(6));
}

function positive(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Fill null fields on a catalog from OpenRouter's, which is the only upstream
 * that publishes prices. Anthropic's own `/v1/models` will never tell you what
 * Sonnet costs; OpenRouter lists it as `anthropic/claude-sonnet-4` with the
 * price attached.
 *
 * Matching is on the id **tail** (`anthropic/claude-sonnet-4` →
 * `claude-sonnet-4`), because the namespace is the aggregator's, not the
 * model's. Enrichment only ever fills a null: a value the upstream stated is
 * more authoritative than a third party's view of it, and a user's manual
 * pricing outranks both.
 */
export function enrichFromOpenRouter(
  entries: CatalogEntry[],
  openRouter: CatalogEntry[],
): CatalogEntry[] {
  const byTail = new Map<string, CatalogEntry>();
  for (const e of openRouter) {
    const tail = idTail(e.upstreamId);
    // First writer wins: OpenRouter's list is roughly canonical-first, and a
    // later `:free`/`:beta` variant should not overwrite the base model.
    if (!byTail.has(tail)) byTail.set(tail, e);
  }

  return entries.map((entry) => {
    const match = byTail.get(idTail(entry.upstreamId));
    if (match === undefined) return entry;
    return {
      ...entry,
      contextWindow: entry.contextWindow ?? match.contextWindow,
      maxOutputTokens: entry.maxOutputTokens ?? match.maxOutputTokens,
      pricing: {
        inputPerMTok: entry.pricing.inputPerMTok ?? match.pricing.inputPerMTok,
        outputPerMTok: entry.pricing.outputPerMTok ?? match.pricing.outputPerMTok,
        cacheReadPerMTok: entry.pricing.cacheReadPerMTok ?? match.pricing.cacheReadPerMTok,
        cacheWritePerMTok: entry.pricing.cacheWritePerMTok ?? match.pricing.cacheWritePerMTok,
      },
      // Same rule as pricing: fill an unknown, never contradict a report. It
      // used to be a disjunction (`a || b`) because a bare catalog's entries
      // were assumed `false`, and a third party's `true` deserved to win over
      // an assumption. Now that an unreported capability is `null`, `??` says
      // that directly — and `||` would be actively wrong, quietly reading
      // `null || false` as a denial.
      supports: {
        tools: entry.supports.tools ?? match.supports.tools,
        streaming: entry.supports.streaming ?? match.supports.streaming,
        vision: entry.supports.vision ?? match.supports.vision,
        caching: entry.supports.caching ?? match.supports.caching,
      },
      modalities: entry.modalities.length > 1 ? entry.modalities : match.modalities,
    };
  });
}

/** `openrouter/anthropic/claude-x:free` → `claude-x`. Variant suffix dropped. */
function idTail(id: string): string {
  const tail = id.slice(id.lastIndexOf("/") + 1);
  const colon = tail.indexOf(":");
  return (colon === -1 ? tail : tail.slice(0, colon)).toLowerCase();
}

/** Providers whose catalog we can read at all. */
export function canSync(preset: ProviderPreset | undefined): boolean {
  return preset?.listModels === true;
}
