/**
 * Catalog → registry. The policy layer above `catalog.ts`: which upstream
 * models become rows, and what happens to a row that already exists.
 *
 * The governing rule is that **sync never overwrites a human**. A model whose
 * `source` is `manual` came from the config file or the dashboard, and its
 * pricing is frequently the *corrected* pricing — the user typed it because the
 * upstream's number was absent or wrong. Sync fills gaps in those rows and
 * changes nothing else.
 *
 * The second rule is that **sync never deletes**. A model that disappears from
 * a catalog is disabled, not dropped: cost records and events reference it, and
 * a vendor's catalog blinking out for one request should not vaporize history.
 * `enabled: false` produces a 503 that names the model, which is the outcome
 * you want when a model is genuinely retired too.
 */
import { type Model, ModelIdSchema, type Provider } from "@rewter/shared";
import { presetForProvider, presetSlugForProvider } from "../providers/presets.js";
import {
  type CatalogEntry,
  type CatalogOptions,
  canSync,
  enrichFromOpenRouter,
  fetchCatalog,
} from "./catalog.js";

export interface SyncTarget {
  upsertModel(model: Model): Model;
  getModel(id: string): Model | undefined;
  listModels(opts?: { providerId?: string }): Model[];
}

export interface SyncOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
  signal?: AbortSignal;
  /**
   * Enrich thin catalogs with OpenRouter's prices and limits. Requires an
   * OpenRouter provider in the list — otherwise it is silently a no-op, since
   * enrichment is a bonus, not a precondition.
   */
  enrich?: boolean;
  /** Report without writing. */
  dryRun?: boolean;
}

export interface ProviderSyncReport {
  slug: string;
  added: string[];
  updated: string[];
  /** Present in the registry, gone from the catalog → disabled, never deleted. */
  disappeared: string[];
  /** Rows left alone because a human owns them. */
  skippedManual: string[];
  /** Catalog rows we could not parse. */
  malformed: number;
  error?: string;
}

export interface SyncReport {
  providers: ProviderSyncReport[];
  enrichedFromOpenRouter: boolean;
  dryRun: boolean;
}

/**
 * Sync every provider that publishes a catalog.
 *
 * A provider that fails is **recorded and stepped over**. Half a registry
 * refreshed beats none: one vendor rate-limiting you must not block the other
 * twenty-six, and the report says exactly who failed.
 */
export async function syncModels(
  target: SyncTarget,
  providers: Provider[],
  opts: SyncOptions = {},
): Promise<SyncReport> {
  const env = opts.env ?? process.env;
  const now = (opts.clock ?? Date.now)();
  const syncable = providers.filter((p) => p.enabled && canSync(presetForProvider(p)));

  let openRouter: CatalogEntry[] = [];
  if (opts.enrich === true) {
    const or = syncable.find((p) => presetSlugForProvider(p) === "openrouter");
    if (or !== undefined) {
      try {
        openRouter = (await readCatalog(or, env, opts)).entries;
      } catch {
        // Enrichment is a bonus. A failure here degrades the result; it does
        // not fail the sync, and the report's flag says it did not happen.
        openRouter = [];
      }
    }
  }

  const reports: ProviderSyncReport[] = [];
  for (const provider of syncable) {
    const slug = presetSlugForProvider(provider);
    try {
      const catalog = await readCatalog(provider, env, opts);
      const entries =
        openRouter.length > 0 && slug !== "openrouter"
          ? enrichFromOpenRouter(catalog.entries, openRouter)
          : catalog.entries;
      reports.push(applyCatalog(target, provider, slug, entries, catalog.skipped, now, opts));
    } catch (err) {
      reports.push({
        slug,
        added: [],
        updated: [],
        disappeared: [],
        skippedManual: [],
        malformed: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    providers: reports,
    enrichedFromOpenRouter: openRouter.length > 0,
    dryRun: opts.dryRun === true,
  };
}

async function readCatalog(provider: Provider, env: NodeJS.ProcessEnv, opts: SyncOptions) {
  const slug = presetSlugForProvider(provider);
  const preset = presetForProvider(provider);
  const apiKey = provider.apiKeyRef === null ? null : (env[provider.apiKeyRef] ?? null);
  const catalogOpts: CatalogOptions = {
    apiKey,
    baseUrl: provider.baseUrl ?? preset?.baseUrl ?? null,
    ...(opts.fetch !== undefined && { fetch: opts.fetch }),
    ...(opts.signal !== undefined && { signal: opts.signal }),
  };
  return await fetchCatalog({ slug, kind: provider.kind }, catalogOpts);
}

function applyCatalog(
  target: SyncTarget,
  provider: Provider,
  slug: string,
  entries: CatalogEntry[],
  malformed: number,
  now: number,
  opts: SyncOptions,
): ProviderSyncReport {
  const report: ProviderSyncReport = {
    slug,
    added: [],
    updated: [],
    disappeared: [],
    skippedManual: [],
    malformed,
  };
  const write = opts.dryRun !== true;
  const seen = new Set<string>();

  for (const entry of entries) {
    const parsed = ModelIdSchema.safeParse(`${slug}/${entry.upstreamId}`);
    // An upstream id with characters our slug format rejects is not addressable
    // through this router; counting it as malformed is more honest than
    // mangling it into an id the user cannot type.
    if (!parsed.success) {
      report.malformed += 1;
      continue;
    }
    const id = parsed.data;
    seen.add(id);

    const existing = target.getModel(id);
    if (existing === undefined) {
      const model: Model = {
        id,
        providerId: provider.id,
        upstreamId: entry.upstreamId,
        displayName: entry.displayName,
        contextWindow: entry.contextWindow,
        maxOutputTokens: entry.maxOutputTokens,
        pricing: entry.pricing,
        modalities: entry.modalities,
        supports: entry.supports,
        source: "synced",
        // New models arrive disabled: a catalog is hundreds of rows, and
        // enabling all of them silently would flood the digest the orchestrator
        // reads and bill against models the user never chose.
        enabled: false,
        createdAt: now,
        updatedAt: now,
      };
      if (write) target.upsertModel(model);
      report.added.push(id);
      continue;
    }

    const merged = mergeModel(existing, entry, provider, now);
    if (merged === undefined) {
      report.skippedManual.push(id);
      continue;
    }
    if (write) target.upsertModel(merged);
    report.updated.push(id);
  }

  for (const model of target.listModels({ providerId: provider.id })) {
    if (seen.has(model.id) || model.source === "manual" || !model.enabled) continue;
    if (write) target.upsertModel({ ...model, enabled: false, updatedAt: now });
    report.disappeared.push(model.id);
  }

  report.added.sort();
  report.updated.sort();
  report.disappeared.sort();
  report.skippedManual.sort();
  return report;
}

/**
 * Merge a catalog entry into an existing row, or return `undefined` when the
 * row is untouched.
 *
 * A `manual` row only ever gains facts it is missing — the user's stated
 * context window and prices stand, because they are usually a correction of the
 * upstream, not a copy of it. A `synced` row is refreshed wholesale except for
 * `enabled`, which is the user's switch and never sync's to flip.
 */
function mergeModel(
  existing: Model,
  entry: CatalogEntry,
  provider: Provider,
  now: number,
): Model | undefined {
  const next: Model =
    existing.source === "manual"
      ? {
          ...existing,
          contextWindow: existing.contextWindow ?? entry.contextWindow,
          maxOutputTokens: existing.maxOutputTokens ?? entry.maxOutputTokens,
          pricing: {
            inputPerMTok: existing.pricing.inputPerMTok ?? entry.pricing.inputPerMTok,
            outputPerMTok: existing.pricing.outputPerMTok ?? entry.pricing.outputPerMTok,
            cacheReadPerMTok: existing.pricing.cacheReadPerMTok ?? entry.pricing.cacheReadPerMTok,
            cacheWritePerMTok:
              existing.pricing.cacheWritePerMTok ?? entry.pricing.cacheWritePerMTok,
          },
          updatedAt: now,
        }
      : {
          ...existing,
          providerId: provider.id,
          upstreamId: entry.upstreamId,
          displayName: entry.displayName,
          contextWindow: entry.contextWindow,
          maxOutputTokens: entry.maxOutputTokens,
          pricing: entry.pricing,
          modalities: entry.modalities,
          supports: entry.supports,
          updatedAt: now,
        };

  // `updatedAt` alone is not a change: bumping it on every sync would churn
  // rows and make the report claim work that did not happen.
  return sameFacts(existing, next) ? undefined : next;
}

function sameFacts(a: Model, b: Model): boolean {
  return (
    a.upstreamId === b.upstreamId &&
    a.displayName === b.displayName &&
    a.contextWindow === b.contextWindow &&
    a.maxOutputTokens === b.maxOutputTokens &&
    JSON.stringify(a.pricing) === JSON.stringify(b.pricing) &&
    JSON.stringify(a.modalities) === JSON.stringify(b.modalities) &&
    JSON.stringify(a.supports) === JSON.stringify(b.supports)
  );
}

/** One-line-per-provider summary for the CLI. */
export function formatSyncReport(report: SyncReport): string {
  const lines = report.providers.map((p) => {
    if (p.error !== undefined) return `${p.slug}: failed — ${p.error}`;
    const bits = [
      `${p.added.length} added`,
      `${p.updated.length} updated`,
      ...(p.disappeared.length > 0 ? [`${p.disappeared.length} disabled (gone upstream)`] : []),
      ...(p.skippedManual.length > 0 ? [`${p.skippedManual.length} manual, left alone`] : []),
      ...(p.malformed > 0 ? [`${p.malformed} unreadable`] : []),
    ];
    return `${p.slug}: ${bits.join(", ")}`;
  });
  if (report.dryRun) lines.push("(dry run — nothing written)");
  else if (report.providers.some((p) => p.added.length > 0)) {
    lines.push("New models arrive disabled; enable the ones you want in the config or dashboard.");
  }
  return lines.join("\n");
}
