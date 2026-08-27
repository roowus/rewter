/**
 * Config → registry. Turns the `providers`/`models` arrays of a config file
 * into Provider and Model rows.
 *
 * Seeding is **idempotent and keyed by slug**: re-running with the same config
 * updates rows in place rather than minting new ids, so restarting the daemon
 * never orphans the cost records and events that reference a provider. That is
 * the same property M4's `sync-models` needs, arrived at one milestone early.
 *
 * A provider whose key env var is unset is seeded **disabled** rather than
 * skipped. A disabled provider produces a loud 503 naming the model; a missing
 * one produces "unknown model", which sends you looking in the wrong place.
 */
import { type Model, ModelIdSchema, type ModelPricing, type Provider } from "@rewter/shared";
import { getPreset, providerIdForSlug } from "../providers/presets.js";
import type { ModelConfig, ProviderConfig } from "./config.js";

// The slug → id derivation lives with the presets, because it is what makes a
// provider's id invertible back to its slug (`presetSlugForProvider`). Re-export
// it here: seeding is where callers first meet it.
export { providerIdForSlug };

export interface SeedTarget {
  upsertProvider(provider: Provider): Provider;
  upsertModel(model: Model): Model;
  getProvider(id: string): Provider | undefined;
  getModel(id: string): Model | undefined;
}

export interface SeedOptions {
  providers: ProviderConfig[];
  models: ModelConfig[];
  env?: NodeJS.ProcessEnv;
  clock?: () => number;
}

export interface SeedResult {
  providers: Provider[];
  models: Model[];
  /** Non-fatal problems: unknown preset, model naming a provider we don't have. */
  warnings: string[];
  /** Providers seeded disabled because their key env var is unset. */
  missingKeys: { slug: string; env: string }[];
}

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedError";
  }
}

export function seedRegistry(target: SeedTarget, opts: SeedOptions): SeedResult {
  const env = opts.env ?? process.env;
  const now = (opts.clock ?? Date.now)();
  const warnings: string[] = [];
  const missingKeys: { slug: string; env: string }[] = [];
  const bySlug = new Map<string, Provider>();

  for (const pc of opts.providers) {
    const preset = pc.preset === undefined ? undefined : getPreset(pc.preset);
    if (pc.preset !== undefined && preset === undefined) {
      warnings.push(`unknown provider preset "${pc.preset}" — skipped`);
      continue;
    }
    const slug = pc.slug ?? preset?.slug;
    const kind = pc.kind ?? preset?.kind;
    if (slug === undefined || kind === undefined) {
      warnings.push("provider entry has neither a known preset nor slug+kind — skipped");
      continue;
    }
    if (bySlug.has(slug)) throw new SeedError(`duplicate provider slug: ${slug}`);

    const apiKeyRef = pc.apiKeyEnv === undefined ? (preset?.apiKeyEnv ?? null) : pc.apiKeyEnv;
    // Local runtimes need no key; everyone else does, and an unset one means
    // this provider cannot serve a request no matter what the config claims.
    const needsKey = apiKeyRef !== null && preset?.local !== true;
    const haveKey = !needsKey || (env[apiKeyRef] !== undefined && env[apiKeyRef] !== "");
    if (!haveKey && apiKeyRef !== null) missingKeys.push({ slug, env: apiKeyRef });

    const id = providerIdForSlug(slug);
    const existing = target.getProvider(id);
    const provider: Provider = {
      id,
      name: pc.name ?? preset?.name ?? slug,
      kind,
      baseUrl: pc.baseUrl === undefined ? (preset?.baseUrl ?? null) : pc.baseUrl,
      apiKeyRef,
      enabled: pc.enabled && haveKey,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    bySlug.set(slug, target.upsertProvider(provider));
  }

  const models: Model[] = [];
  for (const mc of opts.models) {
    const provider = bySlug.get(mc.provider);
    if (provider === undefined) {
      warnings.push(`model "${mc.id}" names unknown provider "${mc.provider}" — skipped`);
      continue;
    }
    const id = ModelIdSchema.parse(mc.id);
    const existing = target.getModel(id);
    const model: Model = {
      id,
      providerId: provider.id,
      upstreamId: mc.upstreamId ?? id.slice(id.lastIndexOf("/") + 1),
      displayName: mc.displayName ?? id,
      contextWindow: mc.contextWindow,
      maxOutputTokens: mc.maxOutputTokens,
      pricing: toPricing(mc.pricing),
      modalities: mc.modalities,
      supports: mc.supports,
      source: "manual",
      enabled: mc.enabled,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    models.push(target.upsertModel(model));
  }

  return { providers: [...bySlug.values()], models, warnings, missingKeys };
}

/** An omitted price is unknown (null), never zero — see costs/compute.ts. */
function toPricing(
  partial: { [K in keyof ModelPricing]?: ModelPricing[K] | undefined },
): ModelPricing {
  return {
    inputPerMTok: partial.inputPerMTok ?? null,
    outputPerMTok: partial.outputPerMTok ?? null,
    cacheReadPerMTok: partial.cacheReadPerMTok ?? null,
    cacheWritePerMTok: partial.cacheWritePerMTok ?? null,
  };
}
