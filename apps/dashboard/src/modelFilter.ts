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
import type { CapabilityCard, Model } from "@rewter/shared";

/** `all` is a distinct state from a provider whose name happens to be empty. */
export interface ModelFilter {
  query: string;
  providerId: string | "all";
  enabled: "all" | "on" | "off";
}

export const emptyFilter = (): ModelFilter => ({
  query: "",
  providerId: "all",
  enabled: "all",
});

/** True when nothing is narrowed — lets the caller skip the "showing N of M". */
export const isUnfiltered = (filter: ModelFilter): boolean =>
  filter.query.trim() === "" && filter.providerId === "all" && filter.enabled === "all";

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
): Model[] {
  return models.filter((model) => {
    if (filter.providerId !== "all" && model.providerId !== filter.providerId) return false;
    if (filter.enabled === "on" && !model.enabled) return false;
    if (filter.enabled === "off" && model.enabled) return false;
    return matchesQuery(model, cards.get(model.id), filter.query);
  });
}
