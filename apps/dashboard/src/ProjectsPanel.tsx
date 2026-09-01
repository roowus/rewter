/**
 * Projects — the standing context tasks run under (P2-M1).
 *
 * The panel edits exactly what the daemon folds into a task at creation: the
 * policy (auto-approve, spend cap — both tighten-only against the task's own
 * settings), the workspace directory, and the pinned initiator. It does NOT
 * show tasks; those are in the tree, and a task names its project, not the
 * other way round.
 *
 * The slug is shown but never editable — it is the project's address
 * (`auto@<slug>`, the `x-rewter-project` header), and the daemon refuses to
 * rename it for the same reason the form doesn't offer to. Archived rows keep
 * a separate, dimmer table rather than vanishing: unarchive has to find its
 * target, and a project someone archived by mistake should not require curl
 * to recover.
 *
 * Collapsed by default: like the registry, this is configuration you open on
 * purpose, not status you glance at.
 */
import { type Project, primaryWorkspace } from "@rewter/shared";
import { useCallback, useEffect, useState } from "react";
import { createProject, deleteProject, fetchProjects, patchProject } from "./projects.js";

export function ProjectsPanel(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    const result = await fetchProjects(fetch, signal);
    if (signal?.aborted) return;
    // A transient failure keeps the rows and says so, rather than emptying
    // the list into "no projects yet".
    if (result.ok) {
      setProjects(result.value);
      setError(null);
    } else if (result.message !== "aborted") setError(result.message);
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [open, reload]);

  const live = (projects ?? []).filter((p) => !p.archived);
  const archived = (projects ?? []).filter((p) => p.archived);

  return (
    <section className="projects" aria-label="projects">
      <header className="registry-head">
        <h2>projects</h2>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "hide" : "manage projects"}
        </button>
        {open && projects !== null && (
          <span className="dim">
            {live.length} live{archived.length > 0 && ` · ${archived.length} archived`}
          </span>
        )}
        {error !== null && <span className="error">{error}</span>}
      </header>

      {open && projects === null && error === null && <p className="empty">loading…</p>}

      {open && projects !== null && (
        <>
          <CreateForm onCreated={() => void reload()} />

          {live.length === 0 && archived.length === 0 ? (
            <p className="empty">
              No projects. A project gives tasks a standing workspace, a spend cap, and a pinned
              initiator — run under one with <code>auto@&lt;slug&gt;</code>.
            </p>
          ) : (
            <ProjectTable projects={live} onWrote={() => void reload()} />
          )}

          {archived.length > 0 && (
            <>
              <h3 className="dim">archived</h3>
              <ProjectTable projects={archived} onWrote={() => void reload()} />
            </>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Create takes the two required fields plus the one optional that changes
 * day-one behaviour: a workspace dir. Policy and pins start at the schema's
 * safe defaults (gated, uncapped, no pin) and are edited on the row after —
 * a create form that asked nine questions would mostly collect defaults.
 */
function CreateForm({ onCreated }: { onCreated: () => void }): JSX.Element {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { slug: slug.trim(), name: name.trim() };
    if (dir.trim() !== "") {
      body.resources = [{ kind: "dir", location: dir.trim(), note: null }];
    }
    const result = await createProject(body);
    setBusy(false);
    if (result.ok) {
      setSlug("");
      setName("");
      setDir("");
      onCreated();
    } else setError(result.message);
  };

  return (
    <div className="project-create">
      <div className="run-settings">
        <label htmlFor="proj-slug">slug</label>
        <input
          id="proj-slug"
          value={slug}
          placeholder="my-project"
          onChange={(e) => setSlug(e.target.value)}
          title="lowercase letters, digits, single dashes — this becomes auto@<slug> and cannot be renamed"
        />
        <label htmlFor="proj-name">name</label>
        <input
          id="proj-name"
          value={name}
          placeholder="My Project"
          onChange={(e) => setName(e.target.value)}
        />
        <label htmlFor="proj-dir">workspace</label>
        <input
          id="proj-dir"
          value={dir}
          placeholder="none — tasks get a scratch dir"
          onChange={(e) => setDir(e.target.value)}
          title="a directory tasks under this project work in by default"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || slug.trim() === "" || name.trim() === ""}
        >
          {busy ? "creating…" : "create"}
        </button>
      </div>
      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}

function ProjectTable({
  projects,
  onWrote,
}: {
  projects: Project[];
  onWrote: () => void;
}): JSX.Element {
  return (
    <table className="registry-table">
      <thead>
        <tr>
          <th scope="col">slug</th>
          <th scope="col">name</th>
          <th scope="col">workspace</th>
          <th scope="col">auto-approve</th>
          <th scope="col">cap</th>
          <th scope="col">pin</th>
          <th scope="col" />
        </tr>
      </thead>
      <tbody>
        {projects.map((p) => (
          <ProjectRow key={p.id} project={p} onWrote={onWrote} />
        ))}
      </tbody>
    </table>
  );
}

/**
 * One row, editable in place.
 *
 * The three edits offered are the three things the daemon reads at task
 * creation: policy (tighten-only fold), workspace (the default dir), and the
 * initiator pin. Resources beyond the first dir, prefer/avoid lists, and the
 * description stay curl-territory for now — the row edits what changes what a
 * run *does*, not everything the schema holds.
 */
function ProjectRow({ project, onWrote }: { project: Project; onWrote: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const write = async (patch: Record<string, unknown>, did: string): Promise<void> => {
    setBusy(true);
    const result = await patchProject(project.slug, patch);
    setBusy(false);
    setOutcome(result.ok ? (result.value.changed ? did : "no change") : result.message);
    if (result.ok && result.value.changed) onWrote();
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    const result = await deleteProject(project.slug);
    setBusy(false);
    setOutcome(result.ok ? "deleted" : result.message);
    if (result.ok) onWrote();
  };

  const workspace = primaryWorkspace(project);
  const cap = project.policy.maxSpendUsd;

  return (
    <tr className="registry-row" data-enabled={!project.archived}>
      <th scope="row" title={project.description !== "" ? project.description : undefined}>
        <code>{project.slug}</code>
      </th>
      <td>{project.name}</td>
      <td>
        {workspace !== null ? (
          <span title={workspace.location}>{workspace.location}</span>
        ) : (
          <span className="dim">scratch</span>
        )}
      </td>
      <td>
        {/* The project side of the AND. Off here means gated for every task
            under it, whatever the task asks for. */}
        <button
          type="button"
          onClick={() =>
            void write(
              { policy: { ...project.policy, autoApprove: !project.policy.autoApprove } },
              project.policy.autoApprove ? "now gated" : "now auto-approving",
            )
          }
          disabled={busy}
        >
          {project.policy.autoApprove ? "on" : "off"}
        </button>
      </td>
      <td>{cap !== null ? `$${cap}` : <span className="dim">uncapped</span>}</td>
      <td>{project.modelPrefs.initiatorPin ?? <span className="dim">auto</span>}</td>
      <td>
        <button
          type="button"
          onClick={() =>
            void write(
              { archived: !project.archived },
              project.archived ? "unarchived" : "archived",
            )
          }
          disabled={busy}
        >
          {project.archived ? "unarchive" : "archive"}
        </button>
        {project.archived && <DeleteButton onConfirm={() => void remove()} disabled={busy} />}
        {outcome !== null && <span className="dim"> {outcome}</span>}
      </td>
    </tr>
  );
}

/**
 * Delete only offers itself on archived rows — archive first is the everyday
 * path, and delete is for rows created by mistake. Task history keeps its
 * `projectId` either way; the daemon leaves it alone on purpose.
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
      really delete?
    </button>
  );
}
