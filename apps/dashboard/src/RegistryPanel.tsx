/**
 * The registry editor.
 *
 * The reason this exists rather than the user running `sqlite3` against the
 * table is one rule, and the UI's job is mostly to make that rule legible: a
 * row whose facts came from a provider's catalog is `synced`, and the next
 * `sync-models` refreshes it wholesale. A hand-corrected price on such a row is
 * not an edit, it is a countdown. So editing a *fact* promotes the row to
 * `manual` — and the form says so before you save, because a promotion that
 * happens silently is a model that quietly stops tracking its provider's
 * prices, which nobody discovers until a price change never arrives.
 *
 * `enabled` is the exception and gets its own control for exactly that reason:
 * a toggle is the user's switch, not a claim about the model, and turning one
 * off must not take its prices off the sync path forever.
 *
 * Everything is expanded on demand. A registry is dozens of rows and the reason
 * to open this page is usually one of them — which is what the filter row is
 * for. It stopped being optional when a local aggregator became a supported
 * provider: one 9router preset is a hundred-plus models, and an unnarrowable
 * hundred-row table is a list you scroll past rather than a registry you edit.
 */
import type { CapabilityCard, Model, Provider } from "@rewter/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ModelEditor } from "./ModelEditor.js";
import { RegistryTransfer } from "./RegistryTransfer.js";
import { shortModelId, usd } from "./format.js";
import {
  MODEL_CATEGORIES,
  type ModelCategory,
  type ModelFilter,
  countCategories,
  emptyFilter,
  filterModels,
  isUnfiltered,
  localProviderIds,
} from "./modelFilter.js";
import { type Result, fetchProviders, fetchRegistry } from "./registry.js";

/** `$3/$15 per MTok`, or an honest gap. Unpriced is a real state: a local */
/** Ollama model costs nothing, and rendering that as `$0` hides the */
/** difference from "we never learned this price". */
function priceLabel(model: Model): string {
  const { inputPerMTok, outputPerMTok } = model.pricing;
  if (inputPerMTok === null && outputPerMTok === null) return "unpriced";
  return `${inputPerMTok === null ? "—" : usd(inputPerMTok)} / ${
    outputPerMTok === null ? "—" : usd(outputPerMTok)
  }`;
}

const contextLabel = (model: Model): string =>
  model.contextWindow === null ? "—" : `${Math.round(model.contextWindow / 1000)}K`;

export function RegistryPanel(): JSX.Element {
  const [models, setModels] = useState<Model[] | null>(null);
  const [cards, setCards] = useState<Map<string, CapabilityCard>>(new Map());
  const [providers, setProviders] = useState<Provider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<ModelFilter>(emptyFilter);

  const load = useCallback(async (signal?: AbortSignal) => {
    const [registry, provs] = await Promise.all([
      fetchRegistry(fetch, signal),
      fetchProviders(fetch, signal),
    ]);
    if (signal?.aborted === true) return;
    if (registry.ok) {
      setModels(registry.value.models);
      setCards(new Map(registry.value.cards.map((card) => [card.modelId, card])));
      setError(null);
    } else if (registry.message !== "aborted") {
      // Keep whatever is on screen. A registry that empties on a transient
      // failure reads as "no models configured", which is a very different
      // problem from "could not reach the daemon".
      setError(registry.message);
    }
    if (provs.ok) setProviders(provs.value);
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [open, load]);

  /** After any write: re-read rather than patch local state. The daemon is the
      one that decides what a patch did — including deciding it did nothing. */
  const afterWrite = useCallback(
    (result: Result<unknown>) => {
      if (!result.ok) return;
      void load();
    },
    [load],
  );

  const local = useMemo(() => localProviderIds(providers), [providers]);
  const shown = useMemo(
    () => (models === null ? null : filterModels(models, cards, filter, local)),
    [models, cards, filter, local],
  );
  const narrowed = !isUnfiltered(filter);
  // Counted over the whole registry, not over `shown`: a chip that recounted
  // itself as you filtered could only ever read "N of N", and the question the
  // chips answer — how much of this table bills — is about the whole table.
  const counts = useMemo(
    () => (models === null ? null : countCategories(models, local)),
    [models, local],
  );

  return (
    <section className="registry" aria-label="model registry">
      <header className="registry-head">
        <h2>registry</h2>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "hide" : "edit models"}
        </button>
        {models !== null && open && (
          // Both numbers when narrowed: "3 models" alone, on a registry of a
          // hundred, reads as a sync that went wrong.
          <span className="dim">
            {narrowed && shown !== null
              ? `${shown.length} of ${models.length} models`
              : `${models.length} models`}
          </span>
        )}
        {error !== null && <span className="error">{error}</span>}
      </header>

      {open && models !== null && models.length > 0 && (
        <>
          <FilterRow filter={filter} providers={providers} onChange={setFilter} />
          {counts !== null && (
            <CategoryChips counts={counts} active={filter.category} onChange={setFilter} />
          )}
        </>
      )}

      {open &&
        (models === null || shown === null ? (
          error === null ? (
            <p className="empty">loading…</p>
          ) : null
        ) : models.length === 0 ? (
          <p className="empty">
            No models. Run <code>rewter sync-models</code>, or add one by hand below.
          </p>
        ) : shown.length === 0 ? (
          // Distinct from the empty registry above: the models exist, this
          // filter just does not match any of them.
          <p className="empty">
            No model matches this filter.{" "}
            <button type="button" className="link" onClick={() => setFilter(emptyFilter())}>
              clear
            </button>
          </p>
        ) : (
          <table className="registry-table">
            <thead>
              <tr>
                <th scope="col">model</th>
                <th scope="col">$/MTok in / out</th>
                <th scope="col">ctx</th>
                <th scope="col">source</th>
                <th scope="col">on</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {shown.map((model) => (
                <RegistryRow
                  key={model.id}
                  model={model}
                  card={cards.get(model.id)}
                  providers={providers}
                  expanded={expanded === model.id}
                  onToggle={() => setExpanded((id) => (id === model.id ? null : model.id))}
                  onWrote={afterWrite}
                />
              ))}
            </tbody>
          </table>
        ))}

      {/* Available even on an empty registry — importing a bundle is exactly
          what you do to a machine that has nothing in it yet. */}
      {open && <RegistryTransfer onImported={() => void load()} />}

      {open && <ModelEditor mode="create" providers={providers} onWrote={afterWrite} />}
    </section>
  );
}

/**
 * Four counts, each one a filter.
 *
 * They are chips rather than a fifth dropdown because their value is mostly in
 * being *read*: "63 paid · 40 local · 2 unpriced" is the shape of the registry,
 * and a select box hides its options until clicked. Clicking is the secondary
 * use, and a second click on the active chip clears it — a filter you cannot
 * see how to leave is a trap.
 *
 * An empty category is drawn greyed and unclickable rather than hidden, because
 * "0 unpriced" is a reassuring fact and a chip that vanishes when it hits zero
 * makes the row jump every time a sync lands.
 */
function CategoryChips({
  counts,
  active,
  onChange,
}: {
  counts: Record<ModelCategory, number>;
  active: ModelCategory | "all";
  onChange: (update: (current: ModelFilter) => ModelFilter) => void;
}): JSX.Element {
  return (
    <div className="chips" aria-label="filter by category">
      {MODEL_CATEGORIES.map((category) => {
        const count = counts[category];
        const on = active === category;
        return (
          <button
            key={category}
            type="button"
            className="chip"
            data-on={on}
            disabled={count === 0}
            aria-pressed={on}
            onClick={() => onChange((current) => ({ ...current, category: on ? "all" : category }))}
          >
            {count} {category}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Query, provider, on/off.
 *
 * Only providers that own a model are offered, and only when there is more than
 * one — a dropdown whose every option shows the same table is furniture. The
 * query box is deliberately not debounced: filtering is a pure array pass over
 * rows already in memory, so the keystroke cost is a re-render, and a delay
 * would only make typing feel laggy.
 */
function FilterRow({
  filter,
  providers,
  onChange,
}: {
  filter: ModelFilter;
  providers: Provider[];
  onChange: (next: ModelFilter) => void;
}): JSX.Element {
  return (
    <div className="registry-filter">
      <label>
        <span className="visually-hidden">filter models</span>
        <input
          type="search"
          placeholder="filter by id, name or tag…"
          value={filter.query}
          onChange={(e) => onChange({ ...filter, query: e.target.value })}
        />
      </label>

      {/* "filter by provider", not "provider": the create form below has its own
          provider select, and two controls with one accessible name is a screen
          reader — and a test — that cannot tell them apart. */}
      {providers.length > 1 && (
        <label>
          <span className="visually-hidden">filter by provider</span>
          <select
            value={filter.providerId}
            onChange={(e) => onChange({ ...filter, providerId: e.target.value })}
          >
            <option value="all">all providers</option>
            {providers.map((provider) => (
              <option value={provider.id} key={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label>
        <span className="visually-hidden">filter by enabled</span>
        <select
          value={filter.enabled}
          onChange={(e) =>
            onChange({ ...filter, enabled: e.target.value as ModelFilter["enabled"] })
          }
        >
          <option value="all">on and off</option>
          <option value="on">enabled only</option>
          <option value="off">disabled only</option>
        </select>
      </label>

      {!isUnfiltered(filter) && (
        <button type="button" className="link" onClick={() => onChange(emptyFilter())}>
          clear
        </button>
      )}
    </div>
  );
}

function RegistryRow({
  model,
  card,
  providers,
  expanded,
  onToggle,
  onWrote,
}: {
  model: Model;
  card: CapabilityCard | undefined;
  providers: Provider[];
  expanded: boolean;
  onToggle: () => void;
  onWrote: (result: Result<unknown>) => void;
}): JSX.Element {
  return (
    <>
      <tr className="registry-row" data-enabled={model.enabled}>
        <th scope="row" title={model.id}>
          {shortModelId(model.id)}
          {/* What the model is *for* is the half that steers the orchestrator,
              so it rides on the same row as the prices rather than a tab away. */}
          {card !== undefined && card.bestAt.length > 0 && (
            <span className="best-at">{card.bestAt.join(" · ")}</span>
          )}
        </th>
        <td>{priceLabel(model)}</td>
        <td>{contextLabel(model)}</td>
        <td>
          {/* Not decoration: `synced` means the next sync overwrites these
              numbers, and that is the single most useful thing to know before
              typing one in. */}
          <span className="source" data-source={model.source}>
            {model.source}
          </span>
        </td>
        <td>{model.enabled ? "yes" : "no"}</td>
        <td>
          <button type="button" onClick={onToggle} aria-expanded={expanded}>
            {expanded ? "close" : "edit"}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="registry-detail">
          <td colSpan={6}>
            <ModelEditor
              mode="edit"
              model={model}
              card={card}
              providers={providers}
              onWrote={onWrote}
            />
          </td>
        </tr>
      )}
    </>
  );
}
