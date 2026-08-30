/**
 * Executing an import plan, and reading a report out loud.
 *
 * The *decisions* live in `@rewter/shared`'s `planImport` — pure, and the same
 * function for a dry run and for the write, so a preview cannot describe
 * something other than what happens. What is left over is the part that needs a
 * database: turning a plan into rows. It lives here rather than inside the HTTP
 * route because the route is not the only caller — `rewter import-registry`
 * writes to the same database directly, whether or not a daemon is running, and
 * a second copy of the merge would be a second set of rules about `updatedAt`
 * and about the two card layers.
 */
import {
  type CapabilityCard,
  type ImportConflictMode,
  type Model,
  type RegistryBundle,
  type RegistryImportReport,
  planImport,
  summarizeDecisions,
} from "@rewter/shared";
import type { Repos } from "../db/repos.js";

export interface ApplyImportOptions {
  onConflict: ImportConflictMode;
  dryRun: boolean;
  /** Stamped on every row this import writes. */
  now: number;
}

/**
 * Merge a bundle into the registry and report every row's fate.
 *
 * Inherits sync's two rules — never overwrite a human (`skip` unless told
 * otherwise), never delete (a local model the bundle never mentions is not in
 * the plan at all) — and adds its own: never *create* a provider, because a
 * bundle carries no credentials, so an invented upstream would be a row that
 * fails later, further away, as a 503 from inside a task.
 */
export function applyImport(
  repos: Repos,
  bundle: RegistryBundle,
  opts: ApplyImportOptions,
): RegistryImportReport {
  const plan = planImport(
    bundle,
    { models: repos.listModels(), cards: repos.listCards(), providers: repos.listProviders() },
    opts.onConflict,
  );

  if (!opts.dryRun) {
    const models = new Map<string, Model>(bundle.models.map((m) => [m.id as string, m]));
    for (const d of plan.models) {
      if (d.outcome !== "added" && d.outcome !== "replaced") continue;
      const model = models.get(d.id);
      if (model === undefined) continue;
      // `updatedAt` is now, not the exporting machine's clock: the row was
      // written here, at this moment, and "last touched" is the column read when
      // working out why a price moved. `createdAt` is left as the bundle's, so a
      // model keeps the age it was given.
      repos.upsertModel({ ...model, updatedAt: opts.now });
    }

    const cards = new Map<string, CapabilityCard>(
      bundle.cards.map((c) => [c.modelId as string, c]),
    );
    for (const d of plan.cards) {
      if (d.outcome !== "added" && d.outcome !== "replaced") continue;
      const card = cards.get(d.id);
      if (card === undefined) continue;
      // Two writes, because the repo splits a card into two layers that never
      // touch each other: `upsertCard` deliberately leaves `userOverrides` alone
      // (so a regeneration cannot clobber a correction), which means importing
      // one takes the second call.
      repos.upsertCard({ ...card, userOverrides: null, updatedAt: opts.now });
      if (card.userOverrides !== null) repos.setCardOverrides(card.modelId, card.userOverrides);
    }
  }

  return { dryRun: opts.dryRun, onConflict: opts.onConflict, ...plan };
}

/**
 * The report, for a terminal.
 *
 * Missing providers get their own lines above the counts even though they are
 * also counted in them, for the reason the schema says: they are the only
 * outcome here with a fix, and fourteen identical `no_provider` rows is a wall
 * where "OpenRouter isn't configured here" is an instruction.
 */
export function formatImportReport(report: RegistryImportReport): string {
  const lines = [
    `models: ${summarizeDecisions(report.models)}`,
    `cards: ${summarizeDecisions(report.cards)}`,
  ];
  for (const p of report.missingProviders) {
    lines.push(
      `${p.name} (${p.id}) is not configured here — ${p.modelCount} ${
        p.modelCount === 1 ? "model" : "models"
      } skipped`,
    );
  }
  if (report.missingProviders.length > 0) {
    lines.push("Add the provider and import again; an import never creates one.");
  }
  if (report.dryRun) lines.push("(dry run — nothing written)");
  else if (report.onConflict === "skip" && report.models.some((d) => d.outcome === "exists")) {
    lines.push("Models already here were left alone; pass --overwrite to replace them.");
  }
  return lines.join("\n");
}
