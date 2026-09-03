/**
 * The practices review surface's fetch client.
 *
 * REST, like `skills.ts`: the practices index is a table of what is true now,
 * refreshed after every mutation by the daemon's own reindex. Slugs carry no
 * slash, so plain interpolation into the route is safe.
 */
import { type Practice, PracticeSchema } from "@rewter/shared";
import { z } from "zod";
import { type Result, request } from "./registry.js";

export function fetchPractices(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Result<Practice[]>> {
  return request(
    "/internal/practices",
    signal === undefined ? {} : { signal },
    z.object({ practices: z.array(PracticeSchema) }).transform((b) => b.practices),
    fetchImpl,
  );
}

export function approvePractice(
  slug: string,
  overwrite: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<Practice>> {
  return request(
    `/internal/practices/${slug}/approve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Strict body: `{}` unless the user explicitly chose to replace an
      // approved copy — the daemon 409s otherwise, and that refusal is shown.
      body: JSON.stringify(overwrite ? { overwrite: true } : {}),
    },
    z.object({ practice: PracticeSchema }).transform((b) => b.practice),
    fetchImpl,
  );
}

export function rejectPractice(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<string>> {
  return request(
    `/internal/practices/${slug}/reject`,
    { method: "POST" },
    z.object({ rejected: z.string() }).transform((b) => b.rejected),
    fetchImpl,
  );
}
