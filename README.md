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
runs on it** — verified live end to end, tool calls included, against two upstreams.

Done (M4): the **model registry** the orchestrator chooses from — capability-card storage, where
a hand correction survives card regeneration and cannot rewrite the card's provenance; the digest
renderer that turns the registry into one compact, byte-stable line per model;
**`rewter sync-models`**, which fills the registry from the providers' own catalogs; and
**`rewter card`**, where one model writes the capability card for another.

Done (M5a): the **orchestrator engine** — the loop that *is* `auto/orchestrator`. Parallel
tier-1 fan-out onto a concurrency limiter, `wait` in `all`/`any` modes, summaries by default
with full text on request, progress narrated as ordinary text down the same stream, handoff to
a stronger model, an AbortController tree for cancellation, and a spending cap read back from
the cost ledger rather than counted in memory. It returns the *same* stream type a plain model
call does, so the HTTP layer needs no special case for it.

Done (M5b): `auto/orchestrator` is **live on both dialects**, streaming and not. Ask any
OpenAI or Anthropic client for it and you get a real orchestration — narrated progress down
the response, the same wire format as any other model. Every response carries
`x-rewter-task-id`, set before the first byte because that is the only moment a header can be
set. Re-POSTing a conversation that is still running is **steering**, not a second task: the
new message reaches the initiator at the next turn boundary and the follow-up request attaches
to the stream already in flight. A client that drops and comes back **adopts** its task,
replaying everything it missed; one that stays gone has 30 seconds before the task is
cancelled, so a Ctrl-C does not leave workers billing to nobody.

In progress (M6): the **safety layer** tier-2 workers run inside, and the tools they run
with. The sandbox answers one question, *is this path inside the auto-approve zone*, on
symlink-resolved paths, and refuses nothing: pointing a task at a real project directory is
meant to put every write outside the zone, because that is exactly when you want to be
asked. The gate is one function, and there being exactly one is the point — a second path to
the disk is a second place to forget it. Auto-approvals are logged rather than skipped, so
"nothing needed asking" and "the gate was off" stay distinguishable; a denial comes back as a
*result* carrying your note, so a worker told "use the test fixture instead" adapts rather
than dying; and the read-only allowlist forfeits on any shell metacharacter, since
`ls; rm -rf ~` does begin with `ls`.

The ten tools themselves (M6c) are declared twice — JSON Schema for the model, zod for us,
with a parity test so the halves cannot drift — and implemented in exactly one file, so there
is one list to audit rather than one per caller. Classify, then ask, then act, in that order:
a tool that acts and reports afterwards has already done the damage, so every denial test
also asserts the disk was untouched. Nothing throws — a missing file, a refused approval, an
`old_text` that matches twice, a command that exits 1 all come back as text the model can
respond to. Output is capped *and says it was cut*, since a model reasons confidently about a
file it only half received; files keep the head, `shell` keeps the tail. Reads are gated too
when they leave the zone, `edit_file` refuses an ambiguous anchor rather than editing
somewhere the model never looked, the recursive walk won't follow a symlink out of the tree,
and `web_fetch` takes http(s) only — `file:` would be a way around the path gate entirely.

The loop that drives them (M6d) is the same `WorkerRunner` shape as a tier-1 worker, so the
engine needs no case analysis — but a loop has a model as an unreliable participant, and that
is where its rules come from. It ends on `finish_report` and nothing else; a model that writes
prose instead gets one nudge, and if it does it twice that prose *becomes* the report, because
the work may well be done and refusing to read it would bill you for nothing. A denied call is
remembered by fingerprint and a repeat is answered from memory, so a model that ignores the
prompt and retries does not put the same card in front of you again — you are asked once per
*distinct* request, and a retry with different arguments is a different request. Nothing
throws: bad arguments, an invented tool name, a refusal, even a malformed report all come back
as a turn the model can answer, since being told is the only way it fixes anything. Every exit
is walked against a real database, because the lifecycle has no shortcut edge and a forgotten
transition would surface as a crashed task rather than a failed test.

And as of M6e the initiator can actually **ask** for one. `spawn_worker` takes `tier: 2`, and
the engine picks the runner by tier — only tier 3 still refuses, worded to point at tier 2
rather than to say "not yet". The workspace and approval gate open on the first tier-2 spawn
(most tasks are pure tier-1 fan-outs and would otherwise each leave an empty directory behind)
and are shared by every tier-2 worker on the task, because two of them write to the same place
and a denial one collected should not be put in front of you twice. Workers narrate into the
same feed you are already reading: `· [w2] read src/foo.ts, found the off-by-one`, and
`⏸ approval needed` carrying the full approval id — the id the route, the in-band reply and
the audit row all use. Their scratch space is `workspacesDir` (default `~/.rewter/workspaces`),
which is deliberately not under the database file. One meaning shifted with the tier:
`concurrency` now bounds four simultaneous *agent loops*, each with a shell, rather than four
one-shot completions — which is why the default stayed at 4.

Answering a card works three ways, all of them one code path: `POST /internal/approvals/:id`
with `{"approved": true}` (the dashboard's buttons, and `curl`), or `approve <id>` / `deny <id>:
why not` typed as the next user turn in whatever client you are already in. An in-band reply
can be both — `approve apr_x` on one line and an instruction on the next does both things, and
only the instruction reaches the initiator. Denials carry your note down to the model as a tool
result (`command not run: denied by the user: use the fixture instead`), because a worker told
why can pick something else and a worker handed a crash cannot.

A tier-2 worker can also be corrected while it runs. `send_to_worker` hands it a message it
reads at its next step — a constraint you left out, an answer it needed, or an instruction to
drop what it is doing — and the feed shows `⇄ [w2] told: …` so a worker changing course mid-run
is explicable. The message does not interrupt work in flight: the initiator sends and then
`wait`s as usual. Tier-1 workers cannot be messaged, and the refusal says so and names tier 2,
because a single model call has no point at which it could read anything.

All three ran live on 2026-08-28, which is what closes M6. A `uname -a` parked, was approved by
`curl` while the stream stayed open, and the same stream finished with the kernel string; a
`curl` to the network was denied with a note and the worker switched to `web_fetch` rather than
retrying or dying; and an in-band `approve apr_…` re-POSTed with `x-rewter-task-id` both resolved
the card and adopted the task, so the second stream replayed the feed and carried on while the
original one also finished with the answer.

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

### Capability cards

A card is what the orchestrator will read to decide which model gets which subtask. One model
writes them for the others:

```sh
node packages/cli/dist/index.js card zai/glm-5.3 --using anthropic/claude-sonnet-5
# zai/glm-5.3
#   summary:    Cheap 1M-context workhorse; strong at code, weak at hard math.
#   best at:    coding, long_context
#   strengths:  coding, long_context, fast_cheap
#   weaknesses: math
#   written by: anthropic/claude-sonnet-5
```

`--using` is required and has no default: the model that writes the cards is billed, and its
judgement is what the router acts on for the life of the card. A bare `card` is not "do them
all" either — a synced registry is hundreds of rows, so pass `--all` (all *enabled* models) if
that is what you want. A model that already has a card is skipped unless `--regenerate`.

Regenerating is always safe: generation writes only the generated half of a card, so a hand
correction you made in the dashboard survives it. `--show` prints stored cards without calling
anything; `--dry-run` prints what it would store.

Generators are unreliable narrators, so the parser is forgiving in one direction only: invented
tags are dropped, a fenced or prose-wrapped reply is dug out, an over-long summary is trimmed,
and a tag claimed as both a strength and a weakness is kept as the **weakness** — a false
strength gets a model picked for work it bills for and fails at, while a false weakness only
costs an option. Everything it discarded is printed, not swallowed.

The prompt also forbids stating any specification it was not given — parameter counts, cutoffs,
benchmark numbers. A bad tag gets dropped; invented prose gets stored and quoted back as fact,
and the router cannot check it. Judgement about what a model is good at is the job; the specs we
already have are handed to the generator rather than asked for.

### Orchestrating

Ask for the model `auto/orchestrator` and you get an orchestration instead of a model call —
same endpoint, same wire format, any client:

```sh
curl -N localhost:20130/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"auto/orchestrator","stream":true,
       "messages":[{"role":"user","content":"summarize these 3 URLs and compare them"}]}'
# ◆ plan: fetch each page, then compare
# ▶ [w1 · zai/glm-5.3 · tier1] summarize URL 1 — started
# ▶ [w2 · zai/glm-5.3 · tier1] summarize URL 2 — started
# ✔ [w1] done ($0.0021, 3.4s)
# …then the synthesized answer
```

Progress arrives as ordinary assistant text, so a client needs no rewter awareness to show it.
`auto/orchestrator:<model-id>` pins the initiator; otherwise the configured default is used,
falling back to the most expensive enabled model that supports tools.

That output is real, not illustrative: an `orchestrator` block in the config sets who leads and
what a task may spend, and a request that says nothing about settings inherits both.

```jsonc
"orchestrator": {
  "initiatorModel": "anthropic/claude-sonnet-5",  // else: priciest tools-capable model
  "maxSpendUsd": 1,          // per task; the initiator is refused a spawn past it
  "concurrency": 4,          // parallel workers per task
  "maxTurns": 24, "maxHandoffs": 2   // runaway guards, not targets
}
```

Left to itself the initiator tends to keep the money where it belongs — asked for three facts
in parallel, a Sonnet-class leader put all three workers on a flash-class model and spent
$0.005 total.

Every orchestration response carries an **`x-rewter-task-id`** header. Re-POST the same
conversation with one more user turn while it is still running and that turn is delivered to
the initiator as steering — the task carries on, and the new request attaches to the stream
already in flight rather than starting a second, separately-billed orchestration. Echoing the
header back does the same thing without relying on the conversation matching. Disconnect and
reconnect within 30 seconds and you adopt your task, replaying whatever you missed; stay gone
and it is cancelled, so an interrupted client does not leave workers billing to nobody.

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
