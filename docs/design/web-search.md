# `web_search` for tier-2 workers

Status: **shipped 2026-09-02** (closes [#10](https://github.com/roowus/rewter/issues/10)).

## The gap

The tier-2 tool list named `web_search` next to `web_fetch` from the first design, and the
built list did not have it. A worker could read a URL it was given and could not find one:
"summarize these 3 URLs and compare" worked, "find out what X says about Y" did not. The
tool-name test asserted its absence exactly, so the gap was a decision rather than an
omission — but it was the wrong decision for the motivating example, and issue #10 asked
for a design note before code. This is that note.

## Options considered

The issue laid out three, each with a cost.

1. **A search API** (Brave, Tavily, SerpAPI, …). A key and possibly a bill, against the
   project's free-first lean. Simple to call, one wire shape per vendor, available to every
   model.
2. **Scraping a search engine.** No key, but fragile — result-page markup changes without
   notice — and rate-limited in practice, which is a worse failure than a missing tool
   because it fails only sometimes.
3. **Delegating to a provider with native search** (Anthropic web search, Gemini grounding).
   Free-ish where the operator already pays that provider, and the registry already models
   per-model capabilities. But the tool would exist only on some models, which nothing else
   in the tier-2 loop is: the loop's contract with the model is "these are your tools", not
   "these are your tools if you are the right model". The capability card and the digest
   would have to represent it, `spawn_worker` would have to route on it, and a worker handed
   off to a cheaper model mid-task would silently lose a tool.

## Decision

**Option 1, made free-first by putting searxng first**, and **no per-model dependence**.

- `searxng` is a self-hosted metasearch engine with a JSON API and no key. An operator who
  runs one (the common local-first setup) configures a base URL and has search on every
  model. This is the recommended path.
- `brave` and `tavily` are the two hosted vendors with usable free tiers and stable, small
  JSON APIs. A key is referenced by env var *name*, never stored.
- Option 3 is not ruled out; it is a different feature. If a model's native search proves
  worth it, it belongs in the provider adapter as a model capability the digest advertises,
  and the initiator picks the model for it — the same way it picks a vision model for an
  image. It does not belong in the tier-2 tool list, where availability must be the same for
  every model on the daemon.

The key property, and the one the tests pin: **the tool is declared only where a backend
exists.** A daemon with no `search.provider` never tells a worker `web_search` exists. The
alternative — declare it everywhere and return "not configured" — costs a turn to discover
and invites a retry, which is exactly the objection that kept the tool absent for so long.

## Configuration

```jsonc
"search": {
  "provider": "searxng",          // "searxng" | "brave" | "tavily" | null (default null)
  "baseUrl": "http://localhost:8888", // required for searxng; optional endpoint override otherwise
  "apiKeyEnv": null,              // env var NAME; defaults BRAVE_SEARCH_API_KEY / TAVILY_API_KEY
  "maxResults": 8                 // per call; hard max 20
}
```

The block is the one part of the config schema that is `strict`. There is no field a pasted
key could land in: `"apiKey": "BSA-…"` is refused at load with the offending key named,
rather than silently ignored and left sitting in a file people paste into issues.

A configured provider whose key variable is unset is **a boot warning and an undeclared
tool, not a boot failure** — the same treatment a provider with a missing key gets. The
warning names the variable, never its value.

## The backends

All three live in `packages/server/src/workers/search.ts` behind one interface:

```ts
interface SearchBackend {
  readonly id: "searxng" | "brave" | "tavily";
  search(q: { query; maxResults; signal }, fetchImpl?): Promise<{ title; url; snippet }[]>;
}
```

| backend | request | reads |
|---|---|---|
| searxng | `GET <base>/search?q=…&format=json` (appends `/search` unless the path already ends in it, for reverse-proxied instances) | `results[].{title,url,content}` |
| brave | `GET https://api.search.brave.com/res/v1/web/search?q=…&count=N`, `X-Subscription-Token` | `web.results[].{title,url,description}` |
| tavily | `POST https://api.tavily.com/search` `{query, max_results}`, `Authorization: Bearer` | `results[].{title,url,content}` |

Shared rules:

- The endpoint must be http(s). The config schema only checks `url()`, so `file:` gets as
  far as the backend and is refused there, before any fetch.
- A hit without an http(s) URL is dropped. A result the worker cannot `web_fetch` is not a
  result, and a `javascript:` URL is not one anyone should be shown.
- A non-2xx answer is an error naming the vendor and the status. A 200 whose body is not
  JSON (a searxng with `format=json` disabled answers with an HTML page) is an error saying
  so, not a stack trace from `JSON.parse`.
- The abort signal is passed through, so a cancelled worker cancels its search.
- `fetchImpl` is injectable. The tests assert each vendor's exact wire shape — method,
  headers, query string, body — against a stub, with no network.

## The tool

`web_search({ query, max_results? })`, ungated like `web_fetch`: it reads the network, not
the disk, and the path gate has nothing to say about it. The executor:

- clamps `max_results` to the configured cap (the model may ask for fewer, never more);
- renders a numbered list — title, URL, snippet — sized for "pick one or two to fetch"
  rather than for reading. Snippets are whitespace-collapsed and clipped to 400 characters
  with an ellipsis; a hit whose title is missing shows its URL as the title;
- returns every failure as text: `no results for: …`, `search failed (brave): Brave Search
  returned HTTP 429 …`. Nothing throws except a bug.

Availability is one value per run, `WorkerToolAvailability { webSearch }`, and **both** the
declared list (`workerToolDefinitions`) and the accepted list (`parseWorkerArgs`) derive
from it. A worker that calls an undeclared `web_search` gets `no such tool "web_search".
Available: …` — the same message as any other typo, and the list it shows does not include
the tool. The tier-2 prompt says outright that an absent `web_search` means the daemon has
no search backend, so the model reads absence as a fact about the host and works from URLs
it already has.

## Plumbing

`createSearchBackend(config.search, env)` runs **once at daemon boot** and its result goes
to the `Orchestrator` as `search: { backend, maxResults } | null`, which the engine spreads
into every tier-2 runner. Resolving at boot rather than per call means a misconfiguration is
one warning in the boot log, next to the "provider disabled" lines, and never a surprise
mid-task.

Versions: `WORKER_TOOLS_VERSION` 2 → 3 (new tool), `ORCHESTRATOR_PROMPT_VERSION` 7 → 8
(new tier-2 bullet). Both are asserted in tests, as every prompt text is.

## Later

- **Provider-native search** as a model capability (option 3 above), advertised in the
  digest so the initiator can choose a model for it. Separate feature; does not change this
  tool.
- **A per-project override** of the search block, once a project needs a different instance
  than the daemon default. Nothing about the plumbing forbids it; nothing yet asks for it.
