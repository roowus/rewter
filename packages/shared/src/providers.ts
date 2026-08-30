/**
 * Asking a provider whether it would actually answer.
 *
 * Until now the only way to find out that a key was wrong, a base URL was
 * stale, or a local runtime was not running was to route a real request and
 * read the failure — which means discovering it mid-task, attributed to a model
 * rather than to the provider that could never have served it.
 *
 * The probe is deliberately the **catalog** read (`GET /models` and its
 * per-vendor equivalents), not a one-token completion. A catalog read carries
 * the same key down the same base URL, so it answers the same question, and it
 * bills nothing. A Test button that quietly spends money each time it is pressed
 * is a button people stop pressing.
 *
 * That choice has a cost, and `untestable` is it: six of the preset table's
 * upstreams expose no catalog endpoint, so for those the honest answer is "this
 * cannot be checked without spending", not a fabricated verdict.
 *
 * The five verdicts are separated by *where* the failure is, because that is
 * what decides what the user does next:
 *
 * - `no_key` — the env var this provider names is unset. Nothing left the
 *   machine; there was nothing to send.
 * - `unreachable` — the request went out and no answer came back. A dead local
 *   runtime, a typo'd host, no network.
 * - `refused` — the upstream answered, with a refusal. This is the one that
 *   means "your key is wrong" (401) or "your key is not entitled" (403).
 * - `untestable` — no catalog endpoint exists to ask.
 * - `ok` — a catalog came back, and `models` says how much of one.
 */
import { z } from "zod";
import { TimestampSchema } from "./entities.js";
import { ProviderIdSchema } from "./ids.js";

export const ProviderTestVerdictSchema = z.enum([
  "ok",
  "no_key",
  "unreachable",
  "refused",
  "untestable",
]);
export type ProviderTestVerdict = z.infer<typeof ProviderTestVerdictSchema>;

export const ProviderTestResultSchema = z.object({
  providerId: ProviderIdSchema,
  verdict: ProviderTestVerdictSchema,
  /**
   * One line for a human. Redacted: the key is never echoed back, not even
   * inside an upstream's own error text or a URL that carried it as a query
   * parameter (Google's catalog does exactly that).
   */
  message: z.string(),
  /** The upstream's status, when there was one. `null` for every other verdict. */
  statusCode: z.number().int().nullable(),
  /**
   * How many models the catalog listed. Only ever set on `ok` — and worth
   * showing, because "reachable but lists nothing" is a real state for a local
   * runtime with no model pulled.
   */
  models: z.number().int().nonnegative().nullable(),
  checkedAt: TimestampSchema,
});
export type ProviderTestResult = z.infer<typeof ProviderTestResultSchema>;
