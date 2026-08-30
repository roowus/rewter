/**
 * The landing card: shown only when there is nothing else to show.
 *
 * A first-run dashboard's empty state used to be one sentence — "point a client
 * at `auto/orchestrator`" — which is good advice and useless if the reason no
 * task has appeared is that no model is enabled to run one. This replaces that
 * sentence with the same invitation *plus* the reason it might not work yet, and
 * the command that fixes it.
 *
 * It disappears the moment a task exists. A daemon with history has answered the
 * question by demonstration, and a permanent "ready ✓" banner is chrome that
 * teaches people to stop reading the top of the page.
 */
import type { DaemonHealth } from "@rewter/shared";
import { readinessOf } from "./readiness.js";

export function ReadinessCard({ health }: { health: DaemonHealth | null }): JSX.Element {
  // Before the first health fetch lands, the old sentence is still the honest
  // thing to say: no verdict has been earned yet.
  if (health === null) {
    return (
      <p className="empty">
        No tasks yet. Point a client at <code>auto/orchestrator</code> and one will appear here.
      </p>
    );
  }

  const { ready, checks } = readinessOf(health);

  return (
    <section className="readiness" aria-label="readiness" data-ready={ready}>
      <h2>
        {ready ? "ready for a task" : "not ready"}
        <span className="dim">
          {ready ? (
            <>
              {" "}
              — point a client at <code>auto/orchestrator</code>
            </>
          ) : (
            " — a task would fail right now"
          )}
        </span>
      </h2>
      <ul className="checks">
        {checks.map((check) => (
          <li key={check.id} className="check" data-level={check.level}>
            <span className="check-label">{check.label}</span>
            {check.fix !== null && (
              <>
                {" — "}
                <code>{check.fix}</code>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
