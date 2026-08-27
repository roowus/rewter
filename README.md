# rewter

**An AI model router where the AI runs the routing.**

rewter is an OpenAI-compatible, multi-provider AI model router (in the family of
OpenRouter / 9router) with one defining twist: alongside plain model routing, it exposes an
**orchestrator pseudo-model**. Send a task to `auto/orchestrator` like any other model, and
an *initiator AI* decomposes it, delegates subtasks to the best/cheapest-fit models **in
parallel**, collects their reports, and hands itself off to a stronger model if it decides
it's not fit to lead. You watch and control everything from a live dashboard.

```
your client (Claude Code, curl, any OpenAI or Anthropic client)
  │  POST /v1/chat/completions  ·  POST /v1/messages
  │  model: "auto/orchestrator" (or any concrete model)
  ▼
┌────────────────── rewter daemon ──────────────────┐
│ plain routing (any concrete model) ──────────────▶│──▶ Anthropic / OpenAI / Z.AI / xAI /
│ or:                                               │    Google / OpenRouter / Ollama / …
│  initiator AI plans, then fans out:               │
│    ├─▶ cheap model   · tier 1: bare call          │
│    ├─▶ agent worker  · tier 2: files/shell/web    │
│    └─▶ harness       · tier 3: Claude Code, aider │ (phase 2)
│  approval gates ⏸ · live task tree · cost tracking│
└───────────────────────────────────────────────────┘
         ▲ web dashboard: watch, approve, steer, kill
```

## Why

- **Speed** — independent subtasks run on parallel workers.
- **Cost** — cheap models execute, smart models plan and review; every token is metered.
- **Specialization** — OCR, vision, and coding-specialized models get used where they fit,
  chosen via machine-readable **capability cards** in a model registry.

## Providers

Breadth is a design goal — **27 upstreams ship as built-in presets**, and adding another is
a table row (slug, base URL, env var name, quirks), not new code:

| | |
|---|---|
| **First-party SDKs** | Anthropic, Google Gemini, OpenAI |
| **Aggregators** | OpenRouter, Together, Fireworks, Groq, DeepInfra, Hyperbolic, Nebius, Novita, SambaNova, Cerebras, Perplexity, GitHub Models |
| **Direct vendors** | xAI, Z.AI/GLM, Moonshot, DeepSeek, Mistral, Cohere, Qwen, MiniMax, Baseten |
| **Local runtimes** | Ollama, LM Studio, llama.cpp, vLLM |

Three adapter classes cover all of them (`anthropic`, `openai-compat`, `google`), and one
shared contract test suite holds every adapter to an identical normalized stream shape. API
keys are referenced by **environment variable name** — raw keys are never stored in the
database.

## Status

**Early development — phase 1 (MVP) in progress.** See [docs/progress.md](docs/progress.md)
for the milestone board and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

Working today (M0–M3d): the **plain routing** path end to end — a bootable daemon
(`rewter start`), both client dialects (`POST /v1/chat/completions` for OpenAI clients and
`POST /v1/messages` for Anthropic ones, streaming and not), `GET /v1/models`, model
resolution across all 27 upstreams, retry, SSE, and per-request cost metering. **Claude Code
runs on it** — verified live end to end, tool calls included, against two upstreams. The
orchestrator pseudo-model is listed but returns `501` until M5.

Landing now (M4): the **model registry** the orchestrator will choose from — capability-card
storage, where a hand correction survives card regeneration and cannot rewrite the card's
provenance; the digest renderer that turns the registry into one compact, byte-stable line per
model; and **`rewter sync-models`**, which fills the registry from the providers' own catalogs.
AI card generation is next.

## Quickstart

```sh
pnpm install && pnpm build
```

Write `~/.rewter/config.json` — name providers by preset slug, and export the keys
separately. **The config file never holds a key**: `apiKeyEnv` is the *name* of an
environment variable.

```jsonc
{
  "providers": [
    { "preset": "anthropic" },              // reads $ANTHROPIC_API_KEY
    { "preset": "zai" }                     // reads $ZAI_API_KEY
  ],
  "models": [
    { "id": "anthropic/claude-sonnet-5", "provider": "anthropic", "contextWindow": 200000,
      "pricing": { "inputPerMTok": 3, "outputPerMTok": 15 } },
    { "id": "zai/glm-5.3", "provider": "zai", "contextWindow": 1000000,
      "pricing": { "inputPerMTok": 0.6, "outputPerMTok": 2.2 } }
  ]
}
```

```sh
export ANTHROPIC_API_KEY=… ZAI_API_KEY=…
node packages/cli/dist/index.js start
# rewter listening on http://127.0.0.1:20130 — 2 provider(s), 2 model(s)
```

Port **20130** is deliberately not 9router's 20128, so both can run side by side while you
switch. A provider whose key variable is unset still appears — seeded *disabled*, so asking
for its model gives a 503 that names it rather than a confusing "unknown model".

Point any OpenAI client at it:

```sh
curl localhost:20130/v1/models
curl localhost:20130/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"zai/glm-5.3","messages":[{"role":"user","content":"say hi"}],"stream":true}'
```

…or any Anthropic client, including **Claude Code**, at the same daemon — `/v1/messages`
speaks Anthropic's dialect over the same router, so every model above is reachable from it:

```sh
ANTHROPIC_BASE_URL=http://localhost:20130 ANTHROPIC_MODEL=zai/glm-5.3 claude
# ⚠ an `env` block in ~/.claude/settings.json *overrides* these — if you have one,
#   put the same values there, or pass `--settings <file>`. Otherwise the session
#   silently goes to whatever that file points at, and looks like it worked.

curl localhost:20130/v1/messages -H 'content-type: application/json' \
  -d '{"model":"zai/glm-5.3","max_tokens":64,"messages":[{"role":"user","content":"say hi"}]}'
```

Set `apiKeyEnv` in the config (default `REWTER_API_KEY`) and export that variable to require
a token on `/v1`. Both header conventions work against it — `Authorization: Bearer …` (what
OpenAI clients send) and `x-api-key` (what Anthropic clients send) — so one value covers
both surfaces. Leave it unset and the local daemon is open.

Other knobs: `--config <path>` / `REWTER_CONFIG`, `REWTER_PORT`, `REWTER_HOST`, `REWTER_DB`.

### Filling the registry automatically

Hand-writing the `models` array gets old fast. `sync-models` reads each provider's own catalog
instead — it opens the same database the daemon uses, so it works whether or not the daemon is
running:

```sh
node packages/cli/dist/index.js sync-models
# openai: 84 added, 0 updated
# openrouter: 319 added, 0 updated
# New models arrive disabled; enable the ones you want in the config or dashboard.
```

New models arrive **disabled** — a catalog is hundreds of rows, and enabling all of them would
bill against models you never chose. Most upstreams publish an id list and nothing else, so
OpenRouter's prices fill the gaps in the others by default (`--no-enrich` opts out). Sync never
overwrites a model you wrote by hand — it only fills the fields you left blank — and never
deletes: a model that disappears upstream is disabled, so the cost records pointing at it keep
their referent.

`--dry-run` reports without writing; `--provider <slug>` scopes to one.

## Development

```sh
pnpm install
pnpm build     # build all packages
pnpm test      # run all tests
pnpm lint      # biome
```

Requires Node ≥ 22 and pnpm 10.

## License

[MIT](LICENSE)
