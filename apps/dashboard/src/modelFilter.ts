/**
 * Narrowing the registry table.
 *
 * This became necessary the moment a local aggregator was a supported provider:
 * pointing rewter at a running 9router turns one preset into a hundred-plus
 * models, and a hundred-row table with no way to narrow it is a list you scroll
 * past rather than a registry you edit. The panel's own docstring says the
 * reason to open it is usually *one* row — until now nothing helped you find it.
 *
 * Kept out of the component and pure so the matching rules are provable on
 * their own. Two of them are not obvious:
 *
 * - The query matches the *full* id, not the shortened display form. A registry
 *   holding `zai/glm-5.3` and `9router/glm/glm-5.3` renders both as something
 *   ending `glm-5.3`, and typing the provider is the only way a user can tell
 *   them apart. Matching what is on screen would make that impossible.
 * - It also matches a card's `bestAt` tags, because "which of my models is good
 *   at OCR" is the question the registry is for, and the tags are the answer the
 *   orchestrator itself reads.
 */
import type { Model, Provider } from "@rewter/shared";
import type { CapabilityCard } from "@rewter/shared";

/**
 * The four facts about a model worth counting at a glance.
 *
 * Not a copy of anyone else's taxonomy — a hosted catalog sorts by vendor and
 * modality because those are the axes along which its users choose. rewter's
 * users have already chosen; what they cannot see from a hundred-row table is
 * how much of that table costs money and how much of it is running on their own
 * machine. Hence: local, and the three pricing states.
 *
 * `unpriced` earns a chip of its own rather than being folded into `free`
 * because they are opposite facts wearing the same `$0`: a local model costs
 * nothing, and an unpriced one costs an amount nobody has told us. The costs
 * panel bills the second as zero, so being able to count them is how you find
 * out your spend figure is fiction.
 */
export type ModelCategory = "local" | "free" | "paid" | "unpriced";

export const MODEL_CATEGORIES: ModelCategory[] = ["local", "free", "paid", "unpriced"];

/** `all` is a distinct state from a provider whose name happens to be empty. */
export interface ModelFilter {
  query: string;
  providerId: string | "all";
  enabled: "all" | "on" | "off";
  category: ModelCategory | "all";
}

export const emptyFilter = (): ModelFilter => ({
  query: "",
  providerId: "all",
  enabled: "all",
  category: "all",
});

/** True when nothing is narrowed — lets the caller skip the "showing N of M". */
export const isUnfiltered = (filter: ModelFilter): boolean =>
  filter.query.trim() === "" &&
  filter.providerId === "all" &&
  filter.enabled === "all" &&
  filter.category === "all";

/**
 * Providers that need no key — which is what "local" means here.
 *
 * Derived rather than stored: every local preset (`ollama`, `lmstudio`,
 * `llamacpp`, `vllm`, and a 9router next door) has `apiKeyEnv: null`, because a
 * runtime you started yourself has nobody to authenticate you to. A hand-added
 * keyless provider lands in the same bucket, and that is right — it is also
 * something the operator is running.
 */
export const localProviderIds = (providers: readonly Provider[]): Set<string> =>
  new Set(providers.filter((p) => p.apiKeyRef === null).map((p) => p.id));

/**
 * Which pricing state a row is in — total over the three, never ambiguous.
 *
 * A row with one price known and one missing counts as `paid`: something about
 * it bills, and calling it free on the strength of the half we happen to know is
 * how a surprise arrives.
 */
function pricingOf(model: Model): "free" | "paid" | "unpriced" {
  const prices = [model.pricing.inputPerMTok, model.pricing.outputPerMTok];
  const known = prices.filter((p): p is number => p !== null);
  if (known.length === 0) return "unpriced";
  return known.every((p) => p === 0) ? "free" : "paid";
}

/** A model can be both `local` and `free`; the two axes are independent. */
export function categoriesOf(model: Model, local: ReadonlySet<string>): Set<ModelCategory> {
  const set = new Set<ModelCategory>([pricingOf(model)]);
  if (local.has(model.providerId)) set.add("local");
  return set;
}

/** Counts for the chips. Always all four keys, so a zero renders as a zero. */
export function countCategories(
  models: readonly Model[],
  local: ReadonlySet<string>,
): Record<ModelCategory, number> {
  const counts: Record<ModelCategory, number> = { local: 0, free: 0, paid: 0, unpriced: 0 };
  for (const model of models) {
    for (const category of categoriesOf(model, local)) counts[category] += 1;
  }
  return counts;
}

function matchesQuery(model: Model, card: CapabilityCard | undefined, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  if (model.id.toLowerCase().includes(needle)) return true;
  if (model.displayName.toLowerCase().includes(needle)) return true;
  // `bestAt` comes from a fixed vocabulary, so a user who types `ocr` is typing
  // the same token the digest renders and the initiator reads.
  return card?.bestAt.some((tag) => tag.toLowerCase().includes(needle)) === true;
}

/**
 * Order is preserved, not re-sorted by relevance. The table's order is the
 * daemon's, and a row jumping to the top mid-keystroke moves the Edit button
 * out from under the pointer.
 */
export function filterModels(
  models: readonly Model[],
  cards: ReadonlyMap<string, CapabilityCard>,
  filter: ModelFilter,
  /** Which providers are keyless; omitted, no row can be `local`. */
  local: ReadonlySet<string> = new Set(),
): Model[] {
  return models.filter((model) => {
    if (filter.providerId !== "all" && model.providerId !== filter.providerId) return false;
    if (filter.enabled === "on" && !model.enabled) return false;
    if (filter.enabled === "off" && model.enabled) return false;
    if (filter.category !== "all" && !categoriesOf(model, local).has(filter.category)) return false;
    return matchesQuery(model, cards.get(model.id), filter.query);
  });
}
