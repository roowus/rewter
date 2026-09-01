/**
 * Skills — the approval gate on what the daemon learned (P2-M4 slice 3).
 *
 * The distiller drafts into `pending/`, and nothing pending is ever retrieved:
 * this panel is where a draft becomes real. Unlike the registry and projects
 * panels this one fetches on mount even while collapsed — a proposed skill is
 * a question waiting on the owner, and a queue nobody can see is a queue
 * nobody answers. The header carries the count; opening shows the drafts.
 *
 * Approve moves the file into its scope; reject deletes the draft, so it arms
 * like project delete. A 409 (an approved copy already exists) re-arms the
 * approve button as an explicit overwrite rather than retrying silently — the
 * daemon refused for a reason the owner should read first. The SKILL.md path
 * is printed on every draft because "edit first, then approve" is an intended
 * flow: the route re-reads the file when it moves it.
 */
import type { Skill } from "@rewter/shared";
import { useCallback, useEffect, useState } from "react";
import { approveSkill, fetchSkills, rejectSkill } from "./skills.js";

export function SkillsPanel(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    const result = await fetchSkills(fetch, signal);
    if (signal?.aborted) return;
    // A transient failure keeps the rows and says so, same as projects.
    if (result.ok) {
      setSkills(result.value);
      setError(null);
    } else if (result.message !== "aborted") setError(result.message);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  const pending = (skills ?? []).filter((s) => s.status === "pending");
  const approved = (skills ?? []).filter((s) => s.status === "approved");

  return (
    <section className="skills" aria-label="skills">
      <header className="registry-head">
        <h2>skills</h2>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "hide" : "review skills"}
        </button>
        {skills !== null && (
          <span className={pending.length > 0 ? "" : "dim"}>
            {pending.length} proposed · {approved.length} approved
          </span>
        )}
        {error !== null && <span className="error">{error}</span>}
      </header>

      {open && skills === null && error === null && <p className="empty">loading…</p>}

      {open && skills !== null && (
        <>
          {pending.length === 0 && approved.length === 0 && (
            <p className="empty">
              No skills yet. When a task succeeds, the daemon may distill what worked into a
              proposed skill — it waits here (and in <code>rewter skills</code>) until you approve
              it.
            </p>
          )}

          {pending.length > 0 && (
            <div className="skills-pending">
              {pending.map((s) => (
                <PendingSkillCard key={s.path} skill={s} onWrote={() => void reload()} />
              ))}
            </div>
          )}

          {approved.length > 0 && (
            <table className="registry-table">
              <thead>
                <tr>
                  <th scope="col">skill</th>
                  <th scope="col">scope</th>
                  <th scope="col">description</th>
                  <th scope="col">uses</th>
                </tr>
              </thead>
              <tbody>
                {approved.map((s) => (
                  <tr className="registry-row" key={s.path}>
                    <th scope="row" title={s.path}>
                      <code>{s.slug}</code>
                    </th>
                    <td>{s.projectSlug ?? "global"}</td>
                    <td>{s.description}</td>
                    <td>{s.uses > 0 ? s.uses : <span className="dim">unused</span>}</td>
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

/**
 * One draft awaiting judgement.
 *
 * Both verbs are one-way doors (a move, a delete), so both report the daemon's
 * refusal verbatim instead of a generic failure — "an approved copy exists" and
 * "project ghost does not exist" each tell the owner a different thing to do.
 */
function PendingSkillCard({ skill, onWrote }: { skill: Skill; onWrote: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set by a 409: the next approve click carries `overwrite: true`, and the
  // button says so. Any other outcome clears it back to the plain verb.
  const [conflicted, setConflicted] = useState(false);
  const [armedReject, setArmedReject] = useState(false);

  const approve = async (): Promise<void> => {
    setBusy(true);
    const result = await approveSkill(skill.slug, conflicted);
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
    const result = await rejectSkill(skill.slug);
    setBusy(false);
    if (result.ok) onWrote();
    else setError(result.message);
  };

  return (
    <div className="skill-card" data-status="pending">
      <p>
        <strong>
          <code>{skill.slug}</code>
        </strong>{" "}
        <span className="dim">proposed → {skill.projectSlug ?? "global"}</span>
        {skill.learnedFrom !== null && (
          <span className="dim"> · learned from {skill.learnedFrom}</span>
        )}
      </p>
      <p>{skill.description}</p>
      <p className="dim">
        <code>{skill.path}</code> — edit the file first if it needs work; approve re-reads it
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
