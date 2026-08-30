/**
 * The registry editor's contract: what a human is allowed to change about a
 * model, and what changing it means.
 *
 * The interesting rule here is not the shapes — it is `applyModelPatch`. A row
 * whose facts came from a provider's catalog carries `source: "synced"`, and
 * the next `sync-models` refreshes it wholesale. So a hand-corrected price on a
 * `synced` row is not an edit, it is a countdown: it survives until the next
 * sync silently puts the upstream's number back, and the only visible symptom
 * is a cost report that stops matching the invoice. Editing a *fact* therefore
 * promotes the row to `source: "manual"`, which sync treats as authoritative
 * (see `registry/sync.ts`). That promotion is the whole point of the editor
 * existing rather than the user running `sqlite3` against the table.
 *
 * `enabled` is the exception, and deliberately so: sync already never flips it,
 * because it is the user's switch and not a fact about the model. Toggling a
 * model off should not quietly take its prices off the sync path forever.
 *
 * The comparison is by value, not by presence. A form that POSTs every field on
 * every save must not promote a row because the user opened it and pressed
 * Save — "I looked at this" is not "I know better than the catalog".
 */
import { z } from "zod";
import {
  CapabilityCardSchema,
  CapabilityTagSchema,
  type Model,
  ModelPricingSchema,
  ModelSchema,
} from "./entities.js";
import { ModelIdSchema, ProviderIdSchema } from "./ids.js";

const ModalitiesSchema = z.array(z.enum(["text", "image", "audio", "video"]));
/** Tri-state, matching `ModelSchema.supports`: `null` is "nobody reported it". */
const SupportsSchema = z.object({
  tools: z.boolean().nullable(),
  streaming: z.boolean().nullable(),
  vision: z.boolean().nullable(),
  caching: z.boolean().nullable(),
});

/**
 * A partial update. `.strict()` because a misspelled field in a PATCH body is
 * the one failure mode that looks like success: the request returns 200, the
 * row is unchanged, and the user believes the price is fixed.
 */
export const ModelPatchSchema = z
  .object({
    upstreamId: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    contextWindow: z.number().int().positive().nullable().optional(),
    maxOutputTokens: z.number().int().positive().nullable().optional(),
    pricing: ModelPricingSchema.optional(),
    modalities: ModalitiesSchema.optional(),
    supports: SupportsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type ModelPatch = z.infer<typeof ModelPatchSchema>;

/**
 * Creating a model by hand — the local-Ollama case, and the "provider ships a
 * model its own `/models` endpoint does not list" case. `source` is not a field
 * here: a row a human typed is `manual` by construction, and letting the body
 * claim `synced` would hand sync permission to overwrite it.
 */
export const ModelCreateSchema = z
  .object({
    id: ModelIdSchema,
    providerId: ProviderIdSchema,
    upstreamId: z.string().min(1),
    displayName: z.string().min(1),
    contextWindow: z.number().int().positive().nullable().default(null),
    maxOutputTokens: z.number().int().positive().nullable().default(null),
    pricing: ModelPricingSchema.default({
      inputPerMTok: null,
      outputPerMTok: null,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    }),
    modalities: ModalitiesSchema.default(["text"]),
    // Unknown by default rather than assumed. A create body that omits this is
    // someone adding a model in a hurry, not someone asserting it cannot see
    // images — and `vision: false` on the local vision model is how an OCR
    // subtask gets handed to a model that cannot do it.
    supports: SupportsSchema.default({
      tools: null,
      streaming: true,
      vision: null,
      caching: null,
    }),
    enabled: z.boolean().default(true),
  })
  .strict();
export type ModelCreate = z.infer<typeof ModelCreateSchema>;

/**
 * The user's patch over a generated capability card.
 *
 * Strict for a different reason than `ModelPatchSchema`: `mergeCardOverrides`
 * already refuses to let a patch rewrite `modelId`/`generatedBy`/`generatedAt`,
 * dropping them silently. Silence is right at merge time (a card in the DB must
 * never fail to render) and wrong at the API boundary, where a caller that
 * tried to rewrite provenance should be told no.
 */
export const CardOverridesSchema = z
  .object({
    summary: z.string().optional(),
    strengths: z.array(CapabilityTagSchema).optional(),
    weaknesses: z.array(CapabilityTagSchema).optional(),
    bestAt: z.array(CapabilityTagSchema).optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();
export type CardOverrides = z.infer<typeof CardOverridesSchema>;

/** `null` clears the patch, restoring the generated card verbatim. */
export const CardOverridesBodySchema = z.object({
  overrides: CardOverridesSchema.nullable(),
});

/**
 * What `GET /internal/models` answers with. Cards ride along because the editor
 * shows both on one row and a second round-trip per model would mean the page
 * renders prices before it renders what the model is *for* — which is the half
 * that actually steers the orchestrator.
 */
export const RegistryListSchema = z.object({
  models: z.array(ModelSchema),
  cards: z.array(CapabilityCardSchema),
});
export type RegistryList = z.infer<typeof RegistryListSchema>;

/** Everything except `enabled`: the fields sync would otherwise overwrite. */
const FACT_KEYS = [
  "upstreamId",
  "displayName",
  "contextWindow",
  "maxOutputTokens",
  "pricing",
  "modalities",
  "supports",
] as const;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * True when the patch actually changes a fact — the trigger for promoting a
 * `synced` row to `manual`. By value, not by presence: see the file header.
 */
export function promotesToManual(existing: Model, patch: ModelPatch): boolean {
  return FACT_KEYS.some((key) => patch[key] !== undefined && !same(existing[key], patch[key]));
}

/**
 * Apply a patch, or return `undefined` when nothing changed.
 *
 * The `undefined` return follows `registry/sync.ts`'s `mergeModel`: bumping
 * `updatedAt` for a save that changed nothing makes the row claim an edit that
 * never happened, and "last touched" is the column a user reads when trying to
 * work out why a price moved.
 */
export function applyModelPatch(
  existing: Model,
  patch: ModelPatch,
  now: number,
): Model | undefined {
  const promote = promotesToManual(existing, patch);
  const enabledChanged = patch.enabled !== undefined && patch.enabled !== existing.enabled;
  if (!promote && !enabledChanged) return undefined;

  return ModelSchema.parse({
    ...existing,
    ...(patch.upstreamId !== undefined && { upstreamId: patch.upstreamId }),
    ...(patch.displayName !== undefined && { displayName: patch.displayName }),
    ...(patch.contextWindow !== undefined && { contextWindow: patch.contextWindow }),
    ...(patch.maxOutputTokens !== undefined && { maxOutputTokens: patch.maxOutputTokens }),
    ...(patch.pricing !== undefined && { pricing: patch.pricing }),
    ...(patch.modalities !== undefined && { modalities: patch.modalities }),
    ...(patch.supports !== undefined && { supports: patch.supports }),
    ...(patch.enabled !== undefined && { enabled: patch.enabled }),
    // A fact edit takes the row off the sync path. An enable/disable does not.
    source: promote ? "manual" : existing.source,
    updatedAt: now,
  });
}
