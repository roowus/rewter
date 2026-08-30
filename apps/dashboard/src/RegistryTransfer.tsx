/**
 * Moving the registry between machines, from the registry editor.
 *
 * Export is one click and ends in a file. Import is deliberately three steps —
 * pick, preview, apply — because it is the only control on this page that
 * writes to rows the user may have spent an evening correcting, and the preview
 * is what makes that survivable. The preview is not an estimate: `dryRun` runs
 * the identical planner in the daemon and reports the same decisions the write
 * will make, so what the confirm step shows is what happens.
 *
 * The conflict choice is offered *at* the preview rather than before it, since
 * the answer depends on what the preview says. `skip` is the default and the
 * safe one; switching to `overwrite` re-previews rather than applying, so the
 * numbers under the button always describe the button.
 *
 * Nothing here mentions API keys because a bundle structurally cannot contain
 * one — see `@rewter/shared`'s `transfer.ts`. What it does mention is providers,
 * because the one thing that reliably goes wrong is importing a bundle from a
 * machine with an upstream this one has not configured, and that is fixable if
 * the provider gets named.
 */
import { type RegistryBundle, type RegistryImportReport, summarizeDecisions } from "@rewter/shared";
import { useRef, useState } from "react";
import {
  type ImportOptions,
  exportRegistry,
  importRegistry,
  readBundleFile,
  saveBundle,
} from "./transfer.js";

type Phase =
  | { kind: "idle" }
  | { kind: "busy"; what: string }
  /** A bundle is in hand and the daemon has said what it would do with it. */
  | { kind: "preview"; bundle: RegistryBundle; report: RegistryImportReport }
  | { kind: "done"; report: RegistryImportReport }
  | { kind: "failed"; message: string };

export function RegistryTransfer({
  onImported,
  fetchImpl = fetch,
}: {
  /** Re-read the registry: the import wrote rows this panel is displaying. */
  onImported: () => void;
  fetchImpl?: typeof fetch;
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [onConflict, setOnConflict] = useState<ImportOptions["onConflict"]>("skip");
  const fileRef = useRef<HTMLInputElement>(null);

  const doExport = () => {
    setPhase({ kind: "busy", what: "exporting…" });
    void (async () => {
      const result = await exportRegistry(null, fetchImpl);
      if (!result.ok) return setPhase({ kind: "failed", message: result.message });
      saveBundle(result.value);
      setPhase({ kind: "idle" });
    })();
  };

  const preview = (bundle: RegistryBundle, mode: ImportOptions["onConflict"]) => {
    setPhase({ kind: "busy", what: "checking…" });
    void (async () => {
      const result = await importRegistry(bundle, { onConflict: mode, dryRun: true }, fetchImpl);
      setPhase(
        result.ok
          ? { kind: "preview", bundle, report: result.value }
          : { kind: "failed", message: result.message },
      );
    })();
  };

  const onPick = (file: File | undefined) => {
    // Cleared so picking the same file twice in a row still fires `change` —
    // re-importing after a fix is a completely reasonable thing to do.
    if (fileRef.current !== null) fileRef.current.value = "";
    if (file === undefined) return;
    setPhase({ kind: "busy", what: "reading…" });
    void (async () => {
      const parsed = await readBundleFile(file);
      if (!parsed.ok) return setPhase({ kind: "failed", message: parsed.message });
      preview(parsed.value, onConflict);
    })();
  };

  const apply = (bundle: RegistryBundle) => {
    setPhase({ kind: "busy", what: "importing…" });
    void (async () => {
      const result = await importRegistry(bundle, { onConflict, dryRun: false }, fetchImpl);
      if (!result.ok) return setPhase({ kind: "failed", message: result.message });
      setPhase({ kind: "done", report: result.value });
      onImported();
    })();
  };

  return (
    <div className="registry-transfer" aria-label="registry transfer">
      {(phase.kind === "idle" || phase.kind === "done" || phase.kind === "failed") && (
        <>
          <button type="button" onClick={doExport}>
            export registry
          </button>
          <button type="button" onClick={() => fileRef.current?.click()}>
            import bundle…
          </button>
          {/* The input itself is hidden: a bare file input cannot be styled to
              sit next to a button, and the button is what the label describes. */}
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="visually-hidden"
            aria-label="registry bundle file"
            onChange={(e) => onPick(e.target.files?.[0])}
          />
        </>
      )}

      {phase.kind === "busy" && <span className="dim">{phase.what}</span>}

      {phase.kind === "preview" && (
        <div className="confirm" role="alertdialog" aria-label="confirm import">
          <ReportLines report={phase.report} bundle={phase.bundle} />
          <label>
            <span className="visually-hidden">what to do about models already here</span>
            <select
              value={onConflict}
              onChange={(e) => {
                const next = e.target.value as ImportOptions["onConflict"];
                setOnConflict(next);
                // Re-preview rather than apply: the counts under the button
                // must always describe the button.
                preview(phase.bundle, next);
              }}
            >
              <option value="skip">keep what is already here</option>
              <option value="overwrite">overwrite what is already here</option>
            </select>
          </label>
          <button type="button" onClick={() => apply(phase.bundle)}>
            import
          </button>
          <button type="button" onClick={() => setPhase({ kind: "idle" })}>
            cancel
          </button>
        </div>
      )}

      {phase.kind === "done" && (
        <p className="stopping">
          Imported — models: {summarizeDecisions(phase.report.models)}; cards:{" "}
          {summarizeDecisions(phase.report.cards)}.
        </p>
      )}

      {phase.kind === "failed" && <span className="error">{phase.message}</span>}
    </div>
  );
}

/**
 * What the daemon says it would do, in the order it matters.
 *
 * Missing providers come first and get their own line even though they are also
 * counted in the model summary, because they are the only outcome here with a
 * fix: configure the upstream and import again. A run of identical
 * `no_provider` rows is a wall; "OpenRouter isn't configured here — 14 models"
 * is an instruction.
 */
function ReportLines({
  report,
  bundle,
}: {
  report: RegistryImportReport;
  bundle: RegistryBundle;
}): JSX.Element {
  return (
    <>
      <p>
        This bundle has {bundle.models.length} models and {bundle.cards.length} cards. Importing it
        would give you — models: {summarizeDecisions(report.models)}; cards:{" "}
        {summarizeDecisions(report.cards)}.
      </p>
      {report.missingProviders.length > 0 && (
        <p className="dim">
          {report.missingProviders.map((p) => (
            <span key={p.id}>
              {p.name} is not configured here — {p.modelCount}{" "}
              {p.modelCount === 1 ? "model" : "models"} skipped.{" "}
            </span>
          ))}
          Add the provider and import again; nothing here creates one for you.
        </p>
      )}
      {/* Said out loud because it is the promise that makes the button safe to
          press: an import can only add, and only replaces when told to. */}
      <p className="dim">Nothing already here is deleted.</p>
    </>
  );
}
