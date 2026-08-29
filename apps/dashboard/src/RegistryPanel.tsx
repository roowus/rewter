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
 * to open this page is usually one of them.
 */
import type { CapabilityCard, Model, Provider } from "@rewter/shared";
import { useCallback, useEffect, useState } from "react";
import { ModelEditor } from "./ModelEditor.js";
import { shortModelId, usd } from "./format.js";
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

  return (
    <section className="registry" aria-label="model registry">
      <header className="registry-head">
        <h2>registry</h2>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "hide" : "edit models"}
        </button>
        {models !== null && open && <span className="dim">{models.length} models</span>}
        {error !== null && <span className="error">{error}</span>}
      </header>

      {open &&
        (models === null ? (
          error === null ? (
            <p className="empty">loading…</p>
          ) : null
        ) : models.length === 0 ? (
          <p className="empty">
            No models. Run <code>rewter sync-models</code>, or add one by hand below.
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
              {models.map((model) => (
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

      {open && <ModelEditor mode="create" providers={providers} onWrote={afterWrite} />}
    </section>
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
