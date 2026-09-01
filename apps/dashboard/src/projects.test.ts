/**
 * The projects fetch client.
 *
 * The patch/delete plumbing is `registry.ts`'s `request` helper, tested there.
 * What is only provable here: the list always asks for archived rows (an
 * unarchive button cannot exist on a list that hides its target), routes
 * address projects by slug rather than id, and the daemon's own refusals reach
 * the caller as sentences.
 */
import { describe, expect, it, vi } from "vitest";
import { createProject, deleteProject, fetchProjects, patchProject } from "./projects.js";

const PROJECT = {
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
};

const respond = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

describe("fetchProjects", () => {
  it("always asks for archived rows — hiding is the panel's decision", async () => {
    const spy = vi.fn(respond({ projects: [PROJECT] }));
    await fetchProjects(spy as typeof fetch);
    expect(spy.mock.calls[0]?.[0]).toBe("/internal/projects?includeArchived=true");
  });

  it("unwraps the envelope to the rows themselves", async () => {
    const result = await fetchProjects(respond({ projects: [PROJECT] }));
    expect(result.ok && result.value[0]?.slug).toBe("my-proj");
  });

  it("refuses a shape it does not recognize rather than rendering blanks", async () => {
    const result = await fetchProjects(respond({ projects: [{ slug: "x" }] }));
    expect(result).toEqual({ ok: false, message: "unrecognized response from daemon" });
  });
});

describe("createProject", () => {
  it("POSTs the body and hands back the project the daemon minted", async () => {
    const spy = vi.fn(respond({ project: PROJECT }, 201));
    const result = await createProject(
      { slug: "my-proj", name: "My Project" },
      spy as typeof fetch,
    );
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/internal/projects");
    expect(init.method).toBe("POST");
    expect(result.ok && result.value.id).toBe("proj_aaaaaaaaaaaa");
  });

  it("surfaces the daemon's 409 sentence — a taken slug is the user's news", async () => {
    const result = await createProject(
      { slug: "my-proj", name: "Again" },
      respond({ error: { message: "project my-proj already exists" } }, 409),
    );
    expect(result).toEqual({ ok: false, message: "project my-proj already exists" });
  });
});

describe("patchProject", () => {
  it("addresses the project by slug, the same name auto@<slug> uses", async () => {
    const spy = vi.fn(respond({ project: PROJECT, changed: true }));
    await patchProject("my-proj", { archived: true }, spy as typeof fetch);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/internal/projects/my-proj");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ archived: true });
  });

  it("reports changed:false rather than treating it as a save", async () => {
    const result = await patchProject("my-proj", {}, respond({ project: PROJECT, changed: false }));
    expect(result.ok && result.value.changed).toBe(false);
  });
});

describe("deleteProject", () => {
  it("uses DELETE and reports the slug the daemon says it removed", async () => {
    const spy = vi.fn(respond({ deleted: "my-proj" }));
    const result = await deleteProject("my-proj", spy as typeof fetch);
    expect((spy.mock.calls[0]?.[1] as RequestInit).method).toBe("DELETE");
    expect(result.ok && result.value).toBe("my-proj");
  });
});
