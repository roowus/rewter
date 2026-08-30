/**
 * Starting an orchestration from here — survey shortlist item 7.
 *
 * Every other panel on this page reports. This one acts, and it is the only
 * place in the dashboard that begins work rather than describing work that a
 * client began. Until now the answer to "does this prompt fan out the way I
 * expect?" cost a terminal, an env var and a client round-trip to ask; the
 * whole point of this box is that it costs a sentence.
 *
 * **It shows almost nothing after submitting, deliberately.** One line naming
 * the task it started, and then the tree below takes over — because the tree is
 * already folding every event this task will emit, and a panel that also
 * rendered progress would be a second copy of that fold with its own bugs. The
 * confirmation line exists to answer the two things the tree cannot say
 * immediately: which model ended up leading, and that the daemon accepted the
 * prompt at all.
 *
 * **It is not the chat tester**, and the two refuse each other's model strings
 * on the daemon side. That one sends one prompt to one model and prints the
 * bill inline; this one starts a task that fans out, costs an unknown amount
 * and answers later. Confusing them is exactly how someone spends real money
 * expecting a smoke test, so the budget field sits in the form rather than in a
 * settings screen — a run started on a whim is precisely the one that wants a
 * ceiling.
 *
 * Collapsed by default, unlike the reporting panels: this is a control, and a
 * prompt box permanently open above a live task tree invites typing into it by
 * reflex.
 */
import type { Model } from "@rewter/shared";
import { useEffect, useState } from "react";
import { fetchRegistry } from "./registry.js";
import { type RunInput, parseBudget, runTask } from "./run.js";

/** What the last submission started, kept only until the next one. */
interface Started {
  taskId: string;
  title: string;
  initiatorModelId: string;
}

export function RunPanel(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [initiator, setInitiator] = useState("");
  const [budget, setBudget] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<Started | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Only once the panel is opened: the model list is for the pin dropdown, and
  // a closed panel has no dropdown to fill.
  useEffect(() => {
    if (!open || models.length > 0) return;
    const controller = new AbortController();
    void (async () => {
      const out = await fetchRegistry(fetch, controller.signal);
      if (controller.signal.aborted) return;
      // A registry that will not load is not a reason to block the form — the
      // empty pin is the common case and needs no list at all.
      if (out.ok) setModels(out.value.models);
    })();
    return () => controller.abort();
  }, [open, models.length]);

  const submit = () => {
    const parsedBudget = parseBudget(budget);
    if (!parsedBudget.ok) {
      setError(parsedBudget.message);
      return;
    }
    setBusy(true);
    setError(null);
    void (async () => {
      const input: RunInput = { prompt, autoApprove };
      // Absent rather than `undefined`: an omitted budget inherits the daemon's
      // configured default, and sending the field at all would overwrite it.
      if (parsedBudget.value !== undefined) input.maxSpendUsd = parsedBudget.value;
      if (initiator !== "") input.initiator = initiator;

      const out = await runTask(input, fetch);
      setBusy(false);
      if (out.ok) {
        setStarted({
          taskId: out.value.taskId,
          title: out.value.title,
          initiatorModelId: out.value.initiatorModelId,
        });
        setError(null);
        // The prompt is cleared and the settings are not: the next thing
        // someone does here is usually the same run with a different wording.
        setPrompt("");
      } else {
        setStarted(null);
        setError(out.message);
      }
    })();
  };

  return (
    <section className="run" aria-label="run a task">
      <header className="run-head">
        <h2>run</h2>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "hide" : "start a task"}
        </button>
        {open && <span className="dim">fans out across models — this spends</span>}
        {error !== null && <span className="error">{error}</span>}
      </header>

      {open && (
        <>
          <div className="run-form">
            <label htmlFor="run-prompt">task</label>
            <textarea
              id="run-prompt"
              value={prompt}
              rows={3}
              placeholder="summarize these three URLs and compare them"
              onChange={(e) => setPrompt(e.target.value)}
            />

            <div className="run-settings">
              <label htmlFor="run-initiator">initiator</label>
              <select
                id="run-initiator"
                value={initiator}
                onChange={(e) => setInitiator(e.target.value)}
              >
                {/* The default is the registry's choice, not a model. Pinning
                    is for answering "would the cheap one have planned this as
                    well?", which is a question you ask on purpose. */}
                <option value="">auto — let the registry choose</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>

              <label htmlFor="run-budget">budget</label>
              <input
                id="run-budget"
                value={budget}
                placeholder="daemon default"
                onChange={(e) => setBudget(e.target.value)}
                title="a dollar amount, blank for the daemon's default, or 'uncapped'"
              />

              <label className="run-check" htmlFor="run-auto">
                <input
                  id="run-auto"
                  type="checkbox"
                  checked={autoApprove}
                  onChange={(e) => setAutoApprove(e.target.checked)}
                />
                auto-approve gates
              </label>

              <button type="button" onClick={submit} disabled={busy || prompt.trim() === ""}>
                {busy ? "starting…" : "Run"}
              </button>
            </div>
          </div>

          {started !== null && (
            // Deliberately terse. The task is in the tree below by now; this
            // line exists to name the initiator, which is the one thing the
            // caller did not choose and cannot otherwise see at a glance.
            <p className="run-started">
              started <strong>{started.title}</strong> <span className="dim">{started.taskId}</span>{" "}
              <span className="dim">· leading: {started.initiatorModelId}</span>
            </p>
          )}
        </>
      )}
    </section>
  );
}
