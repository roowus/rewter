/**
 * The footer: where the data lives, and the one button that ends the daemon.
 *
 * Two things the survey found in every other router's dashboard and none of
 * rewter's screens: a standing statement that this is a local process holding
 * local data, and a way to stop it from the UI that started it.
 *
 * **The sentence is not decoration.** Every other panel on this page looks
 * exactly like a hosted control plane — a task tree, a spend total, a registry
 * editor. Someone arriving at it has no way to tell whether their prompts and
 * keys crossed a network, and the answer ("they did not") is worth one line of
 * permanent text.
 *
 * **Shutdown is armed, not immediate.** A misclick here does not lose a form,
 * it kills the process serving the page — so the button asks first, and the
 * confirm step names what will and will not happen afterwards. There is no
 * Restart button next to it on purpose: rewter's generated LaunchAgent sets
 * `KeepAlive` to `{ SuccessfulExit: false }`, so a clean stop deliberately
 * stays stopped, and a Restart button would stop the daemon and then wait
 * forever for something that is not coming. What replaces it is a sentence
 * naming the exact command that does bring it back — which is the daemon's
 * answer, not this component's guess.
 *
 * After acceptance the button is spent and the page says so. The socket dying
 * a moment later is the rest of the story, and the header's liveness dot is
 * already watching for it — a second countdown here would just be a worse copy.
 */
import { useState } from "react";
import { type ShutdownOutcome, shutdownDaemon, shutdownMessage } from "./shutdown.js";

type Phase =
  | { kind: "idle" }
  /** Armed: the confirm step is on screen and nothing has been sent. */
  | { kind: "confirming" }
  | { kind: "sending" }
  | { kind: "done"; message: string }
  | { kind: "failed"; message: string };

function settle(outcome: ShutdownOutcome): Phase {
  if (outcome.ok) return { kind: "done", message: shutdownMessage(outcome.result) };
  return { kind: "failed", message: outcome.message };
}

export function DaemonFooter({
  version,
  fetchImpl = fetch,
}: {
  /** From `/internal/health`; null until the first poll answers. */
  version: string | null;
  fetchImpl?: typeof fetch;
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const send = () => {
    setPhase({ kind: "sending" });
    void (async () => {
      setPhase(settle(await shutdownDaemon(fetchImpl)));
    })();
  };

  return (
    <footer className="app-foot">
      <p className="local-mode">
        <span className="local-dot" aria-hidden="true" />
        Local Mode — rewter runs on this machine and stores everything here: tasks, events, costs
        and the registry live in its SQLite file, and API keys are read from your environment by
        name, never saved.
        {version !== null && <span className="dim"> · v{version}</span>}
      </p>

      <div className="daemon-controls">
        {phase.kind === "idle" && (
          <button type="button" className="danger" onClick={() => setPhase({ kind: "confirming" })}>
            Shut down
          </button>
        )}

        {phase.kind === "confirming" && (
          // Not a `<dialog>`: this asks one question with two answers and needs
          // no focus trap of its own to be understood. `alertdialog` is the role
          // for a confirmation a screen reader should not be able to walk past.
          <div className="confirm" role="alertdialog" aria-label="confirm shutdown">
            <p>
              Stop the daemon? Running tasks are cut off, this page stops updating, and nothing on
              this machine will start it again by itself.
            </p>
            <button type="button" className="danger" onClick={send}>
              Yes, shut down
            </button>
            <button type="button" onClick={() => setPhase({ kind: "idle" })}>
              Cancel
            </button>
          </div>
        )}

        {phase.kind === "sending" && <span className="dim">stopping…</span>}

        {/* Terminal on purpose: the button does not come back. A second POST
            would land on a socket that is already draining and read as a
            failure of the first one. */}
        {phase.kind === "done" && <p className="stopping">{phase.message}</p>}

        {phase.kind === "failed" && (
          <p className="error">
            {phase.message}{" "}
            <button type="button" onClick={() => setPhase({ kind: "idle" })}>
              back
            </button>
          </p>
        )}
      </div>
    </footer>
  );
}
