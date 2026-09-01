/**
 * The projects panel on screen.
 *
 * What is only provable here: archived rows land in their own dimmer table
 * rather than vanishing (unarchive has to find its target); the create form
 * turns a workspace path into a `dir` resource rather than a string field the
 * daemon does not have; row edits report "no change" honestly instead of
 * pretending a stale save wrote something; and delete only offers itself on
 * rows that are already archived.
 */
import type { Project } from "@rewter/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectsPanel } from "./ProjectsPanel.js";

const project = (over: Record<string, unknown> = {}): Project =>
  ({
    id: "proj_aaaaaaaaaaaa",
    slug: "my-proj",
    name: "My Project",
    description: "",
    resources: [],
    policy: { autoApprove: false, maxSpendUsd: null, allowedTools: null, allowedHarnesses: null },
    modelPrefs: { initiatorPin: null, prefer: [], avoid: [] },
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as unknown as Project;

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Serves the list on GET; records and answers every write. */
function stubFetch(options: {
  projects?: Project[];
  onWrite?: (url: string, init: RequestInit) => Response;
}): { writes: Array<{ url: string; method: string; body: unknown }> } {
  const writes: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      if (method === "GET") return ok({ projects: options.projects ?? [project()] });
      writes.push({
        url: href,
        method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return (
        options.onWrite?.(href, init as RequestInit) ??
        ok(method === "DELETE" ? { deleted: "my-proj" } : { project: project(), changed: true })
      );
    }),
  );
  return { writes };
}

/** Opens the panel and waits for a row to render. */
async function open(row = "My Project"): Promise<void> {
  render(<ProjectsPanel />);
  fireEvent.click(screen.getByRole("button", { name: "manage projects" }));
  await screen.findByText(row);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProjectsPanel", () => {
  it("does not ask the daemon anything until it is opened", () => {
    const impl = vi.fn(async () => ok({ projects: [] }));
    vi.stubGlobal("fetch", impl);
    render(<ProjectsPanel />);
    expect(impl).not.toHaveBeenCalled();
  });

  it("splits live from archived instead of hiding the archived ones", async () => {
    stubFetch({
      projects: [
        project(),
        project({ id: "proj_bbbbbbbbbbbb", slug: "old-proj", name: "Old", archived: true }),
      ],
    });
    await open();
    // Both on screen — the archived one under its own heading, still findable
    // by the unarchive button that needs it.
    expect(screen.getByText("archived")).toBeTruthy();
    expect(screen.getByText("Old")).toBeTruthy();
    expect(screen.getByText(/1 live · 1 archived/)).toBeTruthy();
  });

  it("creates with a workspace as a dir resource, not a loose string", async () => {
    const { writes } = stubFetch({ projects: [] });
    render(<ProjectsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "manage projects" }));
    await screen.findByLabelText("slug");

    fireEvent.change(screen.getByLabelText("slug"), { target: { value: "my-proj" } });
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "My Project" } });
    fireEvent.change(screen.getByLabelText("workspace"), {
      target: { value: "/Users/rewis/projects/thing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "create" }));

    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]?.body).toEqual({
      slug: "my-proj",
      name: "My Project",
      resources: [{ kind: "dir", location: "/Users/rewis/projects/thing", note: null }],
    });
  });

  it("creates without a resources field when no workspace was given", async () => {
    // Omitted, not `resources: []` — the schema's default fills it, and the
    // body should say only what the user said.
    const { writes } = stubFetch({ projects: [] });
    render(<ProjectsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "manage projects" }));
    await screen.findByLabelText("slug");

    fireEvent.change(screen.getByLabelText("slug"), { target: { value: "bare" } });
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Bare" } });
    fireEvent.click(screen.getByRole("button", { name: "create" }));

    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]?.body).toEqual({ slug: "bare", name: "Bare" });
  });

  it("shows the daemon's 409 sentence when the slug is taken", async () => {
    stubFetch({
      projects: [],
      onWrite: () => ok({ error: { message: "project my-proj already exists" } }, 409),
    });
    render(<ProjectsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "manage projects" }));
    await screen.findByLabelText("slug");

    fireEvent.change(screen.getByLabelText("slug"), { target: { value: "my-proj" } });
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Again" } });
    fireEvent.click(screen.getByRole("button", { name: "create" }));

    await screen.findByText("project my-proj already exists");
  });

  it("toggles auto-approve by PATCHing the whole policy", async () => {
    const { writes } = stubFetch({});
    await open();
    fireEvent.click(screen.getByRole("button", { name: "off" }));

    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]?.url).toBe("/internal/projects/my-proj");
    expect(writes[0]?.body).toEqual({
      policy: {
        autoApprove: true,
        maxSpendUsd: null,
        allowedTools: null,
        allowedHarnesses: null,
      },
    });
  });

  it("says 'no change' when the daemon compared and found nothing different", async () => {
    stubFetch({ onWrite: () => ok({ project: project(), changed: false }) });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "off" }));
    await screen.findByText(/no change/);
  });

  it("archives from the row, and only then offers delete", async () => {
    stubFetch({});
    await open();
    // A live row has no delete button — archive is the everyday off-switch.
    expect(screen.queryByRole("button", { name: "delete" })).toBeNull();
    expect(screen.getByRole("button", { name: "archive" })).toBeTruthy();
  });

  it("asks twice before deleting an archived row", async () => {
    const { writes } = stubFetch({ projects: [project({ archived: true })] });
    await open();

    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    // Armed, not fired: the first click only changes the question.
    expect(writes.length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "really delete?" }));

    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]?.method).toBe("DELETE");
    expect(writes[0]?.url).toBe("/internal/projects/my-proj");
  });

  it("keeps the rows on screen when a reload fails", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls > 1) throw new TypeError("fetch failed");
        return ok({ projects: [project()] });
      }),
    );
    render(<ProjectsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "manage projects" }));
    await screen.findByText("My Project");

    fireEvent.click(screen.getByRole("button", { name: "hide" }));
    fireEvent.click(screen.getByRole("button", { name: "manage projects" }));
    await screen.findByText("daemon unreachable");
    expect(screen.getByText("My Project")).toBeTruthy();
  });
});
