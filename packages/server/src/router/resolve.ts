/**
 * Model resolution: an incoming `model` string → the registry row, its provider,
 * and the upstream id to send.
 *
 * Clients name models loosely. Claude Code sends `claude-sonnet-5`; a curl user
 * copies `anthropic/claude-sonnet-5` off the dashboard; someone with two keys
 * for the same weights wants `openrouter/anthropic/claude-sonnet-5`. All three
 * should work, but only where the answer is unambiguous — a bare name matching
 * models on two providers is an error the caller must disambiguate, not a coin
 * flip that silently bills the wrong account.
 */
import type { Model, Provider } from "@rewter/shared";

/** Pseudo-model names that divert to the orchestrator engine (M5). */
export const ORCHESTRATOR_MODEL = "auto/orchestrator";

export class ModelNotFoundError extends Error {
  constructor(readonly requested: string) {
    super(`unknown model: ${requested}`);
    this.name = "ModelNotFoundError";
  }
}

export class AmbiguousModelError extends Error {
  constructor(
    readonly requested: string,
    readonly candidates: string[],
  ) {
    super(
      `model "${requested}" is ambiguous — matches ${candidates.join(", ")}; use the fully-qualified id`,
    );
    this.name = "AmbiguousModelError";
  }
}

export class ProviderDisabledError extends Error {
  constructor(readonly modelId: string) {
    super(`model "${modelId}" resolves to a disabled provider`);
    this.name = "ProviderDisabledError";
  }
}

export interface Resolution {
  model: Model;
  provider: Provider;
  /** What actually goes on the wire — may differ from our slug. */
  upstreamId: string;
}

export interface Registry {
  listModels(opts?: { enabledOnly?: boolean }): Model[];
  getProvider(id: string): Provider | undefined;
}

/**
 * Is this the orchestrator pseudo-model? Accepts `auto`, `auto/orchestrator`,
 * and `auto/orchestrator:<modelId>` (pinning the initiator).
 */
export function isOrchestratorModel(requested: string): boolean {
  return (
    requested === "auto" ||
    requested === ORCHESTRATOR_MODEL ||
    requested.startsWith(`${ORCHESTRATOR_MODEL}:`)
  );
}

/** The pinned initiator from `auto/orchestrator:<modelId>`, if any. */
export function pinnedInitiator(requested: string): string | null {
  if (!requested.startsWith(`${ORCHESTRATOR_MODEL}:`)) return null;
  const pinned = requested.slice(ORCHESTRATOR_MODEL.length + 1);
  return pinned === "" ? null : pinned;
}

export function resolveModel(registry: Registry, requested: string): Resolution {
  const enabled = registry.listModels({ enabledOnly: true });

  // 1. Exact id — always wins, and is the only form that can't be ambiguous.
  const exact = enabled.find((m) => m.id === requested);
  const matches = exact !== undefined ? [exact] : matchLoosely(enabled, requested);

  if (matches.length === 0) throw new ModelNotFoundError(requested);
  if (matches.length > 1) {
    throw new AmbiguousModelError(
      requested,
      matches.map((m) => m.id),
    );
  }

  const model = matches[0] as Model;
  const provider = registry.getProvider(model.providerId);
  if (provider === undefined || !provider.enabled) throw new ProviderDisabledError(model.id);

  return { model, provider, upstreamId: model.upstreamId };
}

/**
 * Fallbacks, in decreasing confidence. Each tier is tried whole: if the
 * bare-name tier yields two hits we report ambiguity rather than dropping to a
 * fuzzier tier that might yield one — a coincidence is not a disambiguation.
 */
function matchLoosely(models: Model[], requested: string): Model[] {
  const wanted = requested.toLowerCase();

  // 2. The upstream id exactly (what the vendor's own docs call it).
  const byUpstream = models.filter((m) => m.upstreamId.toLowerCase() === wanted);
  if (byUpstream.length > 0) return byUpstream;

  // 3. Bare name — the segment after the provider namespace.
  const byBareName = models.filter((m) => bareName(m.id) === wanted);
  if (byBareName.length > 0) return byBareName;

  // 4. Suffix match, so `openrouter/anthropic/claude-x` finds `anthropic/claude-x`
  //    and vice versa. Anchored on a `/` so `sonnet-5` never matches `not-sonnet-5`.
  return models.filter(
    (m) => m.id.toLowerCase().endsWith(`/${wanted}`) || wanted.endsWith(`/${m.id.toLowerCase()}`),
  );
}

function bareName(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return (slash === -1 ? modelId : modelId.slice(slash + 1)).toLowerCase();
}
