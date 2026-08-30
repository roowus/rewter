/**
 * Providers, and whether they would actually answer.
 *
 * The registry panel below this one is about models — prices, context windows,
 * which rows the orchestrator may pick from. None of that matters if the
 * provider underneath is holding an unset env var or a stale base URL, and
 * until this panel existed the only way to discover that was to run a real task
 * and read the failure, which arrives attributed to a *model* rather than to the
 * provider that could never have served it.
 *
 * So the readiness line at the top counts **verdicts**, not rows. "4 providers"
 * is already on the health strip; "2 ok · 1 no key · 1 untestable" is the fact
 * that is nowhere else, and it only exists once someone has pressed something.
 * Before that the honest summary is "none tested yet" — not a green light
 * inferred from `enabled`, which only says a human has not switched the provider
 * off.
 *
 * Collapsed by default because the preset table is seventy-five upstreams: this
 * is a thing you open when something is wrong, not a thing you read every time
 * the page loads.
 */
import type { Provider, ProviderTestResult, ProviderTestVerdict } from "@rewter/shared";
import { useCallback, useEffect, useState } from "react";
import { fetchProviders, testProvider } from "./registry.js";

/** How many providers to probe at once from "test enabled". */
const TEST_CONCURRENCY = 4;

/** The five verdicts, in the order a reader should triage them. */
const VERDICT_ORDER: ProviderTestVerdict[] = [
  "refused",
  "no_key",
  "unreachable",
  "untestable",
  "ok",
];

const VERDICT_LABEL: Record<ProviderTestVerdict, string> = {
  ok: "ok",
  no_key: "no key",
  unreachable: "unreachable",
  refused: "refused",
  untestable: "untestable",
};

export function ProvidersPanel(): JSX.Element {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Map<string, ProviderTestResult>>(new Map());
  const [testing, setTesting] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void (async () => {
      const result = await fetchProviders(fetch, controller.signal);
      if (controller.signal.aborted) return;
      // Same rule as the registry: a transient failure keeps the rows and says
      // so, rather than emptying the list into "no providers configured".
      if (result.ok) {
        setProviders(result.value);
        setError(null);
      } else if (result.message !== "aborted") setError(result.message);
    })();
    return () => controller.abort();
  }, [open]);

  const runTest = useCallback(async (provider: Provider) => {
    setTesting((current) => new Set(current).add(provider.id));
    const result = await testProvider(provider.id, fetch);
    setTesting((current) => {
      const next = new Set(current);
      next.delete(provider.id);
      return next;
    });
    if (result.ok) {
      setResults((current) => new Map(current).set(provider.id, result.value));
      return;
    }
    // `ok: false` means rewter failed, not the provider — so it lands on the
    // panel's error line rather than being dressed up as a verdict about an
    // upstream nobody managed to ask.
    if (result.message !== "aborted") setError(result.message);
  }, []);

  /**
   * Probe every enabled provider, a few at a time.
   *
   * Enabled-only and not "all": a disabled provider cannot serve a request, so
   * testing it answers a question nobody asked — and on a registry seeded from
   * the full preset table that would be seventy-five outbound requests from one
   * click. The bound is here for the same reason.
   */
  const testEnabled = useCallback(async () => {
    const queue = (providers ?? []).filter((p) => p.enabled);
    for (let i = 0; i < queue.length; i += TEST_CONCURRENCY) {
      await Promise.all(queue.slice(i, i + TEST_CONCURRENCY).map((p) => runTest(p)));
    }
  }, [providers, runTest]);

  const enabled = (providers ?? []).filter((p) => p.enabled).length;

  return (
    <section className="providers" aria-label="providers">
      <header className="registry-head">
        <h2>providers</h2>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "hide" : "check providers"}
        </button>
        {open && providers !== null && (
          <span className="dim">
            <Readiness providers={providers} results={results} />
          </span>
        )}
        {error !== null && <span className="error">{error}</span>}
      </header>

      {open && providers === null && error === null && <p className="empty">loading…</p>}

      {open && providers !== null && providers.length === 0 && (
        <p className="empty">
          No providers. Check <code>~/.rewter/config.json</code>.
        </p>
      )}

      {open && providers !== null && providers.length > 0 && (
        <>
          <div className="registry-filter">
            <button type="button" onClick={() => void testEnabled()} disabled={enabled === 0}>
              test {enabled} enabled
            </button>
            <span className="dim">
              {/* Says what the button costs before it is pressed. A catalog read
                  is free; a button people suspect of spending is a button they
                  stop pressing. */}
              reads each provider's model catalog — no tokens are spent
            </span>
          </div>

          <table className="registry-table">
            <thead>
              <tr>
                <th scope="col">provider</th>
                <th scope="col">key</th>
                <th scope="col">on</th>
                <th scope="col">result</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {providers.map((provider) => (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  result={results.get(provider.id)}
                  testing={testing.has(provider.id)}
                  onTest={() => void runTest(provider)}
                />
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

/**
 * The readiness line.
 *
 * Counts verdicts, and says "none tested yet" until there is one — because the
 * question this panel answers is "would these answer", and `enabled` does not
 * answer it.
 */
function Readiness({
  providers,
  results,
}: {
  providers: Provider[];
  results: Map<string, ProviderTestResult>;
}): JSX.Element {
  const enabled = providers.filter((p) => p.enabled).length;
  const head = `${enabled} of ${providers.length} enabled`;
  if (results.size === 0) return <>{head} · none tested yet</>;

  const counts = new Map<ProviderTestVerdict, number>();
  for (const result of results.values()) {
    counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1);
  }
  const parts = VERDICT_ORDER.filter((v) => counts.has(v)).map(
    (v) => `${counts.get(v) ?? 0} ${VERDICT_LABEL[v]}`,
  );
  return <>{`${head} · ${parts.join(" · ")}`}</>;
}

function ProviderRow({
  provider,
  result,
  testing,
  onTest,
}: {
  provider: Provider;
  result: ProviderTestResult | undefined;
  testing: boolean;
  onTest: () => void;
}): JSX.Element {
  return (
    <tr className="registry-row" data-enabled={provider.enabled}>
      <th scope="row" title={provider.baseUrl ?? `${provider.kind} default base URL`}>
        {provider.name}
        <span className="best-at">{provider.kind}</span>
      </th>
      {/* The env var *name*, which is all the daemon stores and all this ever
          shows. A local runtime names none, and that is not a gap. */}
      <td>{provider.apiKeyRef ?? <span className="dim">none needed</span>}</td>
      <td>{provider.enabled ? "yes" : "no"}</td>
      <td>
        {result === undefined ? (
          <span className="dim">—</span>
        ) : (
          <span className="verdict" data-verdict={result.verdict} title={result.message}>
            {VERDICT_LABEL[result.verdict]}
            {result.verdict === "ok" && result.models !== null && (
              <span className="dim">{` · ${result.models} models`}</span>
            )}
          </span>
        )}
      </td>
      <td>
        <button type="button" onClick={onTest} disabled={testing}>
          {testing ? "testing…" : "test"}
        </button>
      </td>
    </tr>
  );
}
