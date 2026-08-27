# rewter — Architecture

> **This document is the living source of truth for rewter's design.** Every behavioural
> change MUST update this file (or a linked design doc) in the same commit/PR. See
> [CLAUDE.md](../CLAUDE.md) for the docs rule.

## What rewter is

An OpenAI-compatible multi-provider AI model router (in the family of OpenRouter / 9router)
whose defining feature is **AI-controlled orchestration**: a designated *initiator AI*
decomposes incoming tasks, delegates subtasks to the best/cheapest-fit models in parallel,
collects their reports, and can hand itself off to a stronger model when it judges itself
unfit. Model selection is informed by machine-readable **capability cards** in a model
registry.

Goals:

- **Speed** — parallel workers on independent subtasks.
- **Cost** — cheap models execute, smart models plan/review; token spend tracked per task.
- **Specialization** — OCR/vision/coding-specialized models used where they fit.

## Shape

One local daemon process serving:

- **`/v1`** — OpenAI-compatible API. `POST /v1/chat/completions` either **passes through**
  to a concrete model (plain routing) or, when `model` is the pseudo-model
  `auto/orchestrator` (also `auto`; `auto/orchestrator:<modelId>` pins the initiator),
  diverts into the **orchestrator engine**. `GET /v1/models` lists registry models plus
  the pseudo-models so CLI model pickers see them.
- **`/internal`** — localhost-bound REST + WebSocket for the **dashboard** (built static,
  served by the same daemon).

Consumers: Claude Code and similar CLIs pointed at rewter as their API base, scripts/curl,
and the dashboard itself.

## The 3-tier worker ladder

The initiator picks the *cheapest sufficient* tier per subtask:

| Tier | What | Status |
|---|---|---|
| 1 | Bare LLM call (text/vision in → text out) | Phase 1 |
| 2 | rewter's own agent loop with tools (file r/w, shell, web) in a task workspace | Phase 1 |
| 3 | External harness session (Claude Code headless, aider, codex, generic adapter spec), interactive, headless in tmux with user attach/mirror | Phase 2 (seams built in phase 1) |

## Control model

- **Conversation** stays in the initiating client: progress streams as text down the single
  SSE response; in-band replies steer the task mid-flight (`approve w2`, free-text steering).
- **Operations** are canonical in the dashboard: live task tree, approval cards, kill,
  costs, registry editing (terminal attach in phase 2). Approval prompts are mirrored in
  both places.

### In-band steering mechanics

OpenAI chat clients "reply" by re-POSTing the whole conversation. A `LiveTaskIndex`
fingerprints the conversation prefix each task started with (plus an `x-rewter-task-id`
header emitted early in the stream for exact matching). A new request whose prefix matches
a live task and adds new user message(s) injects `[USER STEERING]` at the next turn
boundary (and answers any pending `ask_user`). If the original SSE stream is gone, the new
stream **adopts** the task and resumes from the event log — this doubles as
reconnect/resume.

## Safety: approval gates

All risky actions flow through one choke point (`approvals.require`):

1. Policy check — task auto-approve on? path inside the task workspace? command on the
   read-only allowlist (`ls`, `git status/diff/log`, `pnpm test`, …)? → auto-approved
   (still logged as an event).
2. Otherwise: pending `Approval` row + event → dashboard card AND an SSE text line in the
   client stream.
3. The tool call parks on a promise, resolved by `POST /internal/approvals/:id` or an
   in-band `approve <id>` reply.
4. Denied → the tool returns `{ error: "denied by user: <note>" }` so the worker LLM adapts
   or reports failure.

Risk classes: `shell` gated unless allowlisted-readonly; file writes gated iff outside the
task workspace; `web_fetch` logged, ungated.

## Monorepo layout

```
packages/shared/     @rewter/shared — THE contract package: zod entities + lifecycle state
                     machines, unified chat/stream format, event envelope (server↔dashboard
                     contract), dashboard API schemas, branded IDs (task_, run_, apr_, evt_)
packages/server/     @rewter/server — the daemon:
                     config, db, providers, registry, router, orchestrator,
                     workers/{tier1,tier2,tier3-stub}, approvals, events, costs, http, openai
packages/cli/        rewter — start|stop|status|logs|sync-models|card <m>|install-service|gc
apps/dashboard/      Vite + React SPA, built static, served by the daemon
```

`shared` is the only hard package boundary: server and dashboard import the same zod
schemas so the event/API contract cannot drift. Server module dirs are the future seams.

## Tech stack

| Concern | Choice | Why |
|---|---|---|
| HTTP | Fastify 5 | long-lived daemon: plugins (ws/static/cors), lifecycle hooks, pino, `app.inject()` for portless endpoint tests |
| OpenAI SSE | hand-rolled writer over `reply.raw` | exact `data:` framing + `[DONE]`, 15s heartbeat comments, close→cancel |
| Dashboard live | WebSocket (`@fastify/websocket`) | event firehose + `afterSeq` replay; approve/deny stay REST |
| DB | better-sqlite3 + Drizzle | synchronous writes = no async races in a single process; WAL for concurrent reads; drizzle-kit migrations |
| Dashboard | Vite + React 18, TanStack Router/Query, zustand, Tailwind | local ops UI, no SSR |
| Validation | zod (in `shared`) | validates OpenAI requests, LLM tool args, config, DB round-trips; `zod-to-json-schema` for tool defs |
| Tests | vitest + recorded wire fixtures + in-memory SQLite + FakeProviderAdapter/ScriptedModel | deterministic, no keys/network |
| Lint/format | Biome | one fast tool |
| SDKs | `@anthropic-ai/sdk` (native), `openai` (covers all OpenAI-compatible upstreams via baseURL), `@google/genai` | |
| Daemon | `rewter start` runs in the foreground (dev, and what launchd wants); `rewter install-service` writes the plist in M8; logs `~/Library/Logs/rewter/` | |

## Domain model

Entities (zod-typed in `shared`):

- **Provider** — kind, baseUrl?, `apiKeyRef` (env var *name* — raw keys never in DB), enabled, priority.
- **Model** — `<provider>/<model>` id, pricing, contextWindow, modalities, supports{tools,vision,json}, source (synced|manual).
- **CapabilityCard** (1:1 Model) — summary, strengths[], weaknesses[], bestAt[]/avoidFor[]
  (tags from a **fixed vocabulary** that doubles as the phase-2 stats key), tierHint, speed,
  `userOverrides` (JSON patch that survives regeneration).
- **Task** — one orchestrated request; workspaceDir, autoApprove, settings (maxSpendUsd?, maxParallel?).
- **WorkItem** — subtask; `parentWorkItemId` builds handoff chains.
- **WorkerRun** — one execution attempt (retry/handoff = new run); `harnessSessionId?` column exists now (phase-2).
- **Event** — append-only, autoincrement `seq`; **source of truth** for dashboard replay and audit.
- **Approval** — kind (shell|write_outside_workspace|network|spawn_harness), status, resolvedBy.
- **CostRecord** — token counts incl. cache read/write; costUsd computed at write time from a pricing snapshot.
- **ModelStat** — (modelId, taskTag) → attempts/successes/avgCost/avgLatency. Phase-2 data, phase-1 schema.

### Lifecycle state machines

Pure `assertTransition` functions in `shared`, exhaustively tested, invoked by every repo write:

```
Task:      pending → running → succeeded|failed|cancelled     (⇅ waiting_approval — pauses the branch, not the task)
WorkItem:  pending → running → succeeded|failed|cancelled|handed_off (⇅ waiting_approval)
WorkerRun: created → streaming ⇄ tool_pending → succeeded|failed|cancelled
Approval:  pending → approved|denied|auto_approved|expired
```

SQLite PRAGMAs: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`.

## Orchestrator engine

**System prompt** (cache-friendly order):

1. **Static core** — role, tier ladder, tool rules, cost discipline ("cheapest sufficient
   tier/model"), self-assessment + handoff criteria, narration conventions. Gets a
   `cache_control` breakpoint on the Anthropic adapter.
2. **Registry digest** — one compact line per active model rendered from Model+Card
   (`zai/glm-5.3 — $x/$y MTok, 1M ctx, fast — best_at:[…] — avoid:[…]`), stable-sorted for
   cacheability, ≤ ~4K tokens. Phase-2 stats append inside this same renderer.
3. **Task context** — the client's incoming conversation.

**Initiator tools**: `plan_note`, `spawn_worker` (returns work_item_id **immediately**;
parallel fan-out = several spawns in one turn onto a p-limit scheduler, default concurrency
4), `wait({ids?, mode:"all"|"any"})`, `get_result`, `send_to_worker`, `cancel_worker`,
`ask_user`, `handoff({to_model, reason, context_summary})`, `finish({summary})`.

**Worker reports**: tier-2 workers end with a structured REPORT block
(status/summary/details/artifacts) → `WorkItem.resultSummary` → `wait` returns summaries →
initiator pulls full text via `get_result` on demand.

**Progress-as-text** conventions down the single SSE response:

```
◆ plan: split into 3 subtasks          (dashboard: http://localhost:PORT/tasks/task_x)
▶ [w1 · gemini-flash · tier1] summarize repo docs — started
⏸ approval needed: shell `pnpm test` — approve in dashboard or reply "approve w2"
✔ [w1] done ($0.002, 3.1s)
── final answer from finish() ──
```

**Handoff**: ends the current loop; successor prompt = static core + digest +
context_summary + condensed transcript; new loop with the stronger model on the same task
and SSE stream.

**Cancellation**: AbortController tree (task → per-run). Client SSE disconnect starts a 30s
grace timer (allows adoption/reconnect) before cancel; dashboard kill is immediate.
Budget guard: soft threshold → injected system note; hard cap → forced `ask_user`.

## Provider adapters

Implemented in M2 — `packages/server/src/providers/`.

### The normalized contract

Every adapter, whatever the upstream, emits exactly this chunk grammar:

```
(text_delta | tool_call_start | tool_call_delta)*  →  message_end
                                                   |  error          (terminal)
```

Invariants enforced by the shared test suite, not by convention:

- Exactly **one** terminal chunk (`message_end` or `error`), and it is **last**.
- Every `tool_call_delta` is preceded by a `tool_call_start` with the same `index`.
- An `index` is opened at most once.
- `message_end.usage` always carries `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`.
- Errors carry a `retryable` flag and a `statusCode` (null when the failure was not HTTP).

Two semantics are load-bearing and easy to get wrong, so they are spelled out here:

- **Truncation is never success.** A stream that ends before its upstream terminal event
  (`message_stop` / `[DONE]` / a `finishReason`) yields a *retryable* `error`, never a clean
  `message_end`. Folding a dead socket into a `ChatResponse` would silently hand the
  orchestrator a half-written answer.
- **Aborts are never retryable.** A cancelled task must not be resurrected by the router's
  retry loop, so `toErrorChunk()` maps `AbortError` to `retryable: false`.

### Three classes, many upstreams

- **anthropic** — native `@anthropic-ai/sdk`: `cache_control` breakpoints, typed
  tool_use/tool_result blocks, real cache-token accounting. Leading `system` messages are
  hoisted to the top-level `system` param (and removed from `messages`); consecutive tool
  results merge into a single user turn.
- **openai-compat** — one class parameterized by `{baseUrl, apiKey, quirks}`; covers ~25 of
  the 27 presets.
- **google** — `@google/genai`. Roles are `user`/`model`, messages are `contents`/`parts`,
  and there is no system role (leading system messages join into `systemInstruction`).

**Quirks, not subclasses.** Upstream deviations are data on the preset, not new code:

| Quirk | Meaning |
|---|---|
| `usageOptional` | upstream may omit the usage block entirely (local runtimes do); absent usage is zeros rather than an error |
| `maxCompletionTokens` | send `max_completion_tokens` instead of the legacy `max_tokens` |
| `noStreamOptions` | omit `stream_options: {include_usage: true}` — some servers 400 on it |

**Gemini's finish reason is a lie.** Gemini reports `STOP` even when the turn is entirely
function calls — its wire has no `tool_calls` value. The adapter therefore lets a *seen*
function call outrank a plain `STOP` and normalizes to `finishReason: "tool_calls"`, so the
orchestrator knows it must run tools. Gemini also sends no call ids; the adapter synthesizes
stable `gemini_call_<n>` ids.

Retry/fallback lives in the **router layer**, never in adapters — every SDK client is
constructed with `maxRetries: 0`.

### Provider presets

`presets.ts` is a **data table**: adding an upstream is a row (slug, kind, baseUrl, env var
*name*, quirks), not a new class. 27 entries today, spanning four categories:

| Category | Presets |
|---|---|
| First-party SDK | anthropic, google, openai |
| Aggregators | openrouter, together, fireworks, groq, deepinfra, hyperbolic, nebius, novita, sambanova, cerebras, perplexity, githubmodels |
| Direct vendors | xai, zai, moonshot, deepseek, mistral, cohere, qwen, minimax, baseten |
| Local runtimes | ollama, lmstudio, llamacpp, vllm |

The slug is a model-id namespace (`<slug>/<model>`), so it is constrained to `[a-z0-9-]+`.
`apiKeyEnv` holds an env var **name** only — a test asserts it matches SCREAMING_SNAKE,
which a real key never would. Local runtimes are the only presets allowed a null key.

### Factory

`createAdapter(provider, {env, fetch})` is **the only place that reads secrets out of the
environment**. It resolves `provider.baseUrl ?? preset.baseUrl`, inherits preset quirks, and
throws `MissingApiKeyError(providerName, envVar)` when the referenced variable is unset *or
empty* (an empty key would only 401 later, at a much worse moment). The error names the
provider and the variable and never a value.

### Contract test suite

`describeAdapterContract()` runs the same eight assertions against every adapter over
recorded wire fixtures replayed through a stub `fetch` — text, split tool arguments,
parallel tool calls, HTTP error, truncated stream, abort. **Adding an adapter means adding
fixtures, not tests.** Fixtures are chunked at event boundaries so a parser cannot rely on
whole events arriving in one read.

`@google/genai` calls the global `fetch` directly and exposes no injectable transport, so
its tests stub `globalThis.fetch` and restore it in `afterEach`; the other two SDKs take a
`fetch` through `AdapterConfig`.

## Router and the OpenAI surface

Implemented in M3 — `packages/server/src/router/` and `packages/server/src/http/`.

This is the pass-through path: everything between an OpenAI client's HTTP request and an
adapter's normalized chunk stream. The orchestrator (M5) will sit *beside* it, not above
it — `auto/orchestrator` diverts before resolution and currently returns `501`.

### Model resolution

Clients name models loosely. Claude Code sends `claude-sonnet-5`; a curl user copies
`anthropic/claude-sonnet-5` off the dashboard; someone with two keys for the same weights
wants `openrouter/anthropic/claude-sonnet-5`. `resolveModel()` tries four tiers, in
decreasing confidence:

1. **Exact registry id** — always wins, and is the only form that cannot be ambiguous.
2. **Exact upstream id** — what the vendor's own docs call it.
3. **Bare name** — the segment after the provider namespace.
4. **Suffix match**, anchored on `/`, so `openrouter/anthropic/claude-x` finds
   `anthropic/claude-x` and vice versa (and `sonnet-5` never matches `not-sonnet-5`).

Each tier is tried *whole*: if the bare-name tier yields two hits, that is an
`AmbiguousModelError` (→ HTTP 400), not a drop to a fuzzier tier that might yield one — a
coincidence is not a disambiguation, and guessing here silently bills the wrong account.
Disabled models are invisible to resolution; a model whose provider is disabled resolves and
then fails loudly (`ProviderDisabledError` → 503) rather than vanishing into "unknown
model".

### Retry belongs to the router, not the adapter

Adapters translate wire formats; only the router knows whether anything has been
**delivered**. So retry lives here, and the rule is:

> Retry the *connection attempt*. Stop the moment the first chunk escapes.

A stream that has already emitted text cannot be retried — the client rendered those bytes,
and replaying the call would duplicate them. A pre-emission error is therefore captured
rather than yielded, and the retry-or-surface decision is made **once**, after the attempt
loop, so there is a single give-up path:

- Retryable and attempts remain → sleep `min(250·2ⁿ⁻¹, 4000)` ms and try again.
- Otherwise → yield the upstream's **own message and `statusCode`**, annotated with
  `(after N attempts)` when N > 1. The vendor's words are what a user can act on; how hard
  we tried is the part they cannot see from outside.
- A stream that yields **nothing at all** is a contract violation, but the caller still
  needs a terminal chunk: the silence is treated as retryable, and after the last attempt
  becomes a synthetic `produced no output in N attempts` error rather than a hang.
- An adapter that *throws* instead of yielding an error chunk is a bug; it is caught and
  converted to a terminal error chunk for the same reason.
- **Aborts are never retried** — a cancelled request must not be resurrected.

`Router.complete()` folds `Router.stream()` rather than calling `adapter.complete()`, so
retry and cost recording have exactly one implementation and cannot drift between the
streaming and non-streaming request shapes.

### Cost recording

On `message_end`, the router computes cost from a **snapshot** of the model's pricing and
appends a `CostRecord` (+ `cost.recorded` event). Recorded once per request, not per
attempt. `taskId` is nullable, so plain pass-through calls are metered too — the dashboard
can price a bare routing session, not just orchestrations. A stream that dies before
reporting usage records nothing rather than guessing.

### SSE and the OpenAI wire format

`SseWriter` writes `data: <json>\n\n` frames straight to `reply.raw`, ends with the literal
`data: [DONE]\n\n`, and emits `: ping` comment lines every 15s while idle (an orchestration
can think for minutes before its first token, and proxies cut idle sockets long before
that). Client disconnect aborts the upstream call — nobody is waiting for those tokens, and
on a paid upstream generating them costs real money.

**Which object you watch for that disconnect is load-bearing.** The listener goes on
`reply.raw` (the `ServerResponse`), never on `req.raw`. An `IncomingMessage` emits `"close"`
when the *request body* has finished being read — on any POST that is immediately, so a
listener there aborts every stream before its first token. `ServerResponse` emits `"close"`
when the socket actually goes away, and the `!writableEnded` guard keeps our own clean
finish from looking like a hang-up. This shipped broken once and no `app.inject()` test
could see it, because `inject()` has no socket; `http/app.socket.test.ts` binds a real
ephemeral port for exactly this class of bug and is the only place that would have caught
it.

Two mismatches between our internal grammar and OpenAI's, both deliberate:

- **Resolution happens before any bytes go out.** A bad model name must be a clean `404`;
  once SSE headers are written there is no status code left to say it with.
- **OpenAI's chunk schema has no error member**, but our `StreamChunk` grammar has a
  terminal `error`. A mid-stream failure ships as a final frame with
  `finish_reason: "stop"` plus a non-standard `error` field, followed by `[DONE]` — strict
  clients still terminate cleanly, and clients that look find the reason. Usage is omitted
  from the stream unless `stream_options.include_usage` asks for it.

Requests are parsed permissively: unknown knobs (`top_p`, `seed`, `presence_penalty`, …) are
ignored rather than rejected, because 400-ing over a parameter we merely don't forward yet
would break clients for no benefit. `max_completion_tokens` is accepted alongside
`max_tokens`; the `developer` role is normalized to `system` at the edge (no upstream but
OpenAI has heard of it); the multi-part content array Claude Code sends is flattened to
text.

### Gateway status policy

We are a gateway, so an upstream that fails is a **502** from where the client sits,
whatever status the vendor chose. The exceptions are statuses that describe the *caller's*
request — `400, 401, 403, 404, 413, 422, 429` — which are forwarded verbatim, because the
client is the one who can act on them. Burying a rate limit or a rejected key under a
generic 502 would hide the one thing they can fix.

### Auth

`/v1` takes an optional bearer token (`apiKey`); absent means open, which is the normal
localhost-daemon case. `/internal` is never gated — it is localhost-bound and the dashboard
holds no key.

## Configuration and boot

### The config file

`~/.rewter/config.json` (override with `REWTER_CONFIG`, or `rewter start --config <path>`).
Everything has a default, so the file is optional and an empty `{}` is valid.

```jsonc
{
  "port": 20130,                    // not 20128 — that is 9router's, so both can run at once
  "host": "127.0.0.1",
  "dbPath": "~/.rewter/rewter.db",  // a leading ~ is expanded; ":memory:" works for throwaway runs
  "apiKeyEnv": "REWTER_API_KEY",    // env var NAME holding the bearer token /v1 requires
  "providers": [
    { "preset": "anthropic" },
    { "preset": "zai" }
  ],
  "models": [
    { "id": "anthropic/claude-sonnet-5", "provider": "anthropic", "contextWindow": 200000,
      "pricing": { "inputPerMTok": 3, "outputPerMTok": 15 } }
  ]
}
```

A provider entry names a **preset slug** from the 27-entry table, so the common case is one
line; `slug` + `kind` (+ optional `baseUrl`, `apiKeyEnv`, `name`) describes an upstream the
table doesn't know. Anything given explicitly overrides the preset.

**No secret ever appears in this file.** `apiKeyEnv` is the *name* of an environment
variable, both for provider keys and for rewter's own bearer token — the file is safe to
paste into an issue.

Precedence is **env > file > defaults**, with `REWTER_HOST`, `REWTER_PORT` and `REWTER_DB`
as the overrides. A `REWTER_PORT` that isn't a number is a hard error rather than a silent
fall back to the default: a typo'd port that quietly moves the daemon is a daemon nobody can
find. Likewise a config path *asked for explicitly* and missing throws, while the default
path missing just means "use defaults".

### Seeding: config → registry

`config/seed.ts` turns the config arrays into Provider and Model rows, and it is
**idempotent, keyed by slug**. Provider ids are *derived* from the slug
(`prv_` + 6 readable chars + 6 chars of FNV-1a hash — `prv_anthro1f2g3h`) rather than
generated, so restarting the daemon updates rows in place instead of minting new ids and
orphaning the cost records and events that point at them. That is exactly the property M4's
`sync-models` needs, arrived at a milestone early. `createdAt` survives a re-seed;
`updatedAt` moves.

Two deliberate choices:

- **Disabled, not absent.** A provider whose key env var is unset is seeded *disabled*. A
  disabled provider produces a loud 503 naming the model; a *missing* one produces "unknown
  model", which sends the operator looking in the wrong place. Local runtimes (Ollama, LM
  Studio, …) are keyless and stay enabled.
- **Non-fatal problems are warnings, not crashes.** An unknown preset, or a model naming a
  provider that didn't seed, is logged and skipped — one bad entry must not stop the daemon.
  A duplicate slug *is* fatal, because two rows would collide on the derived id.

### Boot

`daemon.ts` owns the sequence — config → database → registry → router → listening app —
and returns the running pieces rather than owning the process, so tests boot a real daemon
on port 0 and shut it down, and M8's launchd wrapper adds signal handling without this
module knowing about processes.

```
startDaemon(opts) → { app, db, repos, bus, router, config, url, stop() }
bootSummary(d)    → "rewter listening on http://127.0.0.1:20130 — 2 provider(s), 5 model(s)"
runUntilSignal(d) → Promise<never>   // SIGINT/SIGTERM → graceful drain → exit
```

The one-line boot summary reports enabled counts and the bound URL, and nothing secret.
Warnings and every disabled-for-missing-key provider are logged by name at startup, so the
reason a model 503s is visible before the first request.

`runUntilSignal` returns a promise that never settles: the caller's `await` *is* the "stay
running" state, and the process ends through the signal path. A second Ctrl-C during
shutdown is ignored rather than starting a second `stop()`. Draining matters more here than
in a typical server — an SSE stream severed mid-frame leaves the client parsing a truncated
event rather than seeing a clean end.

`main.ts` is the bare `node dist/main.js` entrypoint, kept separate from the `index.ts`
library barrel so that importing `@rewter/server` never starts a server as a side effect.

### CLI

`rewter start [--config <path>] [--port <n>]` runs the daemon in the **foreground** — the
shape M8 wraps in a launchd plist, and the shape you want anyway while watching logs.
`rewter version` / `rewter help` round it out. Background management (`stop`, `status`,
`logs`, `install-service`, `gc`) needs a pidfile and a service definition, which is M8's
job; those commands exit 1 naming the milestone rather than pretending. `sync-models` and
`card` do the same for M4.

## Tier-2 agent loop

`WorkerAdapter` interface abstracts tiers (`run(ctx)`, optional `send()` for follow-up
injection). Tier-2 tools: `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`,
`grep`, `shell` (zsh -c, cwd=workspace, timeout, 32KB output tail cap), `web_fetch`,
`web_search`, `report_progress`, `finish_report`.

Workspace: `~/.rewter/workspaces/<taskId>/`, shared by a task's workers. Task settings may
point at a real project dir — then *every* write is outside-sandbox → gated.

## Tier-3 seam (phase 2, types committed in phase 1)

```ts
interface HarnessAdapter { id: string; spawn(spec): Promise<HarnessSession>; }
interface HarnessSession {
  sessionId: string;                    // persisted → survives daemon restart (tmux name)
  events: AsyncIterable<HarnessEvent>;  // normalized: text|toolUse|approvalNeeded|done
  send(message: string): Promise<void>; // interactive follow-ups from the initiator
  kill(): Promise<void>;
  attachInfo(): { tmuxSession: string };  // sessions named rwtr_<runId>
}
```

Plus a generic JSON adapter spec (command template, output-parse mode `jsonl|plain`,
done-pattern) so any CLI harness is addable by config.

## API surface

- `POST /v1/chat/completions` — pass-through or orchestrator; stream + non-stream. **Live.**
  (Orchestrator returns `501` until M5.)
- `GET /v1/models` — registry + pseudo-models. **Live.** `auto/orchestrator` is listed
  **first** so it is visible in every client's model picker; disabled models are hidden.
- `/internal`: tasks list/detail/`events?afterSeq=`, `cancel|steer|settings`, approvals
  list/resolve, models CRUD + `sync` + `generate-card`, provider CRUD, `costs?groupBy=`,
  `health`, and `WS /internal/ws` (`{subscribe, afterSeq?}` → replay then live).
  Live today: `health` (with registry counts), `providers`, `models` (**including**
  disabled ones, unlike `/v1/models`), `events?afterSeq=` (a non-numeric `afterSeq` reads
  as 0 rather than erroring). Providers are safe to serve as-is: only the env var *name* is
  ever stored.
- Event envelope `{seq, ts, taskId, type, payload}`. The dashboard task tree is a **pure
  fold over the event stream**; the fold function lives in `shared`, tested once, used by
  both sides.

## Phases

- **Phase 1 (MVP)**: routing + provider adapters, registry + capability cards, orchestrator
  pseudo-model, tier-1 fan-out, tier-2 loop with approval gates, dashboard (live task tree,
  approvals, kill, costs), daemonization. Milestones M0–M8 in [progress.md](progress.md).
- **Phase 2**: tier-3 harness adapters, tmux attach/mirror, learned-from-experience stats,
  Anthropic-native `/v1/messages` passthrough.
- **Phase 3**: multi-initiator handoff chains, budgets, scheduling.

## Key risks

- **Orchestrator prompt quality is the product** — prompts are versioned `.md` files,
  snapshot-tested; a small hand-scored eval script (5–10 canned tasks) is built in M5.
- **Streaming edge cases** — contract fixtures include truncated/error/split-tool-arg streams.
- **Dev cost surprises** — FakeProviderAdapter default in tests; `REWTER_DRY_RUN=1` routes
  everything to local Ollama.
