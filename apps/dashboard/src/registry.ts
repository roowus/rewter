/**
 * The registry editor's fetch client.
 *
 * Like `costs.ts` and unlike everything else in this dashboard, this is REST
 * rather than a fold over the socket — and for a blunter reason. The registry
 * is not a stream of things that happened, it is a table of what is true now.
 * There is no `model.edited` event, because there is nothing about a price a
 * task tree would want to replay.
 *
 * What every function here has in common is that it parses the daemon's answer
 * rather than trusting it. These numbers become a bill: a bundle newer or older
 * than the daemon it is talking to should say so, not render `undefined` as a
 * dash that reads as free.
 *
 * Model ids contain slashes (`anthropic/claude-sonnet-5`), which is why the
 * server routes are trailing wildcards and why nothing here escapes them — a
 * `%2F` would arrive as a literal and match no model.
 */
import {
  type CapabilityCard,
  CapabilityCardSchema,
  type CardOverrides,
  type Model,
  ModelSchema,
  type Provider,
  ProviderSchema,
  type RegistryList,
  RegistryListSchema,
} from "@rewter/shared";
import { z } from "zod";

export type Result<T> = { ok: true; value: T } | { ok: false; message: string };

const fail = (message: string): Result<never> => ({ ok: false, message });

/**
 * One request, one parse, one error vocabulary.
 *
 * The daemon answers a rejected edit with `{ error: { message } }` — a zod
 * complaint naming the field, most usefully. Surfacing that verbatim is the
 * whole point: "pricing.inputPerMTok: Number must be greater than or equal to
 * 0" tells the user what to fix, and "daemon said 400" does not.
 */
async function request<T>(
  url: string,
  init: RequestInit,
  // Input is `unknown`, not `T`: several of these schemas unwrap an envelope
  // (`{card}` → card), and a schema that transforms has a different input type
  // from its output.
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  fetchImpl: typeof fetch,
): Promise<Result<T>> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") return fail("aborted");
    return fail("daemon unreachable");
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
    return fail(parsed.success ? parsed.data.error.message : `daemon said ${response.status}`);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) return fail("unrecognized response from daemon");
  return { ok: true, value: parsed.data };
}

const json = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

/** Models and their cards in one round-trip — see `RegistryListSchema`. */
export function fetchRegistry(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Result<RegistryList>> {
  return request(
    "/internal/models",
    signal === undefined ? {} : { signal },
    RegistryListSchema,
    fetchImpl,
  );
}

/** The provider list, for the create form's dropdown and to name a row's owner. */
export function fetchProviders(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Result<Provider[]>> {
  return request(
    "/internal/providers",
    signal === undefined ? {} : { signal },
    z.object({ providers: z.array(ProviderSchema) }).transform((b) => b.providers),
    fetchImpl,
  );
}

export interface PatchResult {
  model: Model;
  /**
   * `false` means the daemon compared the patch to the row and found nothing
   * different. Reported rather than swallowed: a Save that changed nothing is
   * a fact the user should hear, because the alternative is believing a price
   * was corrected when the form was showing a stale value.
   */
  changed: boolean;
}

export function patchModel(
  id: string,
  patch: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<PatchResult>> {
  return request(
    `/internal/models/${id}`,
    { ...json(patch), method: "PATCH" },
    z.object({ model: ModelSchema, changed: z.boolean() }),
    fetchImpl,
  );
}

export function createModel(
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<Model>> {
  return request(
    "/internal/models",
    json(body),
    z.object({ model: ModelSchema }).transform((b) => b.model),
    fetchImpl,
  );
}

export function deleteModel(id: string, fetchImpl: typeof fetch = fetch): Promise<Result<string>> {
  return request(
    `/internal/models/${id}`,
    { method: "DELETE" },
    z.object({ deleted: z.string() }).transform((b) => b.deleted),
    fetchImpl,
  );
}

/** `null` clears the patch, restoring the generated card verbatim. */
export function putCardOverrides(
  id: string,
  overrides: CardOverrides | null,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<CapabilityCard>> {
  return request(
    `/internal/card-overrides/${id}`,
    { ...json({ overrides }), method: "PUT" },
    z.object({ card: CapabilityCardSchema }).transform((b) => b.card),
    fetchImpl,
  );
}
