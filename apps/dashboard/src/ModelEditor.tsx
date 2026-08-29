/**
 * Editing one model, and adding one by hand.
 *
 * Two rules shape this form and both are about the same failure — an edit the
 * user believes happened and did not.
 *
 * **The promotion warning.** Correcting a fact on a `synced` row takes it off
 * the sync path (see `RegistryPanel`). That is what the user wants, but it is a
 * real consequence — that model stops tracking its provider's catalog forever —
 * so the form says it *before* the save, while the change is still on screen and
 * attributable to a field they just typed in.
 *
 * **The no-op report.** The daemon compares by value and answers `changed:
 * false` when a patch matches the row. Saying "no change" rather than "saved"
 * is the difference between a user who notices they were editing a stale form
 * and one who walks away believing a price is fixed.
 *
 * Only dirty fields are sent. Sending the whole form would be harmless — the
 * server compares by value, which is exactly why it does that — but a patch
 * that names one field is a patch whose rejection names the field that was
 * wrong.
 */
import {
  type CapabilityCard,
  CapabilityTagSchema,
  type CardOverrides,
  type Model,
  type Provider,
} from "@rewter/shared";
import { useState } from "react";
import { type Result, createModel, deleteModel, patchModel, putCardOverrides } from "./registry.js";

const TAGS = CapabilityTagSchema.options;

/** The seven fields sync would otherwise overwrite; `enabled` is not one. */
const FACT_FIELDS = [
  "upstreamId",
  "displayName",
  "contextWindow",
  "maxOutputTokens",
  "inputPerMTok",
  "outputPerMTok",
  "cacheReadPerMTok",
  "cacheWritePerMTok",
] as const;
type FactField = (typeof FACT_FIELDS)[number];

type Form = Record<FactField, string>;

const numText = (value: number | null): string => (value === null ? "" : String(value));

const formOf = (model: Model | undefined): Form => ({
  upstreamId: model?.upstreamId ?? "",
  displayName: model?.displayName ?? "",
  contextWindow: numText(model?.contextWindow ?? null),
  maxOutputTokens: numText(model?.maxOutputTokens ?? null),
  inputPerMTok: numText(model?.pricing.inputPerMTok ?? null),
  outputPerMTok: numText(model?.pricing.outputPerMTok ?? null),
  cacheReadPerMTok: numText(model?.pricing.cacheReadPerMTok ?? null),
  cacheWritePerMTok: numText(model?.pricing.cacheWritePerMTok ?? null),
});

/**
 * Empty means "we do not know this", not zero.
 *
 * The distinction is load-bearing downstream: an unpriced model is skipped by
 * the cost report, a `$0` one is counted as free. Returning `undefined` for a
 * malformed number rather than `NaN` lets the caller drop the field and let the
 * server's schema reject what is left, instead of sending a `NaN` that
 * JSON-encodes as `null` and silently clears a real price.
 */
function numeric(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

export function ModelEditor(props: {
  mode: "create" | "edit";
  // Explicitly `| undefined`: under `exactOptionalPropertyTypes` an optional
  // prop is not the same as one you may pass `undefined` to, and a row without
  // a card passes exactly that.
  model?: Model | undefined;
  card?: CapabilityCard | undefined;
  providers: Provider[];
  onWrote: (result: Result<unknown>) => void;
}): JSX.Element {
  return props.mode === "create" ? (
    <CreateForm providers={props.providers} onWrote={props.onWrote} />
  ) : (
    <EditForm model={props.model as Model} card={props.card} onWrote={props.onWrote} />
  );
}

function EditForm({
  model,
  card,
  onWrote,
}: {
  model: Model;
  card: CapabilityCard | undefined;
  onWrote: (result: Result<unknown>) => void;
}): JSX.Element {
  const initial = formOf(model);
  const [form, setForm] = useState<Form>(initial);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dirty = FACT_FIELDS.filter((field) => form[field] !== initial[field]);
  // The whole reason for the banner: a fact edit on a synced row is the moment
  // the model stops following its provider's catalog.
  const willPromote = model.source === "synced" && dirty.length > 0;

  const set = (field: FactField, value: string): void =>
    setForm((prev) => ({ ...prev, [field]: value }));

  /** Only dirty fields; pricing goes as a whole because the server takes it whole. */
  function buildPatch(): Record<string, unknown> | string {
    const patch: Record<string, unknown> = {};
    if (dirty.includes("upstreamId")) patch.upstreamId = form.upstreamId.trim();
    if (dirty.includes("displayName")) patch.displayName = form.displayName.trim();
    for (const field of ["contextWindow", "maxOutputTokens"] as const) {
      if (!dirty.includes(field)) continue;
      const value = numeric(form[field]);
      if (value === undefined) return `${field} is not a number`;
      patch[field] = value;
    }
    if (dirty.some((field) => field.endsWith("PerMTok"))) {
      const pricing: Record<string, number | null> = {};
      for (const key of [
        "inputPerMTok",
        "outputPerMTok",
        "cacheReadPerMTok",
        "cacheWritePerMTok",
      ] as const) {
        const value = numeric(form[key]);
        if (value === undefined) return `${key} is not a number`;
        pricing[key] = value;
      }
      patch.pricing = pricing;
    }
    return patch;
  }

  async function save(): Promise<void> {
    const patch = buildPatch();
    if (typeof patch === "string") {
      setOutcome(patch);
      return;
    }
    setBusy(true);
    const result = await patchModel(model.id, patch);
    setBusy(false);
    setOutcome(
      result.ok
        ? result.value.changed
          ? result.value.model.source === "manual" && model.source === "synced"
            ? "saved — this model is now manual and sync will leave it alone"
            : "saved"
          : // Not an error. The most common way to see this is a form showing
            // values someone else already saved.
            "no change — the values sent match what is stored"
        : result.message,
    );
    onWrote(result);
  }

  async function toggleEnabled(): Promise<void> {
    setBusy(true);
    const result = await patchModel(model.id, { enabled: !model.enabled });
    setBusy(false);
    setOutcome(result.ok ? (model.enabled ? "disabled" : "enabled") : result.message);
    onWrote(result);
  }

  async function remove(): Promise<void> {
    setBusy(true);
    const result = await deleteModel(model.id);
    setBusy(false);
    setOutcome(result.ok ? "deleted" : result.message);
    onWrote(result);
  }

  return (
    <div className="model-editor">
      <div className="field-grid">
        <Field
          label="display name"
          value={form.displayName}
          onChange={(v) => set("displayName", v)}
        />
        <Field label="upstream id" value={form.upstreamId} onChange={(v) => set("upstreamId", v)} />
        <Field
          label="context window"
          value={form.contextWindow}
          onChange={(v) => set("contextWindow", v)}
        />
        <Field
          label="max output"
          value={form.maxOutputTokens}
          onChange={(v) => set("maxOutputTokens", v)}
        />
        <Field
          label="$ in /MTok"
          value={form.inputPerMTok}
          onChange={(v) => set("inputPerMTok", v)}
        />
        <Field
          label="$ out /MTok"
          value={form.outputPerMTok}
          onChange={(v) => set("outputPerMTok", v)}
        />
        <Field
          label="$ cache read"
          value={form.cacheReadPerMTok}
          onChange={(v) => set("cacheReadPerMTok", v)}
        />
        <Field
          label="$ cache write"
          value={form.cacheWritePerMTok}
          onChange={(v) => set("cacheWritePerMTok", v)}
        />
      </div>

      {willPromote && (
        <p className="promote-warning">
          Saving takes <code>{model.id}</code> off the sync path — <code>rewter sync-models</code>{" "}
          will stop refreshing its prices from the provider.
        </p>
      )}

      <div className="editor-actions">
        <button type="button" onClick={() => void save()} disabled={busy || dirty.length === 0}>
          save {dirty.length > 0 && `(${dirty.length})`}
        </button>
        {/* Its own button, not a form field: enabling is the user's switch and
            never promotes the row. */}
        <button type="button" onClick={() => void toggleEnabled()} disabled={busy}>
          {model.enabled ? "disable" : "enable"}
        </button>
        <DeleteButton onConfirm={() => void remove()} disabled={busy} />
      </div>

      {outcome !== null && <p className="editor-outcome">{outcome}</p>}

      <CardOverrideEditor model={model} card={card} onWrote={onWrote} />
    </div>
  );
}

/**
 * Deleting a model is one click behind a confirm, because it is the one action
 * here that cannot be undone by re-typing what was there — the capability card
 * goes with it. (Cost history deliberately survives, still naming the model.)
 */
function DeleteButton({
  onConfirm,
  disabled,
}: {
  onConfirm: () => void;
  disabled: boolean;
}): JSX.Element {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button type="button" className="danger" onClick={() => setArmed(true)} disabled={disabled}>
        delete
      </button>
    );
  }
  return (
    <button type="button" className="danger" onClick={onConfirm} disabled={disabled}>
      really delete? (and its card)
    </button>
  );
}

/**
 * The user's patch over a generated card.
 *
 * A separate save from the model's facts because it is a separate lifecycle:
 * `rewter card <model>` regenerates the card underneath, and the override is
 * what survives that. Editing them together would suggest they are one row.
 */
function CardOverrideEditor({
  model,
  card,
  onWrote,
}: {
  model: Model;
  card: CapabilityCard | undefined;
  onWrote: (result: Result<unknown>) => void;
}): JSX.Element {
  const [summary, setSummary] = useState(card?.summary ?? "");
  const [bestAt, setBestAt] = useState<string[]>(card?.bestAt ?? []);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (card === undefined) {
    return (
      <p className="card-none">
        No capability card. Run <code>rewter card {model.id}</code> to generate one — the
        orchestrator reads it to decide what to send here.
      </p>
    );
  }

  const overridden = card.userOverrides !== null;

  async function write(overrides: CardOverrides | null): Promise<void> {
    setBusy(true);
    const result = await putCardOverrides(model.id, overrides);
    setBusy(false);
    setOutcome(
      result.ok ? (overrides === null ? "restored generated card" : "saved") : result.message,
    );
    onWrote(result);
  }

  const toggleTag = (tag: string): void =>
    setBestAt((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));

  return (
    <div className="card-editor">
      <h4>
        capability card
        {/* Which half of what is on screen is the user's, so a correction is
            not mistaken for the model's own generated opinion of itself. */}
        {overridden && <span className="overridden">has your overrides</span>}
      </h4>

      <label>
        <span>summary</span>
        <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={2} />
      </label>

      <fieldset className="tags">
        <legend>best at</legend>
        {/* A fixed vocabulary rather than free text: these tags double as the
            phase-2 stats key, and a freehand one would join to nothing. */}
        {TAGS.map((tag) => (
          <label key={tag} className="tag">
            <input type="checkbox" checked={bestAt.includes(tag)} onChange={() => toggleTag(tag)} />
            {tag}
          </label>
        ))}
      </fieldset>

      <div className="editor-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void write({
              summary,
              bestAt: bestAt as CardOverrides["bestAt"],
            })
          }
        >
          save overrides
        </button>
        {overridden && (
          <button type="button" disabled={busy} onClick={() => void write(null)}>
            clear overrides
          </button>
        )}
      </div>

      {outcome !== null && <p className="editor-outcome">{outcome}</p>}
    </div>
  );
}

/**
 * Adding a model the provider's catalog does not list — a local Ollama build,
 * or a model shipped ahead of the `/models` endpoint that names it.
 *
 * There is no `source` control: a row someone typed is `manual` by
 * construction, and offering `synced` would hand sync permission to overwrite
 * a model nothing upstream has ever heard of.
 */
function CreateForm({
  providers,
  onWrote,
}: {
  providers: Provider[];
  onWrote: (result: Result<unknown>) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [upstreamId, setUpstreamId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    const result = await createModel({
      id: id.trim(),
      providerId: providerId.trim(),
      upstreamId: upstreamId.trim(),
      displayName: displayName.trim(),
    });
    setBusy(false);
    if (result.ok) {
      setOutcome(`created ${result.value.id} — unpriced until you set prices`);
      setId("");
      setUpstreamId("");
      setDisplayName("");
    } else {
      setOutcome(result.message);
    }
    onWrote(result);
  }

  if (!open) {
    return (
      <button type="button" className="add-model" onClick={() => setOpen(true)}>
        add a model by hand
      </button>
    );
  }

  return (
    <div className="model-editor create">
      <div className="field-grid">
        <Field label="id (provider/name)" value={id} onChange={setId} />
        <label>
          <span>provider</span>
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">choose…</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </label>
        <Field label="upstream id" value={upstreamId} onChange={setUpstreamId} />
        <Field label="display name" value={displayName} onChange={setDisplayName} />
      </div>
      <div className="editor-actions">
        <button type="button" onClick={() => void submit()} disabled={busy}>
          create
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy}>
          cancel
        </button>
      </div>
      {outcome !== null && <p className="editor-outcome">{outcome}</p>}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label>
      <span>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
