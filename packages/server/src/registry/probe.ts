/**
 * The probe behind the Test button.
 *
 * `sync.ts` already carries a key down a base URL and reads what comes back —
 * this asks the same question and throws the catalog away. Sharing the request
 * is the point: a test that took a different path could pass while the path
 * that matters fails.
 *
 * What it adds over sync is **classification**. Sync reports one `error` string
 * per provider, which is right for a batch refresh and useless for a single
 * button, because "unset env var", "host is dead" and "your key was rejected"
 * are three different things to go and do. See `ProviderTestResult` in
 * `@rewter/shared` for the five verdicts.
 *
 * Redaction is not incidental here. Google authenticates its catalog by query
 * parameter, so a thrown `fetch` error can carry the key inside the URL it
 * prints, and an upstream is free to quote your key back in its own error body.
 * Every message this module returns is passed through `redact()` before it
 * leaves — the key is known here, so removing it is a substring replacement
 * rather than a guess at what a secret looks like.
 */
import type { Provider, ProviderTestResult, ProviderTestVerdict } from "@rewter/shared";
import { presetForProvider, presetSlugForProvider } from "../providers/presets.js";
import { CatalogError, type CatalogOptions, canSync, fetchCatalog } from "./catalog.js";

export interface ProbeOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
  signal?: AbortSignal;
}

/**
 * Ask one provider whether it would answer.
 *
 * Never throws for an upstream's sake: every failure mode is a verdict, because
 * a Test button that 500s has told you about rewter rather than about the
 * provider you asked about.
 */
export async function probeProvider(
  provider: Provider,
  opts: ProbeOptions = {},
): Promise<ProviderTestResult> {
  const env = opts.env ?? process.env;
  const checkedAt = (opts.clock ?? Date.now)();
  const slug = presetSlugForProvider(provider);
  const preset = presetForProvider(provider);
  const result = (
    verdict: ProviderTestVerdict,
    message: string,
    extra: { statusCode?: number | null; models?: number | null } = {},
  ): ProviderTestResult => ({
    providerId: provider.id,
    verdict,
    message,
    statusCode: extra.statusCode ?? null,
    models: extra.models ?? null,
    checkedAt,
  });

  const apiKey = provider.apiKeyRef === null ? null : (env[provider.apiKeyRef] ?? null);
  // A local runtime names no env var at all; only a provider that *asked* for a
  // key can be missing one.
  if (provider.apiKeyRef !== null && (apiKey === null || apiKey === "")) {
    return result("no_key", `${provider.apiKeyRef} is not set — nothing was sent`);
  }

  if (!canSync(preset)) {
    // The honest answer. The alternative is billing the user a token to find
    // out, silently, every time they press a button.
    return result(
      "untestable",
      `${slug} publishes no model catalog — cannot check without spending`,
    );
  }

  const catalogOpts: CatalogOptions = {
    apiKey,
    baseUrl: provider.baseUrl ?? preset?.baseUrl ?? null,
    ...(opts.fetch !== undefined && { fetch: opts.fetch }),
    ...(opts.signal !== undefined && { signal: opts.signal }),
  };

  try {
    const catalog = await fetchCatalog({ slug, kind: provider.kind }, catalogOpts);
    const n = catalog.entries.length;
    return result("ok", n === 1 ? "reachable, 1 model listed" : `reachable, ${n} models listed`, {
      models: n,
    });
  } catch (err) {
    if (err instanceof CatalogError && err.statusCode !== null) {
      return result("refused", redact(explain(err.statusCode, slug), apiKey), {
        statusCode: err.statusCode,
      });
    }
    // No status means no answer: DNS, connection refused, TLS, a parse of a
    // body that never arrived. All of it is "the host did not answer".
    const detail = err instanceof Error ? err.message : String(err);
    return result("unreachable", redact(`no answer from ${slug}: ${detail}`, apiKey));
  }
}

/**
 * Turn a status into the sentence that says what to do about it.
 *
 * Only the codes whose meaning is stable across vendors get a gloss; the rest
 * are reported as the number, which is more useful than a confident wrong
 * paraphrase.
 */
function explain(status: number, slug: string): string {
  switch (status) {
    case 401:
      return `${slug} rejected the key (401) — it is set, but wrong or revoked`;
    case 403:
      return `${slug} refused the key (403) — set, accepted, not entitled to this`;
    case 404:
      return `${slug} has no catalog at that URL (404) — check the base URL`;
    case 429:
      return `${slug} is rate-limiting (429) — the key works, try again shortly`;
    default:
      return status >= 500
        ? `${slug} is failing on its own side (HTTP ${status})`
        : `${slug} answered HTTP ${status}`;
  }
}

/**
 * Remove the key from anything about to be shown or logged.
 *
 * Both raw and percent-encoded, because Google's catalog URL carries it through
 * `encodeURIComponent` and that URL is what a fetch error prints. Very short
 * keys are left alone: a two-character "key" would blank out half the message
 * for no security gain.
 */
function redact(message: string, apiKey: string | null): string {
  if (apiKey === null || apiKey.length < 8) return message;
  const encoded = encodeURIComponent(apiKey);
  return message.split(apiKey).join("«redacted»").split(encoded).join("«redacted»");
}
