/**
 * Moving a registry between machines.
 *
 * The registry is the one part of rewter that is genuinely *worked on*: prices
 * corrected by hand, models the catalog never listed, capability cards written
 * by a model and then argued with. All of it lives in one SQLite file on one
 * laptop, and the only way to have it somewhere else today is to redo it. This
 * is the file format for not redoing it.
 *
 * Two rules govern the whole design, and both are inherited rather than
 * invented — they are `registry/sync.ts`'s rules, because an import is the same
 * problem sync already solved: merging somebody else's idea of the catalog into
 * a table a human has been editing.
 *
 *   1. **Never overwrite a human.** A model that exists here is left alone
 *      unless the caller explicitly asks for `overwrite`. An import is
 *      therefore idempotent by default, and running one twice cannot destroy
 *      work done between the two runs.
 *   2. **Never delete.** Models on this machine that the bundle has never heard
 *      of stay exactly where they are. Cost records name model ids forever (see
 *      the delete route), and an import is not a reason to lose history.
 *
 * And one rule of its own: **a bundle carries no credentials, structurally.**
 * `apiKeyRef` is an env-var *name*, not a key — but it is still a fact about
 * how *this* machine authenticates, and it is not needed to describe a model.
 * So provider entries here carry identity only (`id`, `name`, `kind`,
 * `baseUrl`), and there is no field an exporter could put a secret in even by
 * accident. The bundle says which provider a model belongs to so that an import
 * can explain itself; it says nothing about how to log in to it.
 *
 * That last rule is why importing never *creates* a provider. A bundle naming
 * `prv_openrou…` on a machine that has no OpenRouter configured produces a
 * skipped model with that provider named in the reason — not a half-configured
 * upstream with no key, which would fail later, further away, as a 503 from
 * inside a task.
 */
import { z } from "zod";
import {
  type CapabilityCard,
  CapabilityCardSchema,
  type Model,
  ModelSchema,
  type Provider,
  ProviderKindSchema,
} from "./entities.js";
import { ProviderIdSchema } from "./ids.js";

/**
 * Bumped when the shape changes incompatibly. An import refuses a version it
 * does not know rather than parsing what it can: a bundle from a future rewter
 * whose fields moved would import as a pile of silent defaults, and the failure
 * would surface as a model that routes wrong rather than as a file that would
 * not load.
 */
export const REGISTRY_BUNDLE_VERSION = 1;

/**
 * Identity only. See the file header: this is deliberately not `ProviderSchema`
 * minus a field, it is its own shape, so that adding a column to providers can
 * never widen what an export carries.
 */
export const BundleProviderSchema = z
  .object({
    id: ProviderIdSchema,
    name: z.string().min(1),
    kind: ProviderKindSchema,
    baseUrl: z.string().url().nullable(),
  })
  .strict();
export type BundleProvider = z.infer<typeof BundleProviderSchema>;

export const RegistryBundleSchema = z.object({
  version: z.literal(REGISTRY_BUNDLE_VERSION),
  exportedAt: z.number().int().nonnegative(),
  /** Free-text, for a human opening the file in a year. Never interpreted. */
  note: z.string().nullable().default(null),
  providers: z.array(BundleProviderSchema),
  models: z.array(ModelSchema),
  /**
   * Cards are exported **raw** — generated fields and `userOverrides` as two
   * separate layers, exactly as stored. The merged view would be lossy in the
   * way that matters most: it is the overrides that were typed by a person, and
   * flattening them into the generated text means the next `rewter card` on the
   * far machine silently discards them.
   */
  cards: z.array(CapabilityCardSchema),
});
export type RegistryBundle = z.infer<typeof RegistryBundleSchema>;

/** What an import does when a row is already here. */
export const ImportConflictModeSchema = z.enum(["skip", "overwrite"]);
export type ImportConflictMode = z.infer<typeof ImportConflictModeSchema>;

export const RegistryImportRequestSchema = z.object({
  bundle: RegistryBundleSchema,
  /** Default `skip`: the safe half of rule 1, chosen when nobody chose. */
  onConflict: ImportConflictModeSchema.default("skip"),
  /** Report what would happen and write nothing. */
  dryRun: z.boolean().default(false),
});
export type RegistryImportRequest = z.infer<typeof RegistryImportRequestSchema>;

/**
 * Why one row did what it did.
 *
 * Every outcome names the row, so the report reads as a list of decisions
 * rather than a pair of counts. OmniRoute's import wizard reports per-row
 * errors and a skipped count for the same reason: a bulk operation that
 * summarises to "47 imported, 12 skipped" leaves the operator unable to tell a
 * duplicate from a misconfiguration.
 */
export const ImportOutcomeSchema = z.enum([
  /** Not here before; written. */
  "added",
  /** Here already, `overwrite` asked for; replaced. */
  "replaced",
  /** Here already, `skip` in force; untouched. */
  "exists",
  /** Its provider is not configured on this machine. */
  "no_provider",
  /** A card whose model neither exists here nor arrived in this bundle. */
  "no_model",
]);
export type ImportOutcome = z.infer<typeof ImportOutcomeSchema>;

export const ImportDecisionSchema = z.object({
  id: z.string(),
  outcome: ImportOutcomeSchema,
  /** Set for the outcomes that need one; a plain `added` explains itself. */
  reason: z.string().nullable(),
});
export type ImportDecision = z.infer<typeof ImportDecisionSchema>;

export const RegistryImportReportSchema = z.object({
  dryRun: z.boolean(),
  onConflict: ImportConflictModeSchema,
  models: z.array(ImportDecisionSchema),
  cards: z.array(ImportDecisionSchema),
  /**
   * Providers named by the bundle that this machine does not have, each with
   * the count of models it took down with it. The actionable half of a failed
   * import: "configure OpenRouter and run this again" is a fix, whereas
   * fourteen identical `no_provider` lines is a wall.
   */
  missingProviders: z.array(
    z.object({ id: z.string(), name: z.string(), modelCount: z.number().int().nonnegative() }),
  ),
});
export type RegistryImportReport = z.infer<typeof RegistryImportReportSchema>;

/** What the planner needs to know about this machine. */
export interface LocalRegistry {
  models: Model[];
  cards: CapabilityCard[];
  providers: Pick<Provider, "id">[];
}

/**
 * Build the bundle. Separate from the route so the CLI and the dashboard's
 * download button produce byte-identical files, and so the "no credentials"
 * claim is testable in one place.
 */
export function buildBundle(
  input: { providers: Provider[]; models: Model[]; cards: CapabilityCard[] },
  opts: { now: number; note?: string | null },
): RegistryBundle {
  // Only providers something references. An export is a description of these
  // models; a provider with nothing in the registry is this machine's setup,
  // not part of what is being described.
  const referenced = new Set(input.models.map((m) => m.providerId));
  return RegistryBundleSchema.parse({
    version: REGISTRY_BUNDLE_VERSION,
    exportedAt: opts.now,
    note: opts.note ?? null,
    providers: input.providers
      .filter((p) => referenced.has(p.id))
      // Field-by-field, not a spread with deletions: a spread would carry any
      // column added to Provider later, which is exactly how a secret ends up
      // in a file whose header promises there are none.
      .map((p) => ({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl })),
    models: input.models,
    cards: input.cards,
  });
}

/**
 * Decide every row's fate without touching a database.
 *
 * Pure so that the same function answers `dryRun` and the real thing — a
 * preview that ran different logic from the write would be a preview of
 * nothing. The server executes this plan; it does not re-derive it.
 */
export function planImport(
  bundle: RegistryBundle,
  local: LocalRegistry,
  onConflict: ImportConflictMode,
): Pick<RegistryImportReport, "models" | "cards" | "missingProviders"> {
  // Plain `string` sets, not the branded types: ids arriving from a file are
  // strings until a schema says otherwise, and the plan is a comparison of
  // names, not an assertion that either side is valid.
  const localProviders = new Set<string>(local.providers.map((p) => p.id));
  const localModels = new Set<string>(local.models.map((m) => m.id));
  const localCards = new Set<string>(local.cards.map((c) => c.modelId));
  const bundleProviders = new Map(bundle.providers.map((p) => [p.id as string, p]));

  const missing = new Map<string, { id: string; name: string; modelCount: number }>();

  const models: ImportDecision[] = bundle.models.map((model) => {
    if (!localProviders.has(model.providerId)) {
      const named = bundleProviders.get(model.providerId);
      const name = named?.name ?? model.providerId;
      const entry = missing.get(model.providerId) ?? { id: model.providerId, name, modelCount: 0 };
      entry.modelCount += 1;
      missing.set(model.providerId, entry);
      return {
        id: model.id,
        outcome: "no_provider",
        reason: `no provider ${name} (${model.providerId}) on this machine`,
      };
    }
    if (!localModels.has(model.id)) return { id: model.id, outcome: "added", reason: null };
    return onConflict === "overwrite"
      ? { id: model.id, outcome: "replaced", reason: null }
      : {
          id: model.id,
          outcome: "exists",
          reason: "already here — import with overwrite to replace",
        };
  });

  // A card can land on a model that arrived in this same bundle, so the set of
  // acceptable model ids is the local ones *plus* everything the plan above
  // decided to write. `exists` counts too: the model is here either way, and a
  // machine that has the model but not its card is precisely the case where
  // importing the card is pure gain.
  const willHaveModel = new Set(localModels);
  for (const d of models) {
    if (d.outcome === "added" || d.outcome === "replaced") willHaveModel.add(d.id);
  }

  const cards: ImportDecision[] = bundle.cards.map((card) => {
    if (!willHaveModel.has(card.modelId)) {
      return {
        id: card.modelId,
        outcome: "no_model",
        reason: `no model ${card.modelId} here, and the bundle did not bring one`,
      };
    }
    if (!localCards.has(card.modelId)) return { id: card.modelId, outcome: "added", reason: null };
    return onConflict === "overwrite"
      ? { id: card.modelId, outcome: "replaced", reason: null }
      : {
          id: card.modelId,
          outcome: "exists",
          reason: "already here — import with overwrite to replace",
        };
  });

  return { models, cards, missingProviders: [...missing.values()] };
}

/** `12 added, 3 replaced, 1 skipped` — the one-line version, for a CLI or a toast. */
export function summarizeDecisions(decisions: ImportDecision[]): string {
  const counts = new Map<ImportOutcome, number>();
  for (const d of decisions) counts.set(d.outcome, (counts.get(d.outcome) ?? 0) + 1);
  const parts: string[] = [];
  const label: Record<ImportOutcome, string> = {
    added: "added",
    replaced: "replaced",
    exists: "already here",
    no_provider: "no provider",
    no_model: "no model",
  };
  for (const outcome of ImportOutcomeSchema.options) {
    const n = counts.get(outcome);
    if (n !== undefined && n > 0) parts.push(`${n} ${label[outcome]}`);
  }
  return parts.length === 0 ? "nothing" : parts.join(", ");
}
