/**
 * The skills review surface's fetch client (P2-M4 slice 3).
 *
 * REST, like `projects.ts`: the skills index is a table of what is true now,
 * refreshed after every mutation by the daemon's own reindex — there is no
 * skill event stream to fold. Slugs carry no slash, so plain interpolation
 * into the route is safe.
 *
 * Approve and reject go through the daemon rather than the tree because the
 * daemon owns the index; the routes move the file *and* reindex atomically
 * from this client's point of view.
 */
import { type Skill, SkillSchema } from "@rewter/shared";
import { z } from "zod";
import { type Result, request } from "./registry.js";

export function fetchSkills(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Result<Skill[]>> {
  return request(
    "/internal/skills",
    signal === undefined ? {} : { signal },
    z.object({ skills: z.array(SkillSchema) }).transform((b) => b.skills),
    fetchImpl,
  );
}

export function approveSkill(
  slug: string,
  overwrite: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<Skill>> {
  return request(
    `/internal/skills/${slug}/approve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Strict body: `{}` unless the user explicitly chose to replace an
      // approved copy — the daemon 409s otherwise, and that refusal is shown.
      body: JSON.stringify(overwrite ? { overwrite: true } : {}),
    },
    z.object({ skill: SkillSchema }).transform((b) => b.skill),
    fetchImpl,
  );
}

export function rejectSkill(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<string>> {
  return request(
    `/internal/skills/${slug}/reject`,
    { method: "POST" },
    z.object({ rejected: z.string() }).transform((b) => b.rejected),
    fetchImpl,
  );
}
