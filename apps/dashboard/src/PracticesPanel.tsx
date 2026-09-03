/**
 * Practices — the approval gate on the standing facts the daemon drafted.
 *
 * The drafter turns an owner's corrections (steering, denials) into pending
 * PRACTICE.md facts, and nothing pending is ever in a prompt: this panel is
 * where a draft becomes a rule every task carries. Same posture as the skills
 * panel — fetch on mount even while collapsed, count in the header, reject
 * arms before it fires, a 409 re-arms approve as an explicit overwrite.
 *
 * The difference from skills is what is shown: a practice *is* its one fact,
 * so the fact is the card, and approved practices are listed fact-first —
 * that list is exactly what every initiator reads.
 */
import type { Practice } from "@rewter/shared";
import { useCallback, useEffect, useState } from "react";
import { approvePractice, fetchPractices, rejectPractice } from "./practices.js";

export function PracticesPanel(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [practices, setPractices] = useState<Practice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    const result = await fetchPractices(fetch, signal);
    if (signal?.aborted) return;
    if (result.ok) {
      setPractices(result.value);
      setError(null);
    } else if (result.message !== "aborted") setError(result.message);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  const pending = (practices ?? []).filter((p) => p.status === "pending");
  const approved = (practices ?? []).filter((p) => p.status === "approved");

  return (
    <section className="skills practices" aria-label="practices">
      <header className="registry-head">
        <h2>practices</h2>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "hide" : "review practices"}
        </button>
        {practices !== null && (
          <span className={pending.length > 0 ? "" : "dim"}>
            {pending.length} proposed · {approved.length} approved
          </span>
        )}
        {error !== null && <span className="error">{error}</span>}
      </header>

      {open && practices === null && error === null && <p className="empty">loading…</p>}

      {open && practices !== null && (
        <>
          {pending.length === 0 && approved.length === 0 && (
            <p className="empty">
              No practices yet. When you steer a task or deny an approval, the daemon may draft the
              correction as a standing fact — it waits here (and in <code>rewter practices</code>)
              until you approve it, and only then does every task carry it.
            </p>
          )}

          {pending.length > 0 && (
            <div className="skills-pending">
              {pending.map((p) => (
                <PendingPracticeCard key={p.path} practice={p} onWrote={() => void reload()} />
              ))}
            </div>
          )}

          {approved.length > 0 && (
            <table className="registry-table">
              <thead>
                <tr>
                  <th scope="col">practice</th>
                  <th scope="col">scope</th>
                  <th scope="col">fact</th>
                </tr>
              </thead>
              <tbody>
                {approved.map((p) => (
                  <tr className="registry-row" key={p.path}>
                    <th scope="row" title={p.path}>
                      <code>{p.slug}</code>
                    </th>
                    <td>{p.projectSlug ?? "global"}</td>
                    <td>{p.fact}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

/** One draft awaiting judgement — the fact itself, then the two one-way verbs. */
function PendingPracticeCard({
  practice,
  onWrote,
}: {
  practice: Practice;
  onWrote: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [armedReject, setArmedReject] = useState(false);

  const approve = async (): Promise<void> => {
    setBusy(true);
    const result = await approvePractice(practice.slug, conflicted);
    setBusy(false);
    if (result.ok) {
      onWrote();
      return;
    }
    setError(result.message);
    setConflicted(/already exists/.test(result.message));
  };

  const reject = async (): Promise<void> => {
    setBusy(true);
    const result = await rejectPractice(practice.slug);
    setBusy(false);
    if (result.ok) onWrote();
    else setError(result.message);
  };

  return (
    <div className="skill-card" data-status="pending">
      <p>
        <strong>
          <code>{practice.slug}</code>
        </strong>{" "}
        <span className="dim">proposed → {practice.projectSlug ?? "global"}</span>
        {practice.learnedFrom !== null && (
          <span className="dim"> · learned from {practice.learnedFrom}</span>
        )}
      </p>
      <p>{practice.fact}</p>
      <p className="dim">
        <code>{practice.path}</code> — edit the file first if the wording needs work; approve
        re-reads it
      </p>
      <p>
        <button type="button" onClick={() => void approve()} disabled={busy}>
          {conflicted ? "approve anyway (overwrite)" : "approve"}
        </button>{" "}
        {armedReject ? (
          <button type="button" className="danger" onClick={() => void reject()} disabled={busy}>
            really reject?
          </button>
        ) : (
          <button
            type="button"
            className="danger"
            onClick={() => setArmedReject(true)}
            disabled={busy}
          >
            reject
          </button>
        )}
        {error !== null && <span className="error"> {error}</span>}
      </p>
    </div>
  );
}
