/**
 * The approval card: a worker is parked on this answer.
 *
 * This is the one control in the dashboard where latency is a correctness
 * problem rather than a comfort one — a worker is blocked on a promise while the
 * card is on screen, so the card has to say what it is asking about precisely
 * enough to answer without switching windows.
 *
 * It deliberately does not remove itself on click. The answer travels to the
 * daemon, becomes an `approval.resolved` event, comes back down the socket and
 * folds — and *that* is what takes the card away. Hiding it optimistically would
 * mean a denied POST leaves the UI claiming an approval that never happened.
 */
import type { Approval } from "@rewter/shared";
import { useState } from "react";
import { resolveApproval } from "./approvals.js";
import { clockTime } from "./format.js";

const KIND_LABEL: Record<Approval["kind"], string> = {
  shell: "shell command",
  write_outside_workspace: "write outside the workspace",
  spawn_harness: "start an external coding agent",
  budget: "budget",
  other: "action",
};

export function ApprovalCard({ approval }: { approval: Approval }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  /** Last thing the daemon said. Survives on screen until the fold removes us. */
  const [outcome, setOutcome] = useState<string | null>(null);

  async function answer(approved: boolean): Promise<void> {
    setBusy(true);
    const result = await resolveApproval(approval.id, approved, note.trim() || undefined);
    setOutcome(result.message);
    // Re-enable on failure only: on success the card is about to be folded away,
    // and buttons that come back for a frame invite a second click on a settled
    // row — which the daemon answers with a 409.
    if (!result.ok) setBusy(false);
  }

  return (
    <article className="approval" aria-label={`approval ${approval.id}`}>
      <header>
        <span className="approval-kind">{KIND_LABEL[approval.kind]}</span>
        <time dateTime={new Date(approval.createdAt).toISOString()}>
          {clockTime(approval.createdAt)}
        </time>
      </header>

      {/* The exact command, not a paraphrase: approving a summary of a command
          is approving something you did not read. */}
      <pre className="approval-summary">{approval.summary}</pre>

      <label>
        <span className="visually-hidden">Note (optional)</span>
        <input
          type="text"
          placeholder="note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
        />
      </label>

      <div className="approval-actions">
        <button type="button" onClick={() => void answer(true)} disabled={busy}>
          Approve
        </button>
        <button type="button" className="deny" onClick={() => void answer(false)} disabled={busy}>
          Deny
        </button>
      </div>

      {/* A denial note reaches the worker as a tool result, so it is worth
          saying that the answer landed even while the card waits to be folded. */}
      {outcome !== null && <p className="approval-outcome">{outcome}</p>}
    </article>
  );
}
