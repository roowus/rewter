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

- **`/v1`** — two client-facing wire formats over one router.
  - `POST /v1/chat/completions` (OpenAI) either **passes through** to a concrete model
    (plain routing) or, when `model` is the pseudo-model `auto/orchestrator` (also `auto`;
    `auto/orchestrator:<modelId>` pins the initiator), diverts into the **orchestrator
    engine**.
  - `POST /v1/messages` (Anthropic-native) is the same thing in Anthropic's dialect. Claude
    Code speaks this and only this, so it is what makes rewter usable as a 9router
    replacement rather than a curl toy.
  - `GET /v1/models` lists registry models plus the pseudo-models so CLI model pickers see
    them.
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
| SSE | hand-rolled writer over `reply.raw` | exact framing for **both** dialects — OpenAI's data-only frames + `[DONE]`, and Anthropic's named `event:` frames with no sentinel; 15s heartbeat comments, close→cancel |
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
  `userOverrides` (JSON patch that survives regeneration). Stored in two halves — see
  [Capability cards](#capability-cards).
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

### Capability cards

A card is stored in **two halves**: the generated content, and a `userOverrides` JSON patch.
Reads (`getCard`, `listCards`) return them merged, overrides on top; `getRawCard` returns them
unmerged, for the editor, which has to show what it can change.

Each write touches only its own half. `upsertCard`'s conflict clause deliberately omits
`userOverridesJson`, so re-running card generation — which knows nothing about overrides —
cannot destroy a hand correction. `setCardOverrides` is the reverse, and `null` clears the
patch to restore the generated card.

Merging is **shallow, field-level**: `strengths: [...]` *replaces* the generated list rather
than appending to it. The common correction is "this list is wrong", and an append could never
express a deletion.

Two things the patch cannot do:

- **Rewrite provenance.** `modelId`, `generatedBy`, `generatedAt` and `userOverrides` itself are
  stripped from the patch before merging. A card claiming it was generated by a model that never
  saw it is a record that lies about itself.
- **Invalidate the card.** The merged result is re-parsed; if it fails, the generated card is
  returned intact. A hand-edit with a typo'd tag must not take a model out of the registry.

### Model sync: catalogs → registry

`registry/catalog.ts` reads a provider's own model list; `registry/sync.ts` decides what that
means for rows a human may already have touched. `rewter sync-models` drives both.

**Catalogs.** Most upstreams expose `GET {baseUrl}/models` in one of three dialects — OpenAI's
`{data:[{id}]}`, OpenRouter's richer version of the same (`pricing`, `context_length`,
`architecture.modality`, `supported_parameters`), and Anthropic's `{data:[{id, display_name}]}`.
Google's is `{models:[{name: "models/…", inputTokenLimit, …}]}` on a different path. Each parser
returns the same `CatalogEntry`. A provider whose preset says `listModels: false` (Perplexity,
Z.AI, MiniMax) is **skipped, not attempted** — `canSync(undefined)` is false too, so a preset
lookup that fails skips rather than throws.

Two parsing rules that matter downstream. A price is **per million tokens**, converted from the
per-token decimal strings upstreams publish and rounded to 6 places, because `"0.00000125" * 1e6`
carries float noise into a digest that has to be byte-stable. And an absent or unparseable price
is `null` — *unknown*, never zero; `costs/compute.ts` distinguishes them, and a guessed zero
silently under-reports spend. A catalog row we cannot parse is **counted, not thrown**: one
malformed entry must not cost you the other four hundred.

**Enrichment.** Most catalogs are an id list and nothing else, which would leave the registry
priceless and the orchestrator with no basis for preferring a cheap model. So OpenRouter's
catalog — which prices essentially the same models — fills the gaps in everyone else's, matching
on the id tail with any variant suffix dropped, first writer wins. It is **on by default** in the
CLI (`--no-enrich` opts out) and it is strictly a bonus: if OpenRouter itself fails, the sync
still runs unenriched and the report's `enrichedFromOpenRouter` flag says so.

**Two governing rules for what sync may do to an existing row:**

- **Sync never overwrites a human.** A `source: "manual"` row came from the config file or the
  dashboard, and its pricing is frequently the *corrected* pricing — typed because the upstream's
  number was absent or wrong. Sync fills the nulls such a row left and changes nothing else; a
  manual row with no gaps left is reported as `skippedManual`. A `synced` row is refreshed
  wholesale **except `enabled`**, which is the user's switch and never sync's to flip.
- **Sync never deletes.** A model that vanishes from a catalog is set `enabled: false`. Cost
  records and events hold references to it, and a vendor's catalog blinking out for one request
  must not vaporize history. `enabled: false` produces a 503 naming the model, which is also the
  right outcome when a model is genuinely retired.

Two smaller ones. New models arrive **disabled**: a catalog is hundreds of rows, and enabling all
of them would flood the digest the orchestrator reads and bill against models nobody chose — the
report says so in as many words. And `updatedAt` alone is not a change: a row whose facts match is
left untouched, so the report never claims work that did not happen.

A provider that fails is **recorded and stepped over** — half a registry refreshed beats none, and
one vendor rate-limiting you must not block the other twenty-six. The report names who failed, and
the CLI exits non-zero, because a cron'd sync that silently half-works is worse than a red one.

Sync resolves a provider's preset **through its id**, never its display name.
`presetSlugForProvider` inverts the derived `prv_…` id back to a slug via a reverse index;
lowercasing a name round-trips for maybe two thirds of the preset table (`"Google Gemini"` →
`googlegemini`, `"Z.AI (GLM)"` → `zaiglm`), and combined with `canSync(undefined) === false` a
missed lookup would *silently skip* the provider rather than erroring.

### Card generation: a model describes a model

`registry/cards.ts` asks one model to write the [capability card](#capability-cards) for another.
`rewter card <model>... --using <model>` drives it. The card is what the orchestrator reads when
it decides who does what, so every line of this module is written against one assumption: **the
generator is an unreliable narrator.** It will invent tags outside the vocabulary, wrap its JSON
in prose, write a paragraph where a clause was asked for, and occasionally claim a model is both
good and bad at the same thing. None of that may cost us the card, and none of it may put a value
into the registry the digest or the tag vocabulary cannot represent.

**The prompt** (`CARD_SYSTEM_PROMPT`, versioned by `CARD_PROMPT_VERSION`) interpolates the tag
vocabulary from `CapabilityTagSchema.options` rather than retyping it, so a tag added in `shared`
cannot silently go un-offered — which would leave it permanently unused. The user turn **states
the facts we already hold** (id, upstream id, context window, price, modalities, `supports`)
instead of asking for them: the generator's job is judgement, and it should not be guessing at a
price sitting in the database. The card carries no pricing, so it cannot overwrite one either.
Generation runs at `temperature: 0` — two runs should differ because the registry changed, not
because sampling did.

The prompt also **forbids stating any specification it was not given**. Parameter counts,
training-data cutoffs, architectures and benchmark numbers are exactly the details a generator
invents, and unlike a bad tag the router cannot check them — a wrong one is stored as prose and
quoted back as fact. Found by eyeballing real cards (M4's acceptance criterion, and precisely what
it was for): a card asserted the model it described was "9B-parameter" with nothing in the registry
saying so. Judgement about what a model is good at is what the generator is there for; specs are
what we already hold.

**The token ceiling has to clear the thinking, not the answer.** A card is ~80 tokens of JSON, so
`MAX_TOKENS` is a runaway guard rather than a target — but a reasoning generator spends its budget
reasoning first, charged as completion tokens and emitted before a single byte of the answer. At
800 the reply was cut off mid-JSON, so it is 4,000. And when a reply *is* truncated, the error says
so: `finishReason === "length"` appends the ceiling to the message, because "no JSON object in the
generator's reply" on its own blames the model for a limit that was ours, and sends the next reader
to debug the wrong layer.

**Parsing degrades; it does not throw.** `parseCardJson` throws only when there is no card to be
had at all — no JSON object, or one with no summary. Everything short of that is repaired:

- The object is found by **counting braces**, string- and escape-aware, not by slicing to the last
  `}` — trailing prose containing a brace would otherwise swallow the parse.
- The draft schema types tags as `string`, not the enum. A `z.enum()` would reject the whole array,
  losing four good tags to one invented one; instead unknown tags are dropped and **reported**.
- Tags are lowercased, trimmed and deduped, so `" Coding "` and `"CODING"` are one tag.
- A tag claimed as both a strength and a weakness is kept as the **weakness**. The two readings are
  not symmetric: a false strength gets a model *chosen* for work it bills for and fails, while a
  false weakness only forgoes an option.
- The summary is collapsed to one line and clamped to 180 characters, because the digest is one
  line per model and an overrun pushes it past its budget — silently dropping models.

What was discarded rides along in the result (`unknownTags`, `contradictions`) and is printed by
`formatCardReport`. A card quietly missing the one tag the generator cared about would read as the
generator's opinion rather than our filtering.

**Failure is a result, not a throw.** An upstream error or an unparseable reply becomes
`{error}` on that model's `CardResult`; `generateCards` steps over it and keeps going, and the CLI
exits non-zero. Generation is **sequential on purpose** — this is an interactive command against a
single upstream, and a parallel burst buys seconds at the price of rate-limit failures halfway
through a run the user then has to repeat.

Two things generation deliberately cannot do. It never authors `userOverrides` (that would be a
claim about the half of the row it cannot see), and `upsertCard` writes only the generated half —
so `--regenerate` can never destroy a hand correction, which is why it needs no confirmation
prompt. Cost is not accounted for here either: the call goes through `Router`, which records a
CostRecord for every completion, so cards land in the same spend ledger as everything else.

### Registry digest renderer

`renderDigest(entries, {maxTokens})` in `server/src/registry/digest.ts` renders section 2 of the
orchestrator prompt: one line per model, `<id> — <price>, <ctx>[, capabilities] — best:[…] —
avoid:[…] — <summary>`.

Two properties drive it. **Stability**, because the digest sits behind a `cache_control`
breakpoint — instability is a *cost* bug, not a cosmetic one. So: stable sort by model id, the
caller's array never mutated, no timestamps or wall-clock, and prices normalized through the
number (`0.6`, `0.60` and `0.1 + 0.5` must all render identically, since a synced price arrives
as arithmetic). **Density**, because this competes for context with the actual task: absent facts
are omitted rather than printed as "unknown", counts abbreviate (`1M`, `200K`), zero pricing reads
`free` rather than `$0/$0`, and only *notable* capabilities appear — `vision` and `caching` when
present, but `no tools` on **absence**, since tools are the norm and their absence is what rules a
model out of a tier of work.

Over budget (~4K tokens, crude 4-chars-per-token guardrail), models are dropped from the end of
the sorted list and the digest **says so**: `(N further model(s) omitted for space.)` An initiator
that cannot see a model will not choose it, and it should know that is why.

## Orchestrator engine

Implemented in M5a (the engine) and M5b (the wiring) — `packages/server/src/orchestrator/`.
`auto/orchestrator` is live on both dialects, streaming and not.

### The one decision everything else follows from

`Orchestrator.run()` returns `AsyncIterable<StreamChunk>` — *the exact type `Router.stream()`
returns*. An orchestration is therefore indistinguishable from a model call at the HTTP
boundary, so both dialect routes, both SSE translators, the `[DONE]` framing, the disconnect
handling and `collectStream()` for the non-streaming case all work on it unchanged. The
alternative — a bespoke progress channel — would have meant a second implementation of every
one of those, kept in sync by hand.

Progress therefore travels as ordinary `text_delta` chunks, so a client needs no rewter
awareness to show it: `curl` sees the feed, and so does Claude Code.

### The other invariant: bad model behaviour never throws

Every refusal is phrased as a *tool result* the initiator can read and correct: a
hallucinated model id, an unavailable tier, a `wait` on a label that was never spawned, a
handoff to an alias of the model already running, a spawn past the spending cap. A task must
not die because a model passed a number where a string was wanted. `executeTool` is the one
place arguments are validated and the one place a refusal is worded.

### Choosing the initiator

Explicit beats implicit: a `:pin` on the request, then the configured default, then a
heuristic — *the most expensive enabled model that supports tools*. Price is a crude proxy
for capability, but it is the only one available before any card is read, and the initiator
is exactly where being wrong is most expensive. Ties break on id, so the choice is
deterministic across restarts. The task row records the **canonical** id, not the alias the
caller typed.

### System prompt (cache-friendly order)

1. **Static core** (`ORCHESTRATOR_CORE_PROMPT`, versioned) — role, tier ladder, tool rules,
   cost discipline ("cheapest sufficient tier/model"), self-assessment + handoff criteria,
   narration conventions. Gets a `cache_control` breakpoint on the Anthropic adapter.
2. **Registry digest** — one compact line per active model rendered from Model+Card,
   stable-sorted for cacheability, ≤ ~4K tokens. Phase-2 stats append inside this same
   renderer. An empty registry says `registry is empty` rather than rendering nothing —
   silence would read as "no models exist".
3. **Task context** — the client's incoming conversation, **passed through untouched**,
   including its own system message. A router that quietly rewrote the caller's system prompt
   would be a bug the caller could never see from the outside.

### Initiator tools

`plan_note`, `spawn_worker` (returns a label **immediately** — parallel fan-out is several
spawns in one turn onto a p-limit scheduler, default concurrency 4), `wait({labels?,
mode:"all"|"any"})`, `get_result`, `cancel_worker`, `ask_user`, `handoff({to_model, reason,
context_summary})`, `finish({summary})`. (`send_to_worker` arrives with tier 2 in M6; a
tier-1 worker has nothing to receive.)

`wait` returns **summaries**, not full text: the initiator pulls the body with `get_result`
only for the workers whose detail it actually needs. In `"any"` mode a worker that finished
*before* the call already satisfies it — racing only the still-running subset would block on
a second result nobody asked for.

### Tier-1 workers

One chat call, ending with a `SUMMARY:` line that the initiator reads back. `splitSummary`
scans from the **end** of the text, because a worker summarizing a document that itself
contains "SUMMARY:" would otherwise hand back a line of its own input. Bold labels
(`**SUMMARY:**` and `**SUMMARY**:`, both seen in the wild) are tolerated. No summary line
falls back to the head of the body; an empty reply still yields something readable, since the
initiator has to be able to read it.

Every exit path — pre-aborted, thrown, error-finish, success, mid-flight abort — writes the
run lifecycle. `WORKER_RUN_TRANSITIONS` has no `created → succeeded` edge, so a path that
forgets `streaming` throws at the repo write and takes the whole task down. A throw *during*
an abort counts as cancelled, not failed: the two mean different things to the user, and the
signal is the only thing that can tell them apart.

### Progress-as-text

```
◆ plan: split into 3 subtasks          (dashboard: http://localhost:PORT/t/task_x)
▶ [w1 · gemini-flash · tier1] summarize repo docs — started
⏸ approval needed: shell `pnpm test` — approve in dashboard or reply "approve w2"
✔ [w1] done ($0.002, 3.1s)     ✖ [w2] failed: 429 rate limited     ⊘ [w3] cancelled
── final answer from finish() ──
```

Lines produced while awaiting a worker are queued and flushed at the next yield point, so a
generator that is parked inside `Promise.race` still gets its narration out in order.

### Handoff

Ends the current loop; the successor gets static core + digest + `context_summary` — **not**
the predecessor's transcript, which is mostly tool plumbing it would pay input tokens to read
and cannot act on. That economy is the whole point of a handoff. The successor continues on
the same task and the same SSE stream. Resolution happens *before* the self-handoff check,
because `resolve` accepts aliases and bare names and an alias of the current model would
otherwise slip through a raw string compare and loop. `maxHandoffs` (default 2) stops two
models passing a task back and forth.

### Cancellation and budget

AbortController tree: one per task, each worker's chained to it — a task abort reaches every
worker, a worker abort does not reach the task. A cancelled task ends `message_end`/**`stop`**,
not `error`: the user asked for it. Client SSE disconnect starts a 30s grace timer (allows
adoption/reconnect) before cancel; dashboard kill is immediate.

Budget: a soft note injected into the conversation once spending crosses 80% of
`maxSpendUsd`, and a hard refusal in `spawn_worker` at the cap — a note the model can ignore
is not a cap. Spend is read back from `cost_records`, never accumulated in memory, so it
survives a restart and cannot drift. Note that **the initiator's own turns bill to the task**,
so a task's total always exceeds the sum of its workers' spend.

Where that cap comes from is its own small problem. The OpenAI wire format has nowhere to put
a spending cap, so a request that specifies task settings is the exception, not the rule — which
means a cap that only ever arrives per-request is a cap that never arrives. The config file's
`orchestrator.maxSpendUsd` and `orchestrator.concurrency` are passed to the engine as
`defaultSettings` and merged under the request's own: request beats config beats schema default.
The merge drops `undefined` values rather than spreading them, because `{...{cap: 1}, ...{cap:
undefined}}` is `{cap: undefined}` — a partial that mentions a key without setting it would
otherwise erase the configured value. Discovered live: before this, a configured cap parsed
cleanly, appeared in the docs, and did nothing.

### Wiring it to HTTP (M5b)

`Orchestrator.run()` being a plain `AsyncIterable<StreamChunk>` is what makes the route code
uneventful — but a bare async generator does not run its body until the first pull, and by
then it is too late to set a header. `start()` therefore does the eager part up front
(resolve the initiator, parse task settings, write the task row) and returns
`{ taskId, abort, stream }`. The route sets **`x-rewter-task-id`** from it *before* the SSE
writer touches the socket, because a header set after the first byte is a header nobody
receives. A bad `:pin` or an empty registry consequently fails as a clean JSON `404`/`503`
rather than as a truncated event stream.

**The engine's stream is not the client's stream.** A `LiveTask`
(`orchestrator/live.ts`) pumps the engine into an unbounded replay buffer and broadcasts to
whatever subscribers exist at that moment — *possibly none*. That is the load-bearing part:
a client that disconnects loses nothing, because the pump never stops. Original client,
reconnecting client and steering follow-up are then all the same thing — a subscriber that
replays the buffer and then follows live.

**Steering by re-POST.** An OpenAI client has no channel for "say something to a request
already in flight"; all it can do is POST the conversation again, one turn longer. So that is
the protocol. `LiveTaskIndex.match()` resolves a request against what is running, preferring
the `x-rewter-task-id` header when the client can echo it and falling back to the
conversation itself: `continuationKeys()` hashes the request's *prefixes*, longest first and
bounded at 8, and looks each up. A hit means this request grew out of that task; the messages
added since are injected as `[USER STEERING] …` at the next turn boundary, and the new
request attaches to the existing stream instead of starting a second task. An identical
re-POST with nothing new is deliberately *not* a match against itself — that is a retry, and
matching it would inject the whole conversation back into the task as steering. A conversation
that continues a task which already **finished** starts a fresh task: `onIdle` forgets a task
the moment it completes.

**Disconnect grace.** Losing the last subscriber starts a 30-second timer, not a cancel — the
window in which a reconnect can adopt the task. A subscriber arriving inside it calls
`cancelGrace` and the task never notices. Nobody arriving means the abort fires, so a Ctrl-C
does not leave a fan-out billing to an audience of none. `shutdown()` collapses every live
task, which is why `daemon.stop()` runs it *before* closing the HTTP server.

Note the cycle this creates and how it is broken: the engine needs somewhere to read steering
from, and the `LiveTask` that holds it does not exist until the engine's stream does.
`beginOrchestration` passes a `() => box?.drainSteering() ?? []` closure over a
`let box: LiveTask | null`, filled in by `register()` immediately after — the engine only
reads it between turns, long after that.

Two behaviours here are testable only over a **real socket**: `app.inject()` serializes
in-flight streaming requests, so a second `inject()` call's handler does not run until the
first stream has finished — and a finished task is not a task you can steer. The steering
tests in `app.orchestrator.test.ts` bind an ephemeral port for exactly that reason, as the
disconnect tests in `app.socket.test.ts` already did.

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
adapter's normalized chunk stream. The orchestrator sits *beside* it, not above it —
`auto/orchestrator` diverts before resolution. The engine returns the same
`AsyncIterable<StreamChunk>` this path does, which is why the divert costs the route code
almost nothing — see [Wiring it to HTTP](#wiring-it-to-http-m5b). A daemon built without an
engine answers `501` there rather than silently routing to some arbitrary concrete model.

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

### The Anthropic surface (`POST /v1/messages`)

Claude Code — the whole point of the M3 acceptance criterion — talks Anthropic's Messages
API, not OpenAI's. The plan filed this as a "phase-2 nicety"; that was a misread, since
without it the milestone's own "replaces 9router" test cannot be run at all. It is M3d.

Everything below the parse is the **same router call** the OpenAI route makes: the two
surfaces converge on `ChatMessage[]` at the edge and then share one routing, retry, cost
and cancellation path. Only translation differs.

**Two directions that look alike and must never be shared.**
`providers/anthropic.ts` translates our internal format *up* to a vendor we call.
`shared/anthropic.ts` translates a client's request *down* into ours. Merging them would
couple "what Claude Code sends us" to "what we send Anthropic", which are free to diverge.

**Request translation** (`fromAnthropicMessages`) is a `flatMap`, not a `map`, because the
shapes genuinely disagree:

- `system` is a *sibling field*, not a message — hoisted to a leading `system` message.
  Block-array systems join with blank lines; an empty one is omitted, not emitted blank.
- A `system` role **inside `messages`** is accepted too, even though Anthropic's documented
  roles are only `user`/`assistant`. Claude Code sends one on every request, and rejecting it
  400s the whole session over a role every adapter downstream already handles. It keeps its
  position rather than being hoisted: a mid-conversation system turn means something where it
  sits, unlike the top-level parameter. A role we cannot map at all is still rejected.
- Anthropic batches several `tool_result` blocks into **one** user turn; our format gives
  each tool response its own message, so one turn can expand to several.
- Those tool results are emitted **before** the turn's own text: they answer the *previous*
  assistant turn, and upstreams that pair calls to results need them adjacent to the call.
- A turn that is *only* tool results produces no user message at all.
- `tool_use.input` is an object on the wire and a JSON *string* internally; `tool_result`
  block arrays are flattened to text.
- Unknown block types (`image`, `document`, `thinking`) are **dropped, not rejected** —
  vision routing is M4, and dropping a block is very different from 400-ing a whole
  conversation. Unknown top-level knobs (`top_k`, `stop_sequences`, `thinking`) parse and
  are simply not forwarded. `max_tokens` *is* required, unlike OpenAI's.

**Streaming is where the two protocols diverge most.** Anthropic's stream is a **named-event**
stream — every frame is `event: <name>\ndata: <json>\n\n` — and its clients dispatch on that
`event:` line, so a data-only frame is invisible to them. There is **no `[DONE]` sentinel**;
clients terminate on `message_stop`, and a stray `data: [DONE]` is an unparseable frame.
`SseWriter.sendEvent()` exists for exactly this framing.

More consequentially, **Anthropic's stream is stateful where OpenAI's is not**. OpenAI frames
are independent — each names its own choice and tool index — so a pure function suffices.
Anthropic requires content blocks to be explicitly opened (`content_block_start`) and closed
(`content_block_stop`), **at most one open at a time**, with a running index. Our internal
grammar has no such notion, so `AnthropicStreamTranslator` is a class that remembers which
block is open. Its invariants:

- A tool call arriving after text **closes the text block first** — emitting a start while
  another block is open is a protocol violation.
- Parallel tool calls each get their own block index; `input` opens as `{}` and is filled by
  `input_json_delta` frames (not `text_delta`).
- `message_start` carries **zero usage**, because real input-token counts only arrive at
  `message_end`; the true totals ship in `message_delta`. This is what Anthropic itself
  does, and the client adds them.
- The message is **always terminated**. A mid-stream error emits an `error` event and then
  still closes the message; a stream that dies with no terminal chunk is closed by
  `finishIfOpen()`. A client must never be left waiting on a `message_stop` that never comes.

Non-streaming responses mirror this: a text block only when content is non-empty, one
`tool_use` block per call, and `input` **parsed** back into an object — a model emitting
malformed JSON degrades that one block to `{}` rather than 500-ing the response.

Errors use Anthropic's own envelope (`{type: "error", error: {type, message}}`), including
the `401`, so an Anthropic client can parse a rejection the same way it parses a success.

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

**Two header conventions, one token.** OpenAI clients send `Authorization: Bearer …`;
Anthropic clients (Claude Code among them) send `x-api-key` and never set `Authorization`
at all. Both are accepted against the same configured key, so one value works for both
surfaces instead of forcing the user to configure two. The rejection is shaped to match the
surface being called: Anthropic's error envelope on `/v1/messages`, OpenAI's elsewhere.

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
job; those commands exit 1 naming the milestone rather than pretending.

`rewter sync-models [--dry-run] [--no-enrich] [--provider <slug>] [--config <path>]` refreshes
the registry from the providers' catalogs — see [Model sync](#model-sync-catalogs--registry) for
the policy. It is a **one-shot that opens the database directly** rather than talking to a running
server: it has to work whether or not the daemon is up, and booting a second server to read a
table would fight the first for the port. SQLite in WAL mode makes the concurrent write safe.
`openRegistry()` is the extracted config → database → seeded-registry prefix of `startDaemon`, so
a CLI invocation sees exactly the rows the daemon would. Because enrichment reads OpenRouter out
of the same provider list, `--provider` can scope it away and turn it into a silent no-op; the CLI
says so on stderr rather than leaving you wondering why the prices are still null.

`rewter card [<model>...] --using <model> [--all] [--regenerate] [--show] [--dry-run]` writes
capability cards — see [Card generation](#card-generation-a-model-describes-a-model). Two guards
stand between a typo and a bill. **`--using` is required and has no default**: the generator is
billed and its judgement is what the orchestrator acts on for the life of the card, so picking one
silently — cheapest, first-enabled, whatever — would be the wrong kind of convenience. And
**naming no model is not "do them all"**: a synced registry is hundreds of rows, so `--all` has to
be asked for, and it means all *enabled* models, which is the set the orchestrator can choose
from. An unknown target or an unresolvable `--using` fails before anything is spent, and a model
that already has a card is skipped unless `--regenerate` says otherwise. `--show` only reads, so
it needs no `--using`.

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

- `POST /v1/chat/completions` — OpenAI dialect; pass-through or orchestrator; stream +
  non-stream. **Live**, orchestrator included. Sends `x-rewter-task-id` on an orchestration;
  accepts it back to steer or reattach.
- `POST /v1/messages` — Anthropic dialect over the same router; stream + non-stream.
  **Live**, orchestrator included. Named-event SSE, no `[DONE]`; accepts `x-api-key` or
  `Authorization: Bearer`; same `x-rewter-task-id` contract.
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
- **Phase 2**: tier-3 harness adapters, tmux attach/mirror, learned-from-experience stats.
  (The plan listed Anthropic-native `/v1/messages` here; it was pulled into phase 1 as M3d
  once it became clear M3's own acceptance criterion depends on it.)
- **Phase 3**: multi-initiator handoff chains, budgets, scheduling.

## Key risks

- **Orchestrator prompt quality is the product** — prompts are versioned `.md` files,
  snapshot-tested; a small hand-scored eval script (5–10 canned tasks) is built in M5.
- **Streaming edge cases** — contract fixtures include truncated/error/split-tool-arg streams.
- **Dev cost surprises** — FakeProviderAdapter default in tests; `REWTER_DRY_RUN=1` routes
  everything to local Ollama.
