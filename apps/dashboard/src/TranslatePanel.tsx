/**
 * What the model actually receives — survey shortlist item 5.
 *
 * rewter takes two downstream dialects and speaks three upstream ones, and
 * every bug in that mesh looks the same from where a user sits: "the model got
 * something I didn't send". Until now the only way to answer it was to read
 * three files and hold the translation in your head. This shows it: paste the
 * request, watch it become `ChatMessage[]`, watch that become the exact body
 * the chosen provider would be handed.
 *
 * Two panes are the point, not three. The middle one is where the dialects
 * converge — flip the toggle with the equivalent request in the other dialect
 * and the middle pane should not move. The right one is where the provider's
 * quirks apply, and quirks are invisible by construction: `max_tokens` becoming
 * `max_completion_tokens`, a system prompt hoisted back out to a top-level
 * parameter, a model id moving into the URL.
 *
 * Describing sends nothing and costs nothing, so it runs as you type. The Test
 * button below it is the opposite bargain and is drawn that way — it sends one
 * real completion, because a perfectly-shaped request still cannot tell you
 * whether the key works or whether that model id is one the upstream has ever
 * heard of. It reports what it billed.
 *
 * Collapsed by default: this is a "something is wrong" panel, like the log.
 */
import type { ChatTestResult, TranslateDialect, TranslateResponse } from "@rewter/shared";
import { useEffect, useState } from "react";
import { duration, usd } from "./format.js";
import { SAMPLE_BODY, chatTest, describeRequest, parseBody } from "./translate.js";

const DIALECTS: ReadonlyArray<{ value: TranslateDialect; label: string; route: string }> = [
  { value: "openai", label: "OpenAI", route: "/v1/chat/completions" },
  { value: "anthropic", label: "Anthropic", route: "/v1/messages" },
];

/** Debounce: describing is cheap, but one request per keystroke is still silly. */
const DEBOUNCE_MS = 300;

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

export function TranslatePanel(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [dialect, setDialect] = useState<TranslateDialect>("openai");
  const [body, setBody] = useState(SAMPLE_BODY.openai);
  const [result, setResult] = useState<TranslateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [prompt, setPrompt] = useState("Reply with one short sentence.");
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ChatTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const parsed = parseBody(body);
    if (!parsed.ok) {
      // A half-typed object is the normal state of a JSON editor. Say what is
      // wrong and keep the last good render on screen — blanking the panes on
      // every unbalanced brace makes the thing unusable to type into.
      setError(parsed.message);
      return;
    }
    const controller = new AbortController();
    const id = setTimeout(() => {
      void (async () => {
        const out = await describeRequest(
          { dialect, body: parsed.value },
          fetch,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (out.ok) {
          setResult(out.value);
          setError(null);
        } else if (out.message !== "aborted") {
          setError(out.message);
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(id);
      controller.abort();
    };
  }, [open, dialect, body]);

  /** Switching dialect swaps in that dialect's sample unless the box was edited. */
  const changeDialect = (next: TranslateDialect) => {
    setDialect(next);
    if (body.trim() === "" || body === SAMPLE_BODY[dialect]) setBody(SAMPLE_BODY[next]);
  };

  const runTest = () => {
    // The model comes from whatever is in the box, so the button tests the same
    // model the panes above are describing. No second field to keep in sync.
    const parsed = parseBody(body);
    const model = parsed.ok ? parsed.value.model : undefined;
    if (typeof model !== "string" || model === "") {
      setTestError("no model in the request above");
      return;
    }
    setTesting(true);
    setTestError(null);
    void (async () => {
      const out = await chatTest({ model, prompt }, fetch);
      setTesting(false);
      if (out.ok) {
        setTest(out.value);
        setTestError(null);
      } else {
        // The upstream's own sentence — "invalid x-api-key" is the entire
        // answer someone pressed this button to get.
        setTest(null);
        setTestError(out.message);
      }
    })();
  };

  const route = DIALECTS.find((d) => d.value === dialect)?.route ?? "";

  return (
    <section className="translate" aria-label="request translation">
      <header className="translate-head">
        <h2>translate</h2>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "hide" : "inspect a request"}
        </button>
        {open && <span className="dim">nothing is sent until you press Test</span>}
        {error !== null && <span className="error">{error}</span>}
      </header>

      {open && (
        <>
          <div className="translate-tabs" role="tablist" aria-label="request dialect">
            {DIALECTS.map((d) => (
              <button
                key={d.value}
                type="button"
                role="tab"
                aria-selected={dialect === d.value}
                onClick={() => changeDialect(d.value)}
                title={`as ${d.route} would receive it`}
              >
                {d.label}
              </button>
            ))}
            <span className="dim">{route}</span>
          </div>

          <div className="translate-panes">
            <div className="translate-pane">
              <h3>
                <label htmlFor="translate-body">as sent</label>
              </h3>
              <textarea
                id="translate-body"
                value={body}
                spellCheck={false}
                onChange={(e) => setBody(e.target.value)}
                rows={16}
              />
            </div>

            <div className="translate-pane">
              {/* The convergence pane. Flip the dialect toggle with the
                  equivalent request and this should not change. */}
              <h3>normalized</h3>
              <pre>{result === null ? "—" : pretty(result.normalized)}</pre>
            </div>

            <div className="translate-pane">
              <h3>
                upstream
                {result?.resolution != null && (
                  <span className="dim">
                    {" "}
                    {result.resolution.providerName} · {result.resolution.providerKind}
                  </span>
                )}
              </h3>
              {result === null ? (
                <pre>—</pre>
              ) : result.upstream === null ? (
                // A model that does not resolve, a disabled provider, or the
                // orchestrator. The first two panes are still real information.
                <p className="empty">{result.note ?? "no upstream request"}</p>
              ) : (
                <>
                  <p className="translate-target">
                    {result.resolution?.baseUrl ?? "(sdk default)"}
                    {result.upstream.path}
                  </p>
                  <pre>{pretty(result.upstream.body)}</pre>
                </>
              )}
            </div>
          </div>

          {/* ── the rung that spends ── */}
          <div className="translate-test">
            <label htmlFor="translate-prompt">test prompt</label>
            <input
              id="translate-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="say something short"
            />
            <button type="button" onClick={runTest} disabled={testing || prompt.trim() === ""}>
              {testing ? "sending…" : "Test — sends a real request"}
            </button>
            {testError !== null && <span className="error">{testError}</span>}
          </div>

          {test !== null && (
            <div className="translate-result">
              <p className="translate-answer">{test.text === "" ? "(empty answer)" : test.text}</p>
              <p className="dim">
                {test.modelId} · {test.finishReason} · {duration(test.latencyMs)} ·{" "}
                {test.usage.inputTokens} → {test.usage.outputTokens} tok ·{" "}
                {/* Null is "unpriced", which is not the same claim as "$0". */}
                {test.costUsd === null ? "unpriced" : usd(test.costUsd)}
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
