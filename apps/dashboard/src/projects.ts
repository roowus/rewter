/**
 * The projects editor's fetch client.
 *
 * REST, like `registry.ts` and for the same reason: a project is a table of
 * what is true now, not a stream of things that happened — there is no
 * `project.edited` event because there is nothing about a spend cap a task
 * tree would want to replay.
 *
 * Routes address a project by **slug**, the same string `auto@<slug>` and the
 * `x-rewter-project` header use — one name for one thing, and unlike model ids
 * a slug carries no slash, so nothing here needs wildcard care.
 */
import { type Project, ProjectSchema } from "@rewter/shared";
import { z } from "zod";
import { type Result, request } from "./registry.js";

const json = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

/**
 * Always `includeArchived=true`: this client serves the settings screen, and
 * an unarchive button cannot exist on a list that hides its target. The
 * *panel* separates live rows from archived ones; hiding is a rendering
 * decision, not a fetching one.
 */
export function fetchProjects(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Result<Project[]>> {
  return request(
    "/internal/projects?includeArchived=true",
    signal === undefined ? {} : { signal },
    z.object({ projects: z.array(ProjectSchema) }).transform((b) => b.projects),
    fetchImpl,
  );
}

export function createProject(
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<Project>> {
  return request(
    "/internal/projects",
    json(body),
    z.object({ project: ProjectSchema }).transform((b) => b.project),
    fetchImpl,
  );
}

export interface ProjectPatchResult {
  project: Project;
  /**
   * `false` means the daemon compared the patch to the row and found nothing
   * different — reported, not swallowed, same as the model editor: a Save that
   * changed nothing is a fact the user should hear.
   */
  changed: boolean;
}

export function patchProject(
  slug: string,
  patch: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<ProjectPatchResult>> {
  return request(
    `/internal/projects/${slug}`,
    { ...json(patch), method: "PATCH" },
    z.object({ project: ProjectSchema, changed: z.boolean() }),
    fetchImpl,
  );
}

export function deleteProject(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<string>> {
  return request(
    `/internal/projects/${slug}`,
    { method: "DELETE" },
    z.object({ deleted: z.string() }).transform((b) => b.deleted),
    fetchImpl,
  );
}
