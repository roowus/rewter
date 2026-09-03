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
    (plain routing) or, when `model` is the pseudo-model `auto/orchestrator` (also `auto`),
    diverts into the **orchestrator engine**. The full grammar is
    `auto[/orchestrator][@<project-slug>][:<modelId>]` — `@` selects a
    [project](#projects-p2-m1), `:` pins the initiator, in that order because slugs never
    contain `:`.
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
| 3 | External harness session — headless Claude Code **live** (P2-M5 slice 1: direct process, mid-run `send()`, spawn gate, cost visibility; slice 2: `tmux attach -t rwtr_<runId>` live mirror; slice 3: restart re-adoption via `--resume`; slice 4: the generic adapter spec — any CLI as a harness by config, so aider/codex are config entries, not code) | Phase 2 (slices 1–4 shipped) |

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

A client that holds the task id (the `rewt` TUI) skips the fingerprint and uses the direct
door, `POST /internal/tasks/:id/steer` — same parser, exact injection. See
[Steering by id](#steering-by-id-the-second-door-p2-m3).

## Safety: approval gates

All risky actions flow through one choke point (`approvals.require`):

1. Policy check — task auto-approve on? path inside the task workspace? command on the
   read-only allowlist (`ls`, `git status/diff/log`, `pnpm test`, …)? → auto-approved
   (still logged as an event).
2. Otherwise: pending `Approval` row + event → dashboard card AND an SSE text line in the
   client stream.
3. The tool call parks on a promise, resolved by `POST /internal/approvals/:id` or an
   in-band `approve <id>` / `a w1` reply.
4. Denied → the tool returns `{ error: "denied by user: <note>" }` so the worker LLM adapts
   or reports failure.

Risk classes: `shell` gated unless allowlisted-readonly; file writes gated iff outside the
task workspace; `web_fetch` and `web_search` logged, ungated.

### As built (M6a/M6b)

`workers/workspace.ts` and `workers/approvals.ts` implement steps 1–4 above, split so that
**neither one decides alone**:

- **`classify(ws, path)` answers exactly one question** — is this path inside the
  auto-approve zone? — and never refuses. Refusal is a policy call made one layer up with
  the task's `autoApprove` in hand; a sandbox that refuses on its own is a sandbox you
  cannot point at a repo, which is precisely what `workspaceDir` is for.
- **`root` and `cwd` are separate fields on purpose.** `root` is
  `~/.rewter/workspaces/<taskId>/`, the auto-approve zone. `cwd` is where relative paths
  resolve and `shell` runs — equal to `root` unless the task names a real project
  directory, in which case every write is outside the zone *by construction*. That is the
  intended reading: pointing a worker at your repo is exactly when you want to be asked.
- **Containment is checked on symlink-resolved paths, with the separator appended.** The
  cheap string test is defeated twice over — by `root/../etc/passwd`, and by a symlink
  inside the workspace pointing out of it — and without the separator
  `/workspaces/task-1-evil` counts as inside `/workspaces/task-1`. A path whose parent does
  not exist yet (the ordinary `write_file` case) is resolved as far up as it does exist,
  because you cannot `realpath` a file you are about to create, and skipping the check for
  those is the only hole that would matter.
- Both `Workspace` fields are stored resolved, and must be: on macOS `/var` is a symlink to
  `/private/var`, so a resolved `root` and an unresolved `cwd` name the same directory and
  compare unequal — `contains(root, cwd)` would then report the workspace as outside itself.

The gate itself is one `require()` method, and there being exactly one is the safety
property: a second path to the disk is a second place to forget it. Callers `await` a
verdict and either act or hand the denial to the model — they never read `autoApprove` and
never learn whether a human was involved.

- **Auto-approval is recorded, not skipped.** Every allowed-without-asking action writes a
  row whose note names *which* rule let it through ("auto-approve is on for this task",
  "inside the task workspace", "read-only command"), so "nothing needed asking" and "the
  user turned the gate off" are distinguishable afterwards. `autoApprove` is read fresh per
  call, since the user may flip it mid-task.
- **A denial is not an error.** It returns `{ok: false, reason}`, and the reason carries the
  user's note: a worker told "denied: use the test fixture instead" adapts, where one told
  "denied" retries the identical command and one that throws dies.
- **Cancellation denies everything parked**, and refuses later requests before consulting
  policy at all — a torn-down task must not leave a worker awaiting a human who has closed
  the tab, however harmless the individual step looks.
- **The read-only allowlist is an allowlist, and forfeits on any shell metacharacter.** You
  cannot enumerate every way to write to a disk, but you can enumerate the handful of
  commands whose whole job is to look. `ls; rm -rf ~` begins with `ls`, so the check is
  "this is one simple command from the list" rather than "it starts with one"; `-o` and
  `--output` are rejected too, since those flags write from a verb that reads.
- The `approval.requested` / `approval.resolved` events are emitted by `repos`, as part of
  the write — the gate deliberately does not append its own, or one prompt would produce two
  dashboard cards.

## Monorepo layout

```
packages/shared/     @rewter/shared — THE contract package: zod entities + lifecycle state
                     machines, unified chat/stream format, event envelope (server↔dashboard
                     contract), dashboard API schemas, branded IDs (task_, run_, apr_, evt_)
packages/server/     @rewter/server — the daemon:
                     config, db, providers, registry, router, orchestrator,
                     workers/{workspace,approvals,tier2,tier3-stub}, events, costs, http, openai
                     (tier 1 lives in orchestrator/worker.ts — it is one chat call)
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
| Dashboard | Vite + React 18, zustand, plain CSS | local ops UI, no SSR. No router: one page. No query layer: nothing to fetch — see [the dashboard app](#the-dashboard-app-one-store-one-clock-m7c) |
| Validation | zod (in `shared`) | validates OpenAI requests, LLM tool args, config, DB round-trips; `zod-to-json-schema` for tool defs |
| Tests | vitest + recorded wire fixtures + in-memory SQLite + FakeProviderAdapter/ScriptedModel | deterministic, no keys/network |
| Lint/format | Biome | one fast tool |
| SDKs | `@anthropic-ai/sdk` (native), `openai` (covers all OpenAI-compatible upstreams via baseURL), `@google/genai` | |
| Daemon | `rewter start` runs in the foreground (dev, and what launchd wants); `rewter install-service` writes the plist; keys from `~/.rewter/env`; logs `~/Library/Logs/rewter/` | |

## Domain model

Entities (zod-typed in `shared`):

- **Provider** — kind, baseUrl?, `apiKeyRef` (env var *name* — raw keys never in DB), enabled, priority.
- **Model** — `<provider>/<model>` id, pricing, contextWindow, modalities,
  `supports{tools,streaming,vision,caching}`, source (synced|manual). Each `supports` flag is
  **tri-state** — see [Capabilities are tri-state](#capabilities-are-tri-state).
- **CapabilityCard** (1:1 Model) — summary, strengths[], weaknesses[], bestAt[]/avoidFor[]
  (tags from a **fixed vocabulary** that doubles as the learned-stats key), tierHint, speed,
  `userOverrides` (JSON patch that survives regeneration). Stored in two halves — see
  [Capability cards](#capability-cards).
- **Project** (P2-M1) — the Multica-style top-level unit tasks run under; slug (unique,
  URL/model-string safe), resources[] (`repo|dir|url|note` with optional note), policy
  (autoApprove, maxSpendUsd, allowedTools — a phase-2 seam, not yet enforced — and
  allowedHarnesses, enforced since P2-M5: null = all configured harnesses, a list =
  whitelist by adapter id), modelPrefs (initiatorPin, prefer[], avoid[]), archived flag.
  Projects are **configuration, not lifecycle**: no state machine, no events, no FK from
  tasks — see [Projects](#projects-p2-m1).
- **Task** — one orchestrated request; workspaceDir, autoApprove, settings (maxSpendUsd?, maxParallel?),
  `projectId?` (nullable — pre-projects rows and project-less tasks replay identically).
- **WorkItem** — subtask; `parentWorkItemId` builds handoff chains; `taskTag?` (nullable, one
  of the card vocabulary) is what the initiator said the work *was* when it spawned the worker —
  the key the learned stats fold under. Absent means "the initiator did not say", and such an
  item is never counted (migration `0003_work_item_tag`).
- **WorkerRun** — one execution attempt (retry/handoff = new run); `harnessSessionId?` is written by the tier-3 runner (the restart re-adoption seam).
- **Event** — append-only, autoincrement `seq`; **source of truth** for dashboard replay and audit.
- **Approval** — kind (shell|write_outside_workspace|spawn_harness|budget|other), status, resolvedBy.
- **CostRecord** — token counts incl. cache read/write; costUsd computed at write time from a pricing snapshot.
- **FailureRecord** — one failed upstream attempt as the router saw it: `phase`
  (before_output|mid_stream), `attempt`, `retried`, `retryable`, `statusCode`, clipped
  `message`; nullable `taskId`/`workerRunId` like a cost record. Not an event — see
  [Failure recording](#failure-recording-issue-9).
- **ModelStat** — (modelId, taskTag) → attempts/successes/avgCostUsd?/avgLatencyMs?. Running
  means, upserted per observation by the stats recorder — see
  [Learned stats](#learned-stats-the-recorder-and-the-digest). The schema waited from M1; the
  writer arrived 2026-09-02.

### Lifecycle state machines

Pure `assertTransition` functions in `shared`, exhaustively tested, invoked by every repo write:

```
Task:      pending → running → succeeded|failed|cancelled|interrupted  (⇅ waiting_approval — pauses the branch, not the task)
WorkItem:  pending → running → succeeded|failed|cancelled|handed_off|interrupted (⇅ waiting_approval)
WorkerRun: created → streaming ⇄ tool_pending → succeeded|failed|cancelled|interrupted
Approval:  pending → approved|denied|auto_approved|expired
```

Every non-terminal state of the first three also admits **`interrupted`**, which only boot
reconciliation writes — see [Boot reconciliation](#boot-reconciliation-m8).

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

#### Capabilities are tri-state

`supports.{tools,streaming,vision,caching}` is `true | false | null`, and **`null` — nobody
reported it — is the common case.** Most catalogs are an id list, so a boolean there would be a
guess wearing a fact's clothes, and the guess costs something in either direction: a `tools: true`
gets a tool-less model spawned for tier-2 work, where it fails on its first tool call; a
`vision: false` takes the only model that could have read the scan out of the running for the
subtask that needs it.

What each parser may claim follows from the **scope of the claim it is in a position to make**:

- `parseOpenAi` reports `tools/vision/caching` as `null`. One parser serves OpenAI, xAI, Z.AI,
  Ollama and LM Studio from a response that carries an id and nothing else — there is no
  line-wide fact to lean on. **Unless the row volunteers a `capabilities` object**, which is
  not in the OpenAI spec but is what 9router hangs off each row: `{tools, vision,
  contextWindow, maxOutput}`. That is a *report*, and the whole point of tri-state is that a
  report outranks silence, so the parser reads it — `caps?.tools ?? null`, where the `??`
  keeps an absent object silent rather than promoting it to a denial. Every field is
  optional, so this is a superset of the spec and a server that sends no such object parses
  exactly as it always did (a test asserts precisely that). Reading four fields off the
  object is not licence to invent a fifth: 9router says nothing about caching, so `caching`
  stays `null`.
- `parseAnthropic` keeps its `true`s. That endpoint only ever answers for Claude, and every model
  in the line does tools, vision and prompt caching. Unreported, but not a guess.
- `parseOpenRouter` treats an **empty** `supported_parameters` as a report (`tools: false`) and an
  **absent** one as silence (`null`). An empty array is an answer; a missing field is not.
- `parseGoogle` reports `tools`/`streaming` from `supportedGenerationMethods` and leaves
  `vision`/`caching` null — Gemini is multimodal across the line, but the catalog does not say so
  per model.

Config blocks and the registry editor default the same way: an omitted field is unknown, not
denied. Consumers must therefore test the literal, never falsiness. The digest renders `no tools`
only on `=== false` and says nothing at all about a `null`, because silence is the honest
rendering of silence; `pickInitiator` filters on `!== false` for the same reason — excluding
unknowns would leave a local-only registry with nothing able to lead.

**Enrichment.** Most catalogs are an id list and nothing else, which would leave the registry
priceless and the orchestrator with no basis for preferring a cheap model. So OpenRouter's
catalog — which prices essentially the same models — fills the gaps in everyone else's, matching
on the id tail with any variant suffix dropped, first writer wins. It is **on by default** in the
CLI (`--no-enrich` opts out) and it is strictly a bonus: if OpenRouter itself fails, the sync
still runs unenriched and the report's `enrichedFromOpenRouter` flag says so.

Capabilities merge by the same rule as pricing — **fill an unknown, never contradict a report**
(`entry.supports.x ?? match.supports.x`). This was a disjunction while a bare catalog's entries
were assumed `false` and a third party's `true` deserved to win over an assumption; under
tri-state `||` would be actively wrong, quietly reading `null || false` as a denial.

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
because sampling did. Unreported capabilities are **named as unknown** in that facts list rather
than dropped from it: the prompt forbids stating a specification it was not given, so an omitted
`vision` reads as the same silence as `vision: false`, and the generator has no way to tell them
apart. Saying "unknown" out loud is what lets it write a card that admits the gap.

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
avoid:[…] — stats:[…] — <summary>`. The `stats:` fact is the learned record, rendered from
`ModelStat` rows the caller passes in — see
[Learned stats](#learned-stats-the-recorder-and-the-digest) for what it says and why it sits
where it does.

Two properties drive it. **Stability**, because the digest sits behind a `cache_control`
breakpoint — instability is a *cost* bug, not a cosmetic one. So: stable sort by model id, the
caller's array never mutated, no timestamps or wall-clock, and prices normalized through the
number (`0.6`, `0.60` and `0.1 + 0.5` must all render identically, since a synced price arrives
as arithmetic). **Density**, because this competes for context with the actual task: absent facts
are omitted rather than printed as "unknown", counts abbreviate (`1M`, `200K`), zero pricing reads
`free` rather than `$0/$0`, and only *notable* capabilities appear — `vision` and `caching` when
present, but `no tools` on **absence**, since tools are the norm and their absence is what rules a
model out of a tier of work.

Over budget (~4K tokens), models are dropped from the end of the sorted list and the digest
**says so**: `(N further model(s) omitted for space.)` An initiator that cannot see a model will
not choose it, and it should know that is why.

The budget is metered by `estimateTokens` (`registry/tokens.ts`) — a segment estimator, not a
real tokenizer (issue #8): letters ~4 chars/token, digit runs ~3/token, every symbol a full
token, whitespace free. Digest lines are dense with ids, prices, and bracketed tags — content
where BPE emits near one token per symbol, so the old flat 4-chars-per-token count ran ~2×
low on exactly these lines. The estimator is deliberately biased **high**, because the failure
modes are asymmetric: a low estimate silently pushes the cache breakpoint and bills every
orchestration; a high one drops a model with an honest note. Tests pin the estimate at-or-above
hand-checked cl100k counts for representative digest content. The same estimator meters every
prompt-budgeted block — the skills digest reuses it with a 1000-token budget.

### Learned stats: the recorder and the digest

The `model_stats` table has existed since M1 with nothing writing to it. As of 2026-09-02 it
is live: `wireStatsRecorder` (`server/src/registry/stats.ts`) is an **event-bus subscriber**
the daemon wires next to the skills distiller and unsubscribes in `stop`, and the digest
renders what it records. Three decisions shape it.

**The tag comes from the initiator, not from us.** `spawn_worker` takes an optional `tag` from
the card vocabulary (`coding`, `summarization`, `ocr`, …) and it lands on `WorkItem.taskTag`.
Nothing infers a tag from the instructions — a classifier guessing "coding" for a
summarization job would teach the table a falsehood with the same confidence as a truth. The
prompt tells the initiator to tag whenever it knows and never to guess; an untagged worker is
simply not counted. Free text is refused at parse time with the vocabulary in the message, so
the fix is one turn away and the table never grows a key nobody reads.

**What counts as an observation.** The recorder listens for `work_item.status_changed` and
records when the new status is terminal, tagged, and *about the model*: `succeeded` is a
success; `failed` and `cancelled` are attempts that did not succeed. `handed_off` is not an
observation of the worker (the work moved, it did not finish), and `interrupted` is the daemon
dying, not the model failing — it is only ever written by boot reconciliation, before the
subscriber exists, and the recorder unsubscribes before shutdown drains running items to
`cancelled` for the same reason. Cost is the sum of the `cost_records` rows whose
`workerRunId` belongs to one of the item's runs — not the task's total, which includes the
initiator's own spend — and `null` when there are none (a free local model and an unmetered
one are different facts). Latency is `finishedAt − createdAt` on the item: queue time
included, because that is what the initiator waited.

**Why a subscriber and not a call in the engine.** Every path that settles a work item —
engine success, tier-2 failure, `cancel_worker`, dashboard kill, budget refusal — already goes
through `transitionWorkItem`, which emits the event. One listener covers all of them and
cannot be forgotten by the next path added. The store fold is a running mean per
`(modelId, taskTag)` (`Repos.recordOutcome`, upsert); a `null` mean stays untouched by a
`null` observation. A recorder failure is a **warning**, never an exception into the write
path — statistics must not be able to fail a task.

The digest then renders `stats:[coding 4/5 ok ~$0.0123 ~14s, summarization 2/2 ok ~$0.0012
~3s]` between `avoid:` and the card summary: sorted by tag, counts rather than percentages
(so the initiator sees evidence volume — `1/1` is an anecdote, `9/10` is a record),
money to four places, whole seconds under a minute and tenths of a minute above, an
unmeasured mean omitted, and the whole fact omitted when there is nothing to say. Prompt
version 7 tells the initiator to weigh `stats:` above `best:` when the two disagree and to read
the denominator. The digest is still deterministic for a given registry; stats move it at most
once per settled worker and `buildMessages` runs once per session (and once on handoff), so
the cache breakpoint never moves mid-orchestration.

## Projects (P2-M1)

A project is the persistent thing a task runs *under* — the Multica-style unit that owns
resources (repos, dirs, URLs, notes), policy caps, model preferences, and (from P2-M4)
scoped learned state. Schemas live in `@rewter/shared` (`ProjectSchema`,
`effectiveTaskSettings`, `primaryWorkspace`); storage is a plain `projects` table with a
UNIQUE slug and **no FK from `tasks.projectId`** — a deleted project must not orphan its
history, and `Task.projectId` defaults to `null` in the schema so event-log replay of
pre-projects databases parses unchanged.

Projects are deliberately **configuration, not lifecycle**: no state machine, no events, no
status column. The one flag, `archived`, is enforced at the selection layer (the repo still
returns the row; HTTP refuses to *start* under it), so archiving is reversible bookkeeping
rather than a terminal state.

### Selecting a project

Two equivalent channels, for two kinds of client:

- **Model suffix** — `auto@<slug>` (optionally `auto@<slug>:<pin>`), for clients whose only
  configurable knob is the model string (Claude Code's model picker).
- **Header** — `x-rewter-project: <slug>` (`PROJECT_HEADER`), for clients that can set
  headers but not mangle the model name.

If both are present they must **agree**, or the request is a 400 ("pick one") — guessing
would silently run the task under the wrong project's policy. An unknown slug is a 404
(`ProjectNotFoundError` — the project-shaped "unknown model"); an archived project is a 400
(`ProjectArchivedError` — the server understood and refuses, and "unarchive it" is
actionable in a way "typo" is not). All of this resolves **before** `live.match`, so a
steering re-POST is validated the same way, and before any task row exists, so a refused
request leaves no trace. The suffix parser (`projectSlug` in `router/resolve.ts`) is
deliberately looser than `ProjectSlugSchema`: existence is the lookup's question, so
`auto@Bad_Slug` reads as "no such project", not "unknown model".

The engine's boundary is an already-resolved `Project` object, never a name — HTTP owns
slug lookup and the archived refusal; `/internal/run` carries the project in the model
string only.

### What a project changes about a task

Three things, all at task creation, none afterwards:

1. **Initiator precedence** — request `:pin` → project `modelPrefs.initiatorPin` →
   configured `defaultInitiatorModel` → the price heuristic. A project pin resolves through
   `router.resolve`, so a pin naming a removed model fails loudly before a task row exists.
2. **Policy fold, tighten-only** — `effectiveTaskSettings(project, requested)`: autoApprove
   is ANDed (a project can force gates on, never off), maxSpendUsd takes the lower cap
   (null loses to any number). Folded **once** in `start()`; the task row records the
   result, so replay never re-derives policy from a project that may since have changed.
3. **Workspace default** — a task with no `workspaceDir` gets the project's primary
   workspace (first `dir` resource, else first `repo`). An explicit `workspaceDir` is kept:
   narrower is not loosening.

`modelPrefs.prefer/avoid` are **hints, not rules** (locked decision: advise-only) — they
render into the prompt, and enforcement stays the engine's. Policy is deliberately *absent*
from the prompt: the model has no business knowing the cap it should be trying to respect
anyway, and enforcement that depends on the model reading a number is not enforcement.

### The prompt block

`renderProjectBlock` renders name, description, resources (with kinds and notes), and the
prefer/avoid hints. It is spliced into the **per-task region, after the registry digest** —
the digest is the cacheable region shared across projects, and a project block before it
would invalidate the prompt cache for every other project's tasks. Empty sections are
omitted rather than rendered as headers over nothing. `ORCHESTRATOR_PROMPT_VERSION` was
**not** bumped: the static core is unchanged, and the version guards exactly that constant.

### Editing projects: the CRUD and the panel

Four routes on `/internal`, addressed by **slug** — the same name `auto@<slug>` and the
header use, and unlike model ids a slug carries no `/`, so plain `:slug` params work where
the models routes need trailing wildcards.

- `GET /internal/projects` hides archived rows by default; `?includeArchived=true` shows
  everything. The dashboard client always asks for everything and splits in render — an
  unarchive button cannot exist on a list that hides its target.
- `POST /internal/projects` takes `ProjectCreateSchema` (strict): slug + name required,
  description/resources/policy/modelPrefs default. The id, timestamps, and `archived` are
  **not** fields — the server mints them, and a project born archived is a contradiction. A
  taken slug is a **409**, not an upsert: creating over an existing project would silently
  adopt its history.
- `PATCH /internal/projects/:slug` takes `ProjectPatchSchema` (strict — a misspelled field
  is the failure that looks like success). The **slug is not patchable**: it is the
  project's address, and a rename would strand every client config pointing at the old one.
  Archive/unarchive ride here as a plain `archived` boolean. A patch that changes nothing
  returns `{project, changed: false}` **without writing** — `updatedAt` stays honest, same
  contract as the model editor.
- `DELETE /internal/projects/:slug` removes the row and deliberately leaves every task's
  `projectId` alone (no FK, same reasoning as cost records naming retired models). Archive
  is the everyday off-switch; delete is for rows created by mistake, and the dashboard only
  offers it on rows that are already archived.

The shared halves (`ProjectCreateSchema`, `ProjectPatchSchema`, `applyProjectPatch`) live in
`shared/src/projects.ts` next to the fold they configure. The dashboard's `ProjectsPanel`
(collapsed by default, like the registry) shows the three things the daemon reads at task
creation — workspace, policy, pin — with in-place toggles for auto-approve and
archive/unarchive; create takes slug, name, and an optional workspace dir (which becomes the
first `dir` resource), and everything else starts at the schema's safe defaults.
Prefer/avoid lists, extra resources, and the description stay curl-territory for now.
Archived rows keep their own dimmer table, and delete (two-click, armed) only appears there.
The run panel gains a project picker that excludes archived projects (they refuse a run with
a 400) and encodes the choice as `auto/orchestrator@<slug>[:<pin>]` — project before pin,
because slugs never contain `:`.

## Skills (P2-M4): the SKILL.md store and index

The learning loop's substrate (design: `docs/design/phase2-direction.md` §2). A skill is one
directory holding one `SKILL.md` — the agentskills.io format verbatim: YAML frontmatter with
`name` + `description` (≤1024 chars), markdown body. rewter adds three **optional** provenance
keys other tools ignore: `learned_from: task_…`, `uses: n`, `project: <slug>`. Frontmatter is
`.passthrough()` — an imported Claude Code skill carries `license`, `allowed-tools`, `metadata`
and must not be refused for them — while the known keys are still hard-validated, because the
same schema gates LLM output in the distill path.

**Files are the source of truth; the DB only indexes them.** A skill you can't open in an
editor is a skill you can't fix. The tree (default `~/.rewter/skills`, config `skillsDir`):

```
global/<slug>/SKILL.md          approved — every task sees it
<project-slug>/<slug>/SKILL.md  approved — tasks under that project see it
pending/<slug>/SKILL.md         staged drafts — NEVER retrieved
```

Consequences of that layout, each load-bearing:

- **Scope is read off the directory** for approved skills. Where the owner put the file *is*
  the approval act, and outranks anything the frontmatter claims — a skill moved to `global/`
  that still says `project: clarity` is global; the move was the decision. Pending drafts live
  in `pending/` by definition, so for them the frontmatter `project` key carries the *target*
  scope instead: where the file will go on approval.
- **`global` and `pending` are reserved project slugs** (`RESERVED_PROJECT_SLUGS`), refused by
  `ProjectCreateSchema` — a project named `pending` would collide with a scope directory on
  disk. The refine lives on *create*, not in `ProjectSlugSchema` itself: refusing to read
  existing data is never the right failure mode for a rule about creating it.
- The frontmatter `name` must equal the directory name, enforced at index time — the slug is
  the address (`load_skill <slug>`, the digest line) and the directory is what the owner sees;
  silence about a mismatch would advertise a slug that can't be loaded.

The scanner (`server/src/skills/store.ts`) faces an **untrusted tree** — owner-edited,
owner-imported — so its contract is: parse what's valid, *name* what isn't, never throw. Every
unreadable file becomes a `SkillProblem {path, reason}` in the scan result ("frontmatter is not
valid YAML: …", "name X != directory Y"), logged per file at boot, never fatal: one malformed
import must not take down retrieval for the forty skills next to it. A missing root is an empty
result — a daemon that has never learned anything has no skills directory, and that is normal.

The index (`skills` table, keyed by **path** — the same slug legitimately exists in `global/`,
as a project shadow, and again as a pending replacement draft) is a cache with exactly one
write: `replaceSkillsIndex` swaps the whole table in one transaction, so no reader ever sees a
half-rebuilt index. Rebuilt at boot (`reindexSkills` in `daemon.ts`) and — in the coming slices
— after every store mutation. It emits **no events**: derived state, not history.

Retrieval visibility is one shared pure function, `visibleSkills(all, projectSlug)`
(`shared/src/skills.ts`), which every retrieval path must go through. It pins the two
invariants the loop is safe by: **nothing pending is ever returned**, whatever the scope
arguments say, and a project task sees global ∪ project with **project shadowing global** on a
slug collision (the `CLAUDE.md` precedence rule). Stable-sorted by slug for digest
cacheability.

### The distiller (slice 2)

Every task that reaches `succeeded` is offered to the distiller
(`server/src/skills/distill.ts` — the job; `watch.ts` — the trigger), which may land a draft
in `pending/`. That destination is the whole safety argument: **nothing in `pending/` is ever
retrieved**, so the distiller needs no approval gate, no config ceremony, no event type of its
own — its output is inert until a human moves the file. It is on by default (`skills.distill`)
for exactly that reason, and off is one config line.

- **Trigger** (`shouldDistill`): the spec's "≥5 tool calls" measured in the signal the event
  log actually carries — `cost.recorded` events with a non-null `workerRunId`, i.e. worker LLM
  turns. Initiator turns (`workerRunId: null`) don't count; a task the initiator answered
  alone has no procedure worth writing down. Floor: `skills.minWorkerTurns`, default 6.
- **Condenser** (`condenseTaskLog`): the event log rendered one line per *meaningful* event —
  plan notes, worker spawn/finish with result summaries, approvals, steering, the outcome —
  bookkeeping (costs, deltas) dropped. Over a ~6K-token budget it elides the middle, keeping
  head and tail: openings state intent, endings state what worked.
- **The draft is LLM output, so it is zod-parsed defensively** (`parseSkillDraft`): JSON
  extracted from prose/fences, schema-gated, the `name` slugified with repair (a near-miss
  like "Compare Three Sources!" becomes a slug; garbage becomes a named `DistillError`). The
  model may return `{"skip": true, "reason"}` — "this task teaches nothing" is a first-class
  verdict, not a failure. `composeSkillMd` round-trips the result through the store's own
  parser before writing, so the scanner can never be handed a file the composer thought valid.
- **Who drafts** (`pickDistillModel`): `skills.distillModel`, or the cheapest enabled model
  with a *known* output price — the initiator heuristic inverted, because distillation is
  summarization and the expensive judgement already happened. Known-cheap beats
  unknown-priced. The spend is booked against the task it learned from.
- **The trigger never throws and never blocks** (`wireDistiller`): the bus swallows subscriber
  errors to protect the write path, so everything here catches and logs. Distillations queue
  on a promise chain rather than interleave — two drafts racing the same slug would defeat the
  exists-check — and a draft whose slug is already pending is skipped, never overwritten: the
  owner may be mid-review of the first one. After a draft lands, `reindexSkills` runs, so the
  pending skill is immediately visible to `/internal` and the dashboard without a new event
  type. Shutdown unsubscribes the distiller first; an in-flight draft still lands, and the
  next boot's reindex picks it up.

### Stage/approve: the gate itself

The gate ships **on** (phase-2 design, decision 4): a draft stays inert in `pending/` until a
human moves it, and the move *is* the approval — there is no status column to flip.
`approveSkill` (`server/src/skills/stage.ts`) re-reads the draft's frontmatter at approval
time (so "edit the file first, then approve" is a supported flow, not a race), refuses a
name/slug mismatch or an unparseable file *before* moving anything (the draft stays in
`pending/` where it can be fixed), resolves the target from frontmatter `project:` (absent =
`global/`), checks that project actually exists against the repos (a skill must not be
stranded in a directory no project answers to), and refuses to clobber an existing approved
copy unless `overwrite` is explicit — a 409, with both copies surviving the refusal.
`rejectSkill` deletes the pending directory and only the pending directory.

The routes (`/internal/skills` in `app.ts`) are thin over those two functions plus a
`reindexSkills` after every successful mutation, so the index never lags the tree: `GET`
lists the index (`?status=pending|approved`), `POST :slug/approve` (strict body, optional
`{overwrite: true}`) maps stage failures to HTTP — `not_found→404`, `invalid`/
`unknown_project`→422, `conflict→409` — and returns the freshly-indexed approved row;
`POST :slug/reject` answers `{rejected}`. Without a configured `skillsRoot` (tests that never
touch skills) the mutations answer 501, the orchestrator-absent pattern; the daemon passes
its `skillsDir`, the same tree the boot reindex and the distiller use.

Both review surfaces sit on those routes and never touch the tree directly — the daemon owns
the index, and a file moved behind its back is stale until next boot. `rewter skills`
(`cli/src/skills.ts`): `list` (pending marked `?`, `--pending`/`--approved` filters), `show`
(prints the SKILL.md path so the owner can open it), `approve [--overwrite]`, `reject` —
same daemon discovery and `x-api-key` auth as `rewter chat`. The dashboard `SkillsPanel`
fetches its count even while collapsed (a proposed skill is a question waiting on the owner,
and a queue nobody sees is a queue nobody answers), arms reject like project delete (it is a
deletion), and turns a 409 into an explicit "approve anyway (overwrite)" button rather than
retrying silently.

### Retrieval: the digest and `load_skill`

The closing slice — approved skills actually reach prompts, through exactly two doors.

**The digest** (`server/src/skills/digest.ts`) is the registry digest's contract on a
smaller budget: one deterministic line per visible skill (`<slug>[ (project)] — <description>`),
metered by the same `estimateTokens`, drop-from-end with an honest
`(N further skill(s) omitted for space.)` note. The default budget is 1000 tokens, a quarter
of the registry's — a library big enough to blow it is a library that needs curating, and the
note is the curation prompt. It renders in the **per-task** region of the initiator prompt
(after the project block), because visibility is project-dependent and putting it in the
cacheable region would invalidate every other project's prompt cache; within one project the
bytes are still deterministic, so per-project caching holds. An empty library renders nothing
at all — no "Skills: (none)" header spending tokens on a feature the model cannot use.

**`load_skill`** is one tool name on two surfaces (initiator, `ORCHESTRATOR_TOOLS_VERSION 4`;
tier-2 workers, `WORKER_TOOLS_VERSION 2`) with one implementation:
`loadSkillResult(all, projectSlug, slug)` in `server/src/skills/lookup.ts`. Both callers pass
through it so the visibility filter — and with it "a pending draft is never retrieved" —
cannot fork between them: retrieval is `visibleSkills` or nothing. The return value is always
a tool *result* string, never a throw: an unknown slug names the available ones (the
`parseToolArgs` rule — a bare "not found" buys a guess-and-retry loop over slugs the model
cannot see), an empty library says so, and a file that moved under the index becomes
"could not be read (…). Proceed without it." The body is read fresh from disk at call time,
so an owner edit lands without a reindex.

The tier-2 loop gets the lookup **injected** (`Tier2Options.loadSkill`) rather than imported:
only the engine knows the task's project, and a plain function keeps the loop testable
without a skills tree on disk. Absent means not configured, and the tool says so.
`load_skill` reads the library, not the workspace, so it never consults the approval gate —
stated in both tool descriptions, because a skill lookup parked on a human is a read the user
cannot see the point of. The core prompt (`ORCHESTRATOR_PROMPT_VERSION 4`) gains a `# Skills`
section: scan the list before planning, follow a matching skill's model/tier suggestions,
never load speculatively or invent a slug; when a skill mostly concerns a worker's part of
the job, name the slug in its instructions and let the worker load it itself. Handoff
successors rebuild their prompt through the same `buildMessages`, so they inherit the digest
for free. The frontmatter `uses` counter is deliberately not incremented yet — retrieval
writes nothing.

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

Explicit beats implicit: a `:pin` on the request, then the selected project's
`modelPrefs.initiatorPin` (P2-M1), then the configured default, then a heuristic — *the most
expensive enabled model not known to lack tools*. Price is a crude proxy
for capability, but it is the only one available before any card is read, and the initiator
is exactly where being wrong is most expensive. Ties break on id, so the choice is
deterministic across restarts. The task row records the **canonical** id, not the alias the
caller typed.

The filter is `supports.tools !== false`: a reported denial disqualifies, silence does not, or a
registry of local models — whose catalogs report nothing — could never orchestrate at all. But
evidence outranks price, so a model *reported* to do tools sorts ahead of an unvouched one before
price is consulted. An initiator that turns out not to call tools is not a cheaper orchestration,
it is a failed one. The error when nothing qualifies says *known not to support tools*, because
that is the only case it can now mean.

### System prompt (cache-friendly order)

1. **Static core** (`ORCHESTRATOR_CORE_PROMPT`, versioned) — role, tier ladder, tool rules,
   cost discipline ("cheapest sufficient tier/model"), self-assessment + handoff criteria,
   narration conventions. Gets a `cache_control` breakpoint on the Anthropic adapter.
2. **Registry digest** — one compact line per active model rendered from Model+Card+Stats,
   stable-sorted for cacheability, ≤ ~4K tokens. The learned `stats:[…]` fact renders
   inside this same renderer (see [Learned stats](#learned-stats-the-recorder-and-the-digest)).
   An empty registry says `registry is empty` rather than rendering nothing —
   silence would read as "no models exist".
3. **Task context** — the [project block](#the-prompt-block) when a project is selected
   (after the digest, so it never invalidates the shared cache region), then the client's
   incoming conversation, **passed through untouched**, including its own system message. A
   router that quietly rewrote the caller's system prompt would be a bug the caller could
   never see from the outside.

### Initiator tools

`plan_note`, `spawn_worker` (returns a label **immediately** — parallel fan-out is several
spawns in one turn onto a p-limit scheduler, default concurrency 4), `wait({labels?,
mode:"all"|"any"})`, `get_result`, `send_to_worker({label, message})`, `cancel_worker`,
`ask_user`, `handoff({to_model, reason, context_summary})`, `finish({summary})`.

`spawn_worker`'s `tier` accepts **1, 2 or 3**; a tier-3 spawn on a daemon with no harness
configured (or one the project's `allowedHarnesses` excludes) comes back as a tool *result*
pointing at tier 2, because a refusal the model can read and re-spawn from costs one turn
where a thrown error costs the task. The description the model sees says what each tier is
*for* — tier 1 for thinking, writing, summarizing; tier 2 when the subtask has to read or
change something; tier 3 an external coding agent that brings its own model — since the
initiator picks the cheapest sufficient tier and cannot do that from a bare number.
(See [Tier 3](#tier-3-external-harnesses-p2-m5).) `spawn_worker` also takes an optional
`tag` from the card vocabulary — the key the worker's outcome is recorded under (see
[Learned stats](#learned-stats-the-recorder-and-the-digest)); an untagged spawn is fine and
simply uncounted. `ORCHESTRATOR_PROMPT_VERSION` is 8 and `ORCHESTRATOR_TOOLS_VERSION` is 8 (the
tier description carries the steering caveat, below).

Now that tier 2 exists, `concurrency` (default 4) bounds **agent loops**, not just single
calls. The same number that used to cap four simultaneous one-shot completions now caps four
simultaneous multi-minute loops, each with its own shell and file access — a materially
larger thing to have four of, and the reason the default did not go up with the new tier.

`wait` returns **summaries**, not full text: the initiator pulls the body with `get_result`
only for the workers whose detail it actually needs. In `"any"` mode a worker that finished
*before* the call already satisfies it — racing only the still-running subset would block on
a second result nobody asked for.

### Steering a running worker

`send_to_worker({label, message})` hands a **running tier-2** worker a correction it reads at
its next turn boundary. The message does not interrupt work in flight — the tool returns at
once, and the worker sees it when its current turn completes — so the initiator sends and then
`wait`s as usual rather than expecting an acknowledgement.

The queue lives in the **engine**, not the runner: `spawn` is allowed to sit behind the
concurrency limiter, so a message aimed at a worker that has not started yet has to survive
until its first turn, and the runner does not exist yet to hold it. `Session.spawn` closes over
an `inbox: string[]`, shares the same array with the `Worker` record, and passes the runner a
puller — `inbox: () => inbox.splice(0)` on `WorkerContext`. Draining is destructive: a message
read twice is a worker nagged twice, and the nag grows the transcript it is billed for on every
pass. The runner asks on **every** turn, not once at the top, or a message sent mid-run would
never land.

The tier-2 loop injects at a turn boundary and nowhere else, prefixed
`[FROM THE ORCHESTRATOR] `. Mid-turn injection would leave the model an unanswered tool call,
which several providers reject outright. That prefix is one exported constant
(`ORCHESTRATOR_MESSAGE_PREFIX`) used by both the loop that stamps it and the tier-2 system
prompt that explains it — a worker meeting the marker without the explanation would read a user
turn its own prompt insists cannot exist.

Three cases come back as tool *results* rather than throws, in this order: an unknown label
(with the labels that do exist), a worker that has **already finished** (pointing at
`get_result`), and a **tier-1** target. The last is structural, not an omission — a tier-1
worker is one model call with no point at which it could read anything — so the refusal names
tier 2 as what to use when steering is expected. The delivery itself prints `⇄ [w2] told: …`
to the user's feed: a worker changing course mid-run is only explicable if the instruction that
caused it is visible in the same place.

The latter two refusals are also **recorded**, as `worker.message_refused`
`{taskId, workItemId, reason: "tier_1" | "finished", message}` (#7). Each one is a planning
miss — the initiator chose tier 1 and then found it needed to steer, or steered after the
result was already in — and the question #7 leaves open (should a tier-1 worker be
transparently promoted to tier 2 on the first `send_to_worker`?) can only be answered by
knowing how often it happens. The unknown-label case is *not* recorded: a typo is not a
planning miss, and counting it would muddy the number. The fold accumulates these on
`FoldedTask.refusedMessages` with the worker's `w<n>` label when the work item is known
(`null` otherwise — a refusal naming an unseen work item still counts on the task rather than
becoming an orphan, since the count is the point). The dashboard task card lists them under
"refused messages" so a user watching `w1` carry on regardless of an announced change of plan
can see why; the event table renders the reason then the message; and the skills distiller
carries the line into the condensed transcript, so the tier lesson is available to be learned.
Alongside the instrumentation, `spawn_worker.tier` (tools v8) names the tradeoff *where the
tier is chosen*, not only where it bites: tier 1 "cannot be messaged once started: if you might
need to steer this worker mid-run, choose tier 2 now". Promotion stays unimplemented until the
event log shows the pattern is worth it.

### Tier-1 workers

One chat call, ending with a `SUMMARY:` line that the initiator reads back. `splitSummary`
scans from the **end** of the text, because a worker summarizing a document that itself
contains "SUMMARY:" would otherwise hand back a line of its own input. Bold labels
(`**SUMMARY:**` and `**SUMMARY**:`, both seen in the wild) are tolerated. No summary line
falls back to the head of the body; an empty reply still yields something readable, since the
initiator has to be able to read it.

Every exit path — pre-aborted, thrown, error-finish, truncated, success, mid-flight abort —
writes the run lifecycle. `WORKER_RUN_TRANSITIONS` has no `created → succeeded` edge, so a
path that forgets `streaming` throws at the repo write and takes the whole task down. A throw
*during* an abort counts as cancelled, not failed: the two mean different things to the user,
and the signal is the only thing that can tell them apart.

**Truncation is a failure, not a short success.** `finishReason: "length"` means the ceiling
cut the model off — and a reasoning model cut off mid-thought has spent its whole budget
before writing a single visible character, so the text can be empty while the call cost full
price. Reported as succeeded, that reaches the initiator as a worker that inexplicably
returned nothing, and its only move is to guess. Observed live on a three-way fan-out: all
three workers hit exactly 4,000 output tokens, all three were reported succeeded-and-empty,
and the initiator wrote *"Workers returned empty; retrying the three blurb requests on the
same free tier-1 model"* and re-spawned all three unchanged — paying twice for the same
result, because nothing in the outcome said *why* they were empty. The error now names the
ceiling actually in force (`ctx.maxTokens ?? 4_000`, not the constant) and whether any visible
text arrived, since "ask for less" is not actionable without knowing less than what. Partial
text is kept in both the outcome and `resultText`: half an answer beats none, and the
initiator can read it with `get_result`. The same rule holds inside a tier-2 turn — see
[the agent loop](#the-agent-loop-as-built-m6d).

### Progress-as-text

```
◆ plan: split into 3 subtasks          (dashboard: http://localhost:PORT/t/task_x)
▶ [w1 · gemini-flash · tier1] summarize repo docs — started
▶ [w2 · claude-sonnet-5 · tier2] patch the failing test — started
· [w2] read src/foo.ts, found the off-by-one
⏸ [w2] approval needed — pnpm test
   (reply "a w2" / "d w2 reason", or "approve apr_x" / "deny apr_x", or answer in the dashboard)
✔ [w1] done ($0.002, 3.1s)     ✖ [w3] failed: 429 rate limited     ⊘ [w4] cancelled
── final answer from finish() ──
```

Lines produced while awaiting a worker are queued and flushed at the next yield point, so a
generator that is parked inside `Promise.race` still gets its narration out in order.

**The answer's framing is a contract, not a courtesy.** On success the engine flushes every
pending narration line, yields one separator delta (`ANSWER_SEPARATOR` is the empty line, so
the delta is a bare `"\n"`), then yields the whole answer as a **single `text_delta` with no
trailing newline**, then `message_end` — no text ever follows the answer. Failure and
cancellation instead end with a newline-terminated `✖ task failed: …` / `⊘ task cancelled …`
line. `rewter chat` relies on this to recover the answer verbatim (last delta of a succeeded
stream) when building the assistant turn for a [follow-up](#rewter-chat-the-terminal-client-p2-m3); change
the framing and that client's conversation history silently fills with progress lines.

Two of those lines come from *inside* a tier-2 worker rather than from the initiator. A
worker's `report_progress` note is labelled with its own `w<n>` (`workerNoteLine`), because
four loops running for minutes make an unlabelled "wrote the fixture" meaningless. An approval
prints the **full approval id**, not the label: the REST route and the in-band reply both
address it by id, and someone about to authorize a shell command should be reading the same
identifier the audit row carries.

**The feed is not the record.** Both of those lines are also appended to the event log —
`worker_run.progress` for a worker's note, `steering.received` for an instruction arriving
in-band. The SSE stream dies with the connection, and a worker's notes are wanted precisely
when it is gone: after a reconnect, after the restart that interrupted the task, or in the
dashboard beside a task nobody was watching live. The fold and the dashboard already rendered
both event types; for a while nothing emitted them
([#1](https://github.com/roowus/rewter/issues/1),
[#2](https://github.com/roowus/rewter/issues/2)). The feed line clamps for display; the logged
event keeps the whole text.

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
means a cap that only ever arrives per-request is a cap that never arrives. A cap that can only
be set *before* the task is nearly as bad — see [Moving the cap](#moving-the-cap-m7g). The config file's
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

### Steering by id: the second door (P2-M3)

The re-POST protocol is right for an OpenAI client, which has nothing *but* the
conversation — and wrong for a client that holds the task id, because it drags the whole
transcript over the wire to say one sentence, and a fingerprint match is an inference where
an id is a fact. `POST /internal/tasks/:id/steer` `{message}` is the direct door, built for
the `rewt` TUI's always-live input line. The message goes through the **same
`parseSteering`** as the re-POST path — one grammar, two doors — so `approve apr_…` or the
keystroke `a w1` / `d w1 reason` typed into the TUI resolves the approval through the gate
(`resolvedBy: "in_band"`) instead of being read aloud to the initiator, and only the
non-command remainder is queued.

The response is a **202**, `{taskId, queued, remainder, approvals}`, and 202 is the honest
code: it reports what the *parser* did, not what the task did. The steering text is in the
task's queue; the engine injects it at the next turn boundary and appends
`steering.received` to the event log at that moment, so "did it reach the initiator" is
answered by the log. The route also calls `cancelGrace` — a user steering a task has just
claimed it, and a disconnect-grace timer counting down to cancel it is now wrong.

Unlike `settings`, there is **no row-only fallback**: a task whose row says `running` but
has no live session (a restart orphan) is a 409, same as a finished one — a message queued
for a session that does not exist is a message to nobody, and answering 202 would be a lie.
The two 409s carry distinct messages ("task is already succeeded" vs "no live session…") so
the TUI can tell the user which happened. Tasks started from the dashboard via
`/internal/run` register with the same `LiveTaskIndex`, so they are steerable through this
door too. Pinned in `app.steer.test.ts`, over a real socket for the same reason as above.

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

### `rewter chat`: the terminal client (P2-M3)

The steer route above is the server half of mid-run prompting; `rewter chat` is the client
half, and the one behaviour it exists for: **the input line is never modally bound to the
running turn**. The task's feed renders above the prompt while the prompt stays live;
anything typed mid-run POSTs to the steer endpoint immediately, where the one steering
grammar decides whether it was an approval command or an instruction for the initiator.
Other CLIs make you wait for the turn to end; the whole point of the daemon owning the loop
is that this one doesn't.

It lives in `packages/cli/src/chat/` as six small modules, and everything about the split
follows from the decision to be a **thin client of surfaces the dashboard already uses** —
chat over `POST /v1/chat/completions`, steering over `/internal/tasks/:id/steer`, approvals
over `/internal/approvals/:id`, kill over `/internal/tasks/:id/cancel`, the live task tree
over `WS /internal/ws` folded by the same `@rewter/shared` fold the dashboard uses, project
lookup over `GET /internal/projects`. No new server surface: the daemon narrates the feed
(glyph lines, approval cards, the final answer) and the command renders text it receives;
the tree is the one thing it *reconstructs*, and it reconstructs it with the fold that was
already tested once for the dashboard rather than a second interpretation of the events.

- **`sse.ts`** — incremental SSE decoding, byte-boundary honest. Network reads do not
  respect frame boundaries, so one parser per stream owns the split-block buffer: feed it
  whatever arrived, get back only complete `data:` payloads. It returns raw strings rather
  than parsed JSON because one of them is the literal `[DONE]` sentinel, which is not JSON
  and not this layer's call. `: ping` heartbeats fall through untouched.
- **`stream.ts`** — one POST is the whole start protocol. The task id arrives in the
  `x-rewter-task-id` response header, **available before the first body byte** — which is
  what lets the prompt go live (and steer) while the model is still thinking. The generator
  yields typed events (`text`/`usage`/`error`/`done`) because the two non-obvious cases live
  at this layer and nowhere else should know about them: the `[DONE]` sentinel, and the
  daemon's error-on-the-final-frame convention. A socket that closes *without* `[DONE]` is
  reported as a connection loss, distinct from a clean end.
- **`client.ts`** — discovery and the `/internal` verbs. Discovery reuses the pidfile
  through the same `daemonStatus` probe as `rewter stop` ("a pidfile is a claim, not a
  fact"); `REWTER_URL` (or `--url`) overrides it for the tailnet case, where the daemon is
  on another machine and no local pidfile speaks for it. Both the `/v1` and `/internal`
  guards accept `x-api-key`, so that is the one header convention used:
  `REWTER_INTERNAL_KEY ?? REWTER_API_KEY`, sent when set, harmless when unchecked.
- **`chat.ts`** — the command. A session is a sequence of tasks over one growing
  conversation (see *Follow-up turns* below). While a task runs, typed lines are steering:
  serialised through a promise chain so two quick lines cannot land out of order, with an
  echo that distinguishes what the parser did — `· queued for the initiator: …` vs `· N
  approval command(s) applied` — because those look identical at the keyboard and are very
  different facts. Ctrl-C is an honest kill: it cancels the task on the daemon (settling it,
  stopping the spend), not just the local socket, and exits 130.
- **`watch.ts`** — one WebSocket subscription per task. On open it sends
  `{type:"subscribe", taskId}` (the socket's own filter — no client-side discarding of other
  tasks' events) and folds every `event` frame through `applyEvent` from `@rewter/shared`,
  so `watcher.task` is a `FoldedTask` — the same object the dashboard's tree is a view of.
  `settled(ms)` resolves when the folded task reaches a terminal status, when the socket
  closes, or on the deadline, whichever is first. The socket is Node's global `WebSocket`
  (undici) handed the connection's headers, so `x-api-key` rides the upgrade exactly as the
  dashboard's does; the factory is injectable, and a factory that throws degrades to a stub
  whose `failure` says why (`socket unavailable: …`) — the turn still runs, the tree is
  merely absent.
- **`tree.ts`** — pure renderers over a `FoldedTask`: `renderTree` (header with
  done/total/running counts, spend with the planning share, elapsed; one row per worker
  with glyph · title · label · model · tier · status · attempts · spend · elapsed; a row per
  pending approval; a closing rule) and `costFooter` (the one-line summary). Elapsed uses
  `finishedAt` once a task or worker is over, so a finished tree renders the same at any
  `now`. Both are tested against the same fixture shapes as `shared/fold.test.ts`
  (`fold-fixtures.ts`), so a task the CLI can draw is a task the fold has been proven on.

**Live tree and cost footer.** While an orchestrator turn runs on a TTY, the folded tree is
redrawn as a block between the feed and the prompt on every socket event: printed once,
then cleared (cursor up + erase-to-end) and reprinted, so the feed above it stays a
scrollback of what happened and the tree is always the current state. Piped output gets no
tree at all — a tree that cannot be redrawn is a log spammer — and the footer is the
non-TTY reader's whole summary. When the stream ends, the command waits up to
`SETTLE_MS` (1.5 s) for the socket to agree the task is terminal (the engine's terminal
transition precedes its final text delta, so normally the socket is already there), closes
the socket, clears the tree, and prints **one feed line** after the answer:
`· $0.02 spent (planning $0.02) · 2 worker(s) · 18s`. The footer is a feed line, never part
of the answer — the follow-up turn's assistant message is still the last text delta alone.
If the socket could not be opened the same slot says `· no live tree — <reason>` once, and
the exit code is unaffected. A pass-through model has no task id, so no socket is opened
and no footer is printed.

**Project auto-select.** Without `--project`/`-p`, `rewter chat` lists the daemon's
projects once and picks the non-archived one whose `dir`/`repo` resource contains the cwd
(deepest match wins when projects nest; a sibling that merely shares a prefix is not a
match; `doc`/`url` resources never match). It announces the choice — `· project clarity
(from cwd; -p <slug> or --no-project to override)` — because a silent header would be a
silent policy change, and then sends `x-rewter-project` on every turn exactly as an
explicit `-p` does. `--no-project` skips the lookup; an explicit `-p` skips it too. A daemon
too old to serve `/internal/projects`, or one that refuses, simply yields no project — the
lookup is a convenience, never a precondition for the turn.

**Follow-up turns.** When a turn finishes with exit 0 the prompt returns, and the next
non-blank line is a *follow-up*, not steering: it starts a **new task** whose `messages`
carry the whole conversation so far — `[user, assistant, user, assistant, …, user]`. The
daemon has no session state to hold for this: `LiveTaskIndex` forgets finished tasks, so the
re-POST matches nothing and starts fresh (new `x-rewter-task-id`), and `buildInitiatorMessages`
hands the prior turns to the initiator verbatim as ordinary conversation history. The
assistant turn the client appends is **the answer alone, not the progress feed**, and it is
recoverable without any markup because of an engine invariant that is now load-bearing:
on success the engine emits `chunk(ANSWER_SEPARATOR)` (a bare `"\n"` delta), then the final
answer as **one `text_delta` with no trailing newline**, then `message_end` — nothing
textual follows it (`engine.ts`, the `finish` path). So for an orchestrator run (task id
header present) the answer is the last text delta; for a pass-through model (no header, no
feed) the answer is the whole text. A turn that fails or is cancelled adds no assistant
message and ends the session with its exit code, so `rewter chat "…" < /dev/null` keeps its
one-shot semantics: EOF on stdin ends the session with 0 once the running turn completes,
and no follow-up prompt is printed to a pipe that has already hung up. Blank lines at the
follow-up prompt re-prompt, as at a shell.

Lines arrive through one `LineSource` for the whole session rather than per-turn
`once("line")` reads: readline emits a chunk's lines synchronously (a paste, a pipe), so a
modal read between two of them would lose the second. While no task runs, `next()` drains a
queue; while one does, `attach()` routes lines straight to the steering handler — queued
lines first, so a follow-up pasted as two lines means the second one for the task it starts.

Rendering discipline: deltas are buffered and flushed per *line*, so redrawing the prompt
under the feed is a clear-line + reprint (`readline.prompt(true)` preserves the typed
buffer), not a cursor ballet. Escape codes only ever go to a TTY — piped output gets the
plain feed, which also keeps the tests honest: the whole command is tested through injected
`io` streams, an injected `fetch` playing the daemon, and an injected socket factory playing
`/internal/ws` — no TTY and no network (`chat.test.ts`, with the module seams pinned in
`sse.test.ts`, `client.test.ts`, `stream.test.ts`, `watch.test.ts`, `tree.test.ts`).

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
  results merge into a single user turn. A system message *after* the first user turn has
  nowhere else to go — the API has one `system` slot and it is positionally first — so it rides
  in as a user turn prefixed **`[SYSTEM] `**. Tagged rather than demoted silently: "respond only
  in JSON from here on" is an instruction *about* the conversation, and delivered bare it reads
  as the user asking for something, which is weaker and can be argued with
  ([#5](https://github.com/roowus/rewter/issues/5)). It matches how `[USER STEERING]` marks the
  other message this router splices into a transcript.
- **openai-compat** — one class parameterized by `{baseUrl, apiKey, quirks}`; covers all but
  two of the presets, and every upstream added since.
- **google** — `@google/genai`. Roles are `user`/`model`, messages are `contents`/`parts`,
  and there is no system role (leading system messages join into `systemInstruction`).

**Quirks, not subclasses.** Upstream deviations are data on the preset, not new code:

| Quirk | Meaning |
|---|---|
| `usageOptional` | upstream may omit the usage block entirely (local runtimes do); absent usage is zeros rather than an error |
| `maxCompletionTokens` | send `max_completion_tokens` instead of the legacy `max_tokens` |
| `noStreamOptions` | omit `stream_options: {include_usage: true}` — some servers 400 on it |

**The two usage quirks must not be paired.** `usageOptional` is a safety net for an
upstream that does not answer; `noStreamOptions` is a reason to stop asking. Setting both —
as the Ollama preset once did — means rewter never requests streaming usage, and then
accepts the resulting zeros without complaint. Every local call recorded 0 tokens and looked
like a legitimately free request, which is the one failure `usageOptional` is designed not to
notice ([#14](https://github.com/roowus/rewter/issues/14)). Local runtimes keep
`usageOptional` for older builds that ignore the request, and a preset test asserts none of
them carries `noStreamOptions`.

**Gemini's finish reason is a lie.** Gemini reports `STOP` even when the turn is entirely
function calls — its wire has no `tool_calls` value. The adapter therefore lets a *seen*
function call outrank a plain `STOP` and normalizes to `finishReason: "tool_calls"`, so the
orchestrator knows it must run tools. Gemini also sends no call ids; the adapter synthesizes
stable `gemini_call_<n>` ids.

Retry/fallback lives in the **router layer**, never in adapters — every SDK client is
constructed with `maxRetries: 0`.

### Provider presets

`presets.ts` is a **data table**: adding an upstream is a row (slug, kind, baseUrl, env var
*name*, quirks), not a new class. 75 entries today, spanning five categories:

| Category | Presets |
|---|---|
| First-party SDK (3) | anthropic, google, openai |
| Aggregators (34) | openrouter, together, fireworks, groq, deepinfra, hyperbolic, nebius, novita, sambanova, cerebras, perplexity, siliconflow, nvidia, huggingface, vercel, requesty, llmgateway, nanogpt, zenmux, chutes, modelscope, ollamacloud, nscale, featherless, friendliai, inferencenet, scaleway, digitalocean, heroku, wandb, venice, byteplus, qianfan, githubmodels |
| Direct vendors (33) | xai, zai, moonshot, deepseek, mistral, cohere, qwen, minimax, baseten, ai21, reka, writer, upstage, liquid, inception, nousresearch, morph, metallama, codestral, longcat, stepfun, baichuan, hunyuan, volcengine, sealion, typhoon, sarvam, publicai, mixlayer, clovastudio, iflytek, poolside, opper |
| Local aggregators (1) | 9router |
| Local runtimes (4) | ollama, lmstudio, llamacpp, vllm |

The slug is a model-id namespace (`<slug>/<model>`), so it is constrained to `[a-z0-9-]+`.
`apiKeyEnv` holds an env var **name** only — a test asserts it matches SCREAMING_SNAKE,
which a real key never would, and a second asserts no two presets name the *same* variable,
since sharing one would mean configuring the second upstream silently reconfigured the first.
Local runtimes are the only presets allowed a null key.

**Where the breadth came from.** Rows 29–75 were sourced from
[OmniRoute](https://github.com/diegosouzapw/OmniRoute)'s provider registry (MIT, © 2026
diegosouzapw), whose `open-sse/config/providers/registry/` holds ~250 upstreams. Its entries
do not transfer verbatim, for two reasons:

- **Their `baseUrl` is the chat path; ours is the API root.** OmniRoute's executor POSTs to
  `baseUrl` literally, so it stores `https://api.cerebras.ai/v1/chat/completions`. rewter
  hands `baseUrl` to the OpenAI SDK, which appends its own path. A row copied across
  unconverted would POST to `/chat/completions/chat/completions` and 404 on the first real
  request — invisible to unit tests and to every recorded fixture, since it is the live URL
  that is wrong and not the code. `presets.test.ts` asserts no `baseUrl` contains
  `/chat/completions`, which turns that into a test failure rather than a support ticket.
- **They key auth per entry; we name an env var.** Nothing carrying a credential crossed
  over — each row here names a variable rewter reads at request time.

Of OmniRoute's ~250 entries, 150 are OpenAI-format with plain bearer auth; the rest are
OAuth flows, browser-session shims (`grok-web`, `t3-web`, `huggingchat`) and IDE-token
relays (`cursor`, `kiro`, `codex`) that need auth machinery rewter does not have. Of those
150 only the upstreams that are a company's own documented API are here: the
anonymous-key resellers and free-tier proxies were left out, because a preset is a
recommendation and rewter should not be pointing at someone's key-sharing endpoint.

**Every row was probed live before landing**, which is the only way to learn two things a
copied table cannot tell you. Four hosts (`lambda.ai`, `predibase`, `galadriel`,
`monsterapi`) did not answer at all and are absent. And `listModels` records whether
`GET <baseUrl>/models` actually exists rather than whether it was hoped to: an unauthenticated
401 proves the route is there and gated, but Heroku 404s, AI21 answers **410 Gone**, and
Codestral serves one model family with no catalog route — all three carry `listModels: false`.
A wrong `listModels` is not cosmetic: sync would report those providers as broken rather than
as catalog-less.

**A local aggregator is both, and no other preset is.** 9router runs on the operator's
machine and authenticates nothing — a bearer header would be rejected as unexpected rather
than ignored, so `apiKeyEnv` is null like any local runtime — but the models it lists are
Anthropic's, Google's, OpenAI's and Z.AI's. It holds *their* credentials, which is precisely
why rewter needs none: one preset row yields a hundred-plus models. It carries
`usageOptional` for the same reason the local runtimes do, though for 9router this really is
a safety net rather than an expectation — a live instance was checked and it *does* report
usage. The quirk exists so that a future build which quietly stops answering degrades to an
unknown cost instead of a recorded zero ([#14](https://github.com/roowus/rewter/issues/14)).

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

### Failure recording (issue #9)

Issue #9 asked whether resumable streams are worth building, and the honest answer was "we
do not know how often streams fail mid-way". The router is the only component that sees
every attempt — including the retried ones whose caller never learns a failure happened — so
it is where the data is gathered. Every failed attempt appends a **`FailureRecord`** to the
`failure_records` table (migration `0004`), never an event: a retried 503 must not appear in
a task's tree as if it had reached the user, and the fold has no business knowing about it.

What one row carries, and why:

- **`phase`** — `before_output` or `mid_stream`. The split is the whole point. A failure
  before any output is one the retry loop already absorbs; its rate says what the retry is
  earning. A failure after the first chunk cannot be retried without duplicating rendered
  text, so it always reaches the client; *its* rate is the number that decides #9.
- **`attempt`** and **`retried`** — 1-based attempt within one `Router.stream()`, and
  whether the router went on to try again. Three rows `[1, retried] [2, retried] [3, not]`
  is one exhausted request; a single `[1, not retried]` before output is a non-retryable
  error surfaced immediately.
- **`retryable`** and **`statusCode`** — the adapter's own verdict, and the upstream's
  status. A thrown adapter is recorded as `retryable: false` with a null status.
- **`modelId`**, **`providerId`**, nullable **`taskId`** / **`workerRunId`** — a
  pass-through call is attributed to nothing but the model, exactly like a cost record.
- **`message`** — the upstream's text clipped to 500 characters. Never a request body,
  never a key.

Two deliberate omissions. **Aborts are not failures**: a request cancelled by its caller is
recorded nowhere, because "the user hit ctrl-c" says nothing about the upstream. And the
recording itself is wrapped so that a full disk or a locked table cannot turn a completed
answer into an error — instrumentation never gets to be the failure.

Successes come from `cost_records`, which already exist one-per-completed-request, so the
two tables together give a rate rather than a bare count. `summarizeFailures()` in
`@rewter/shared` (the sibling of `summarizeCosts()`) folds both into a `FailureSummary`:
totals and a per-model bucket of `{failures, beforeOutput, midStream, retried, successes,
byStatus, lastMessage, lastAt}`, sorted by failures then mid-stream. The mid-stream rate is
`midStream / (successes + failures)` and is **`null` when nothing was called** — no calls is
no rate, not a zero one. `GET /internal/failures?since=&until=` serves it; the dashboard's
`FailuresPanel` renders it beside the costs panel with the same range tabs, refetching on
socket movement for the same reason the costs panel does.

Failure records are **never collected by `gc`**, for the reason cost records are not: they
are evidence about a model's reliability, not about a task, and the question they answer
outlives any one transcript. The `model_stats` recorder is the natural consumer of this
table once there is enough of it — per-model backoff in the engine's handoff cap (the other
half of #9) is the first thing it would inform.

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

Two doors, two optional keys, one check. `/v1` takes `apiKey` (env var named by
`apiKeyEnv`, default `REWTER_API_KEY`); `/internal` takes `internalKey` (env var named by
`internalKeyEnv`, default `REWTER_INTERNAL_KEY`). Either absent means that door is open —
which is the normal loopback-daemon case, and is phase 1 unchanged. The keys are not
interchangeable: an ops credential must not stand in for the API key on the model-serving
surface, or vice versa.

**Two header conventions, one token.** OpenAI clients send `Authorization: Bearer …`;
Anthropic clients (Claude Code among them) send `x-api-key` and never set `Authorization`
at all. Both are accepted against the same configured key, so one value works for both
surfaces instead of forcing the user to configure two. The rejection is shaped to match the
surface being called: Anthropic's error envelope on `/v1/messages`, OpenAI's elsewhere;
`/internal` rejects with a plain `{error: {message}}`.

**`/internal` accepts a third credential: a cookie** (`rewter_internal_key`, the constant
`INTERNAL_KEY_COOKIE` in `shared`). It exists for exactly one caller — the dashboard
bundle, whose `new WebSocket()` cannot carry a header but whose browser sends cookies on
the upgrade for free, and on every same-origin fetch, which is why none of the dashboard's
client modules know the feature exists. The bundle's `main.tsx` sets the cookie from a
one-time `?key=` bootstrap in the URL and immediately scrubs the parameter via
`history.replaceState`, so the secret never sits in the address bar or browser history.
The daemon never sets the cookie itself.

**The guard covers the WS upgrade.** The hook is registered at the Fastify root, and root
`onRequest` hooks run for routes in child scopes — including `/internal/ws`, on the upgrade
request, before any socket exists. A refused upgrade is an HTTP 401, not a socket that
opens and then closes (which would let a subscribe frame through first). Pinned by a
raw-`node:http` upgrade test, since browser `WebSocket` can't show the contrast.

**`GET /internal/health` stays open even with a key configured.** It is the liveness probe
`rewter status`/`stop` and the pidfile contract depend on, it performs nothing, and a
`stop` that cannot tell "down" from "locked out" would hang on both.

**Non-loopback binds fail closed.** `startDaemon` refuses to boot when `config.host` is not
loopback (`isLoopbackHost`: `localhost`, `::1`, `127.*` — unrecognized strings are
non-loopback *by construction*) and the internal key env var is unset. `/internal` is
approve/deny/kill/shutdown/registry-writes; binding it open to a network is a remote kill
switch, and a warning log would be the kind that is only read after the incident. The
`ConfigError` names the env var, because setting it is the whole fix. See
[Sharing the daemon over Tailscale](#sharing-the-daemon-over-tailscale) for the two
supported remote-access modes.

### Sharing the daemon over Tailscale

Two modes, and the first needs no rewter configuration at all:

1. **`tailscale serve` (recommended).** The daemon stays loopback-bound; Tailscale
   terminates TLS and proxies to `127.0.0.1`. Identity and transport security are
   Tailscale's, the bind never leaves the machine, and no key is needed:

   ```sh
   tailscale serve --bg https / http://127.0.0.1:20130
   ```

   The dashboard, `/v1`, and `/internal` are then reachable at
   `https://<machine>.<tailnet>.ts.net/` from any tailnet device, same-origin, no
   further setup.

2. **Direct bind, fail-closed.** Set `host` to the tailnet IP (or `0.0.0.0`) in
   `~/.rewter/config.json`, and set `REWTER_INTERNAL_KEY` in `~/.rewter/env` — without it
   the daemon refuses to boot, by design. Ops clients send the key as a bearer or
   `x-api-key` header; the dashboard is bootstrapped once by visiting
   `http://<host>:<port>/?key=<the key>`, which moves the key into a session cookie and
   scrubs the URL. `/v1` should get `REWTER_API_KEY` too on a shared bind — otherwise the
   models surface is open to the same network the bind exposed.

## Configuration and boot

### The config file

`~/.rewter/config.json` (override with `REWTER_CONFIG`, or `rewter start --config <path>`).
Everything has a default, so the file is optional and an empty `{}` is valid.

**Comments are allowed** — `//` and `/* … */`. This is the one file rewter tells people to
open in an editor, and `// this one is my cheap provider` is exactly what gets written in
it; JSON has nowhere to put that, so the loader strips comments before parsing rather than
failing on the first line of the quickstart (which is what it used to do — see
[#13](https://github.com/roowus/rewter/issues/13), found by running the README walkthrough
verbatim). The strip is string-aware, because every `baseUrl` contains a `//` and eating it
would truncate the value into a parse error pointing at the wrong place; comment bodies are
blanked rather than deleted so byte offsets, and therefore the excerpt `JSON.parse` quotes
back in its error, still match the file on disk.

**A leading `~` expands against the passed `HOME`, never the process's.** The config path,
`dbPath` and `workspacesDir` are all resolved against one home, computed once in
`openRegistry` and returned on its result so `startDaemon` cannot pick a different one.
Defaulting to `homedir()` at each call site — which is what the code did until
[#15](https://github.com/roowus/rewter/issues/15) — means that under launchd, under
`sudo -u`, or in a test handed a scratch `HOME`, the daemon reads one operator's providers
while opening another's database. It failed silently for exactly as long as no real
`~/.rewter/config.json` existed on the machine.

```jsonc
{
  "port": 20130,                    // not 20128 — that is 9router's, so both can run at once
  "host": "127.0.0.1",
  "dbPath": "~/.rewter/rewter.db",  // a leading ~ is expanded; ":memory:" works for throwaway runs
  "workspacesDir": "~/.rewter/workspaces",  // one dir per task; NOT under dbPath, on purpose
  "skillsDir": "~/.rewter/skills",  // the SKILL.md tree (P2-M4); files are truth, DB indexes
  "skills": {
    "distill": true,                // draft a pending skill after each qualifying success
    "distillModel": null,           // null = cheapest enabled model with a known price
    "minWorkerTurns": 6             // worker LLM turns a task must burn to be worth learning from
  },
  "apiKeyEnv": "REWTER_API_KEY",    // env var NAME holding the bearer token /v1 requires
  "search": {                       // tier-2 `web_search`; omit the block and the tool is never declared
    "provider": "searxng",          // "searxng" | "brave" | "tavily" | null
    "baseUrl": "http://localhost:8888", // searxng instance (brave/tavily: optional override)
    "apiKeyEnv": null,              // brave/tavily key VARIABLE NAME; defaults BRAVE_SEARCH_API_KEY / TAVILY_API_KEY
    "maxResults": 8                 // per call, max 20
  },
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
variable, for provider keys, for rewter's own bearer token and for the search backend's key
— the file is safe to paste into an issue. The `search` block is the one schema that is
`strict`, so a pasted `"apiKey": "BSA-…"` is refused at load rather than silently ignored and
left sitting in a shared file.

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
startDaemon(opts) → { app, db, repos, bus, router, config, url, reconciled, stop() }
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

### Boot reconciliation (M8)

A daemon that is killed — `kill -9`, a reboot, an OOM — leaves rows in the database saying
`running`, because the code that would have written a terminal status died with the process.
Nothing in the new process is going to finish them. So `reconcileOnBoot(repos)` runs in
`startDaemon` **before `listen`**, walks the non-terminal rows and marks them `interrupted`.
Doing it before the socket opens means no request — and no dashboard connection — ever
observes a task that claims to be running with nothing behind it.

**Why `interrupted` and not `failed`.** A failure is a judgement: something tried and did not
work. Nothing judged these. `failed` would tell an operator scanning history that the model got
it wrong, when the machine simply went away — and it would poison the learned stats, which
key off exactly that success/failure distinction. The separate state costs one enum member
and keeps the record honest; the stats recorder ignores `interrupted` outright (see
[Learned stats](#learned-stats-the-recorder-and-the-digest)).

**Why not resume.** A task's liveness lives entirely in memory: its `AbortController`, the
promises parked on pending approvals, the open upstream sockets. None of that survives. A
tier-2 worker killed mid-`shell` has an unknown amount of its command already applied to the
filesystem, so replaying the event log would re-run side effects that already happened.
Marking interrupted keeps the whole history — every event is still there for the fold — and
lets the user decide whether to ask again. The one exception is a tier-3 harness
*session*: its conversation lives on the harness's own disk, not in daemon memory, so an
interrupted run with a `harnessSessionId` is offered to the next orchestration as
resumable — see [restart re-adoption](#restart-re-adoption-p2-m5-slice-3). The run still
closes `interrupted`; only the conversation survives.

Three properties the implementation is built around:

- **Deepest-first** (runs → work items → tasks), so a parent is never closed while a child of
  it is still open; anything reading the tree mid-sweep sees a consistent shape.
- **Through the ordinary lifecycle-guarded repo methods**, so each write emits its
  `status_changed` event and the dashboard's fold shows the interruption rather than a task
  that simply stops updating. Interruption is part of the replayable history.
- **Idempotent by construction** — it only touches non-terminal rows, and `interrupted` *is*
  terminal. That matters because it runs on *every* boot, including the ones right after a
  clean stop, where it must find nothing rather than throw on a terminal row.

Pending approvals on a closed task are resolved `expired`. The promise that was waiting on
them is gone; left pending they would sit in the dashboard's approvals list forever, inviting
a click that resolves a row nobody is listening to.

Terminality is read off the lifecycle maps via `isTerminal(MAP, status)`, never re-listed —
in `reconcile.ts`, in the repos' `finishedAt` stamping, in the fold, and in the dashboard. A
hand-kept copy is one enum member away from disagreeing with `shared`.

The boot log gets one line (`interrupted by a previous shutdown: 1 task(s), 2 work item(s),
1 run(s)`) and says nothing at all in the ordinary case — not "0 tasks".

### CLI

`rewter start [--config <path>] [--port <n>] [--pidfile <path>]` runs the daemon in the
**foreground** — the shape launchd wants, and the shape you want anyway while watching
logs. `rewter status` and `rewter stop` talk to a daemon this process did not start; see
[The pidfile, and talking to a daemon you did not
start](#the-pidfile-and-talking-to-a-daemon-you-did-not-start-m8).
`rewter install-cli` / `uninstall-cli` are what make `rewter` a word rather than a path; see
[Putting the command on PATH](#putting-the-command-on-path-m8b).
`rewter install-service` / `uninstall-service`, `rewter logs` and `rewter gc` are the
launchd side and are described in [Living under launchd](#living-under-launchd-m8).
`rewter export-registry` / `import-registry` move models and cards between machines as a
file, without a daemon —
see [Moving a registry](#moving-a-registry-between-machines-m7j).
`rewter chat [prompt…] [--model <m>] [--project <slug> | --no-project] [--url <daemon>]`
talks to the orchestrator from the terminal with a prompt that stays live mid-run, a
fold-backed live task tree on a TTY, a cost footer after every answer, and the project
auto-selected from the cwd — see
[`rewter chat`: the terminal client](#rewter-chat-the-terminal-client-p2-m3).
`rewter version` / `rewter help` round it out.

### Putting the command on PATH (M8b)

A monorepo builds to `packages/cli/dist/index.js`, and nothing about that makes `rewter` a
word the shell knows. `install-cli` closes that gap, and is deliberately the smallest thing
that can: it **symlinks** the built entry point into `~/.local/bin`.

A symlink rather than a copy, because a copy is correct only until the next `pnpm build`,
after which it is a stale binary reporting an old version and failing in ways that make no
sense next to a checkout that looks right. It works because node resolves a symlinked entry
point to its **real path** before resolving imports, so `@rewter/server` still resolves
through the workspace's `node_modules`. The same property means deleting or moving the
checkout breaks the command — the honest outcome, and better than a copy that keeps
answering.

That real-path resolution has a sharp edge, and it drew blood the first time this ran. The
module's entry-point guard compared `import.meta.url` against `process.argv[1]` as strings.
Invoked through the link those differ — `argv[1]` is `~/.local/bin/rewter`, `import.meta.url`
is the `dist` file behind it — so the guard was false, `main` never ran, and the CLI **exited
0 having printed nothing**, which is indistinguishable from a command that ran and had nothing
to say. The guard now compares `realpathSync` of both, which also drops a hand-built
`file://${path}` that mangled spaces in a checkout path. Note that `run()` unit tests cannot
see this class of bug at all: they import and call the function, so the guard is the one line
they never execute. The regression test spawns a real process with the link as `argv[1]`.

It spawns `node <link> version` rather than executing the link directly, and that distinction
is itself a lesson CI taught. Executing it depends on the artifact's mode: `tsc` emits 644, so
on a fresh checkout `execFile` on the link is `EACCES` — while on a developer machine it
passes, `install-cli` having already set the execute bit during a live run. The first version
was green locally and red in CI for precisely that reason. Setting the bit is `installCli`'s
job and has its own test in `linkcli.test.ts`; the guard is this test's job, and it should not
fail for an unrelated reason.

That mode is a live concern, not just a test detail, and it produced the one user-visible
regression this feature shipped: **`tsc` rewrites `dist/index.js` at 644 on every build**, so
`pnpm build` turned an installed `rewter` into `zsh: permission denied`. Two defences, because
the symptom names the command rather than the cause and is worth preventing outright:

1. `packages/cli`'s `build` script is `tsc … && chmod +x dist/index.js`, so a build never
   leaves a non-executable entry point. A CLI test asserts the built artifact's mode.
2. `installCli`'s `unchanged` branch still calls `ensureExecutable` (except on a dry run).
   `unchanged` describes the *link*, and must not be read as "did nothing" — re-running
   `install-cli` is what a user reaches for when the command stops working, so it has to
   actually repair that state rather than congratulate itself on the symlink.

The directory is chosen by **`PATH` membership only, never by whether it exists**.
`~/.local/bin` leads, `/usr/local/bin` follows, and if neither is on `PATH` the answer is
`~/.local/bin`, created on the spot. Preferring an existing `/usr/local/bin` would trade a
directory the user owns for one needing `sudo` — the first version did exactly that and died
on `EACCES`.

Two rules it shares with `install-service`. It **does not edit your shell rc**: off-`PATH`,
the result carries the `export` line for you to add, because a tool holding your API keys
does not get to rewrite your dotfiles. And it **clobbers nothing** — a link already pointing
at this target is `unchanged`, anything else needs `--force`, and `uninstall-cli` removes
only a symlink that is ours, never a real file someone else put there. `rewter` is a short
name.

`install-service` is unaffected by any of this: it records the running file's own resolved
`dist` path, so the plist points into the checkout rather than through `~/.local/bin` — one
less thing between launchd and the code. Both commands read that path through the same
`entryPoint(opts)` seam, injectable for exactly one reason: under vitest `import.meta.url`
is the TypeScript *source*, and the two commands do different damage with it —
`install-cli` chmods a checked-in file, `install-service` writes a plist telling launchd to
run a `.ts`. Neither is caught by an assertion about the happy path, so the seam is the
fix, and each command has a test that the path it recorded is the one it was given.

### The pidfile, and talking to a daemon you did not start (M8)

`start` runs in the foreground, so `rewter stop` in another terminal has nothing to go on
but what the running process left on disk: `~/.rewter/rewter.pid` (`--pidfile`, then
`REWTER_PIDFILE`, then the default), recording `{ pid, url, startedAt, version }`. It is
written **after `listen`** — under port 0 there is no true address until the socket is
bound, and a file that said `:0` is exactly the one `stop` could not probe — and removed
**first** in `stop()`, unconditionally: from the moment we have decided to stop, the claim
is no longer true, and a `status` racing the drain should read "not running" rather than
point at a closing socket. Writes go through a temp file and a `rename`, so a reader during
a write sees the whole old file or the whole new one. `startDaemon` writes one only when
`pidfilePath` is passed — every test and every library embedding omits it, because a
pidfile is a claim about *the* daemon on this machine and three port-0 daemons must not
leave three of them contradicting each other.

**Nothing trusts the pid.** A pidfile is a claim, not a fact, and it lies three ways: the
daemon was killed before it could clean up, the machine rebooted and the file survived, or
— worst — the pid was *reused* by an unrelated process. Signalling a pid because a file
mentions it is how a stop command kills a stranger. So liveness is a **health probe against
the URL the file records**: a `GET /internal/health` answering with `status: "ok"` is proof
that rewter is the thing listening, which is the question actually being asked. The pid is
used only after that check passes, and only to deliver the signal.

The four outcomes are named rather than collapsed into "running / not running", because
they call for different actions from whoever is reading:

| state | what it means | what happens |
|---|---|---|
| `stopped` | no pidfile (or an unreadable one — no usable claim) | nothing to do |
| `stale` | a pidfile whose URL does not answer | the file is removed, and the fact is printed: the last shutdown was not graceful, so this boot's reconciliation has interrupted rows to show |
| `unreachable` | the URL answers, but not as rewter | **refuse to signal.** Something else is on that port |
| `running` | health answered; the payload rides along | `status` prints counts without a second request; `stop` proceeds |

`stop` sends **SIGTERM only, with no escalation to SIGKILL**. rewter's shutdown drains
in-flight SSE streams, and killing it harder mid-drain leaves the client parsing a
truncated event *and* leaves rows for the next boot's reconciliation to close. It then
waits on the *health probe* rather than on the pid — the stronger check, and the one that
answers what the caller actually wants to know: the port is free and no more requests will
be served. If the drain is still going after the grace period (10s), that is reported so a
human can decide, not papered over on a timer.

`start` probes the same way before booting, and refuses when one is already running. Two
daemons on one database is not obviously fatal — WAL would cope — but both would reconcile
on boot, both would hold the same task ids live, and only one could own the port; the
second one's failure would surface as `EADDRINUSE`, which reads as a port problem rather
than "rewter is already running". `status` exits 0 only when a daemon is actually there,
so `rewter status && open $(…)` behaves.

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

### Living under launchd (M8)

launchd starts a process with a nearly-empty environment: no `~/.zshrc` has run, so no
`ANTHROPIC_API_KEY` is exported, and `PATH` is not something to rely on. Everything in
this section follows from that one fact.

#### `~/.rewter/env` — where the keys come from when nobody typed them

Every secret in rewter is referenced by variable *name* (`apiKeyRef`), which works
beautifully from a shell and not at all at login. So there is one file of `KEY=value` lines,
read at boot and merged **under** the real environment — `ANTHROPIC_API_KEY=sk-x rewter
start` still overrides for one run, and a shell that already exports a key does not have its
value silently replaced by a stale one from a file. An empty string counts as set, because
`ANTHROPIC_API_KEY= rewter start` is a legible way to say "pretend I have no Anthropic key".
`export ` prefixes and shell quoting are tolerated, since the natural way to produce this
file is to copy lines out of `~/.zshrc`.

It is deliberately **not** `config.json` — that is the file people paste into issues. It is
the only place in rewter where a raw key sits on disk, so a mode with any group or other bit
set is reported at boot (`chmod 600`). A bad mode is a **warning, not a refusal**: refusing
would leave a login daemon dead with its explanation in a log the user does not yet know how
to read. A malformed line is named by line number and never echoed — the thing on a
malformed line in this particular file is quite likely to be half of a key. `REWTER_ENV_FILE`
overrides the path.

#### The plist, and why `install-service` stops short of loading it

`rewter install-service [--force] [--dry-run] [--config <path>]` renders
`~/Library/LaunchAgents/com.roowus.rewter.plist` and creates the log directory, because a
`StandardOutPath` launchd cannot open makes the job fail with nowhere to say so — the worst
failure mode a login daemon has. `ProgramArguments` is `[<absolute node>, <absolute cli>,
"start"]`, because there is no PATH to search.

Four decisions are worth stating:

- **The node path is a *stable alias*, not `process.execPath`.** The obvious answer is a
  slow-acting bug. Node resolves symlinks before reporting where it is, so a Homebrew node
  calls itself `/opt/homebrew/Cellar/node/25.2.1/bin/node` — a path with a version number
  in it, which `brew upgrade node` deletes. The plist then names a binary that is not
  there, and nothing says so: the job fails at *boot*, in launchd's log, and the first
  symptom is rewter quietly not running after a reboot weeks later. `stableNodePath`
  (`service/launchd.ts`) walks the aliases a package manager keeps pointed at the current
  version — `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `~/.local/bin/node`,
  `/usr/bin/node` — and takes the first whose `realpathSync` matches. Comparing the
  resolved *file*, not the string, is the whole check; a string match would be defeated by
  exactly the indirection being looked for. With no match (nvm, a source build) the
  resolved path is still true today and is used unchanged. This was found live: the
  installed plist named the Cellar path.

- **No `EnvironmentVariables` key, ever.** `launchctl print` reads the plist back to anyone
  who asks, and a plist's mode is not somewhere people look. An env file's mode is checkable;
  this is the whole reason the previous subsection exists. There is a test asserting the
  rendered XML contains neither `EnvironmentVariables` nor `API_KEY`.
- **`KeepAlive` is conditional (`SuccessfulExit: false`), not `true`.** Exit 0 means `rewter
  stop` asked it to go; resurrecting it a second later would make `stop` look broken.
  `ThrottleInterval: 10` turns a config error into a slow retry rather than a spin.
- **It writes the file and then stops**, printing the two `launchctl` lines rather than
  running them:

  ```
  launchctl bootout gui/$(id -u)/com.roowus.rewter 2>/dev/null || true
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.roowus.rewter.plist
  ```

  `bootout` first, because `bootstrap` on an already-loaded label fails with a bare error
  code. And a tool holding your API keys should not shell out on your behalf — the domain
  target is the part that goes wrong, and it is worth reading the error yourself.

An existing plist that differs is **not** clobbered: the command exits 1 and names `--force`,
because a hand-added key in there is a decision someone made. Re-running after an upgrade
that changed nothing says `already current`. `uninstall-service` removes the file and prints
the `bootout` line; unloading likewise stays the user's call. Paths are XML-escaped —
`~/projects/a & b/` is a legal directory name and an illegal plist.

#### `rewter logs` — what the daemon wrote when nobody was watching

Reads the two files launchd writes rather than talking to the daemon, because the case it
exists for is a daemon that is *not* running. `-n <lines>` tails, `--level <level>` filters,
`--log-dir` points elsewhere.

The two streams are **merged by timestamp with a stable sort**, so an untimestamped line —
a stack trace, a Node warning — stays under the line it followed rather than being sorted to
the top. The interesting case, "it printed warnings and *then* died", is only legible merged,
and launchd will only ever hand us two separate files. pino JSON is rendered as a level and a
message; anything that is not JSON passes through untouched, since those are exactly the
lines that appear when something has gone unusually wrong. Small scalar fields are appended
as `key=value` context, and **fields longer than 80 characters are dropped** — a log reader is
not the place to discover a leaked key. The tail is read from the end of the file under a byte
cap, and the partial first line that produces is discarded; these logs are append-only and
unrotated. No logs yet is exit **0** with a note: before the first launchd boot neither file
exists, and that is a report rather than a failure.

#### `rewter gc` — the database does not shrink on its own

Every orchestration appends, and the bulk of it is the event log the dashboard folds to
reconstruct a task. `rewter gc [--older-than <days>] [--dry-run] [--vacuum]` collects
finished tasks and their work items, worker runs, approvals and events, plus
`~/.rewter/workspaces/<taskId>/` — usually the larger win. Like `sync-models` it opens the
database directly rather than going through a running server, which WAL makes safe and which
means it works whether or not the daemon is up.

Three rules make it more than a `DELETE FROM`:

- **Cost records are never collected.** `cost_records.task_id` is nullable with no foreign
  key precisely so this is possible: dropping a task's transcript is a storage decision,
  dropping its price destroys the answer to "what did I spend in March". Failure records
  are kept on the same grounds — they are evidence about a model, not about a task.
- **Unfinished tasks are never collected**, whatever their age — they are either genuinely in
  flight or something for the next boot's reconciliation to close. Age is measured from
  `finishedAt`, not `createdAt`, so a task that ran for a week is judged on when it *ended*.
- **The sweep is one transaction, children first.** `foreign_keys` is ON with no cascades. A
  gc interrupted between the events and the task row would leave a task the dashboard can
  list but cannot reconstruct. Workspace removal happens *after* the commit: an `rmSync` that
  throws must not roll back a sweep that already succeeded.

`--vacuum` is separate and opt-in, and skipped on a dry run. Deleting rows returns pages to
SQLite's free list, not to the filesystem; `VACUUM` rewrites the file, which needs room for a
second copy and holds a write lock on the whole database — fine to ask for, rude to do to a
running daemon by surprise.

## Tier-2 agent loop

`WorkerAdapter` interface abstracts tiers (`run(ctx)`, optional `send()` for follow-up
injection). Tier-2 tools: `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`,
`grep`, `shell` (a POSIX shell `-c`, cwd=workspace, timeout, 32KB output tail cap), `web_fetch`,
`web_search` (only when a search backend is configured — see below), `load_skill`,
`report_progress`, `finish_report`.

Workspace: `~/.rewter/workspaces/<taskId>/`, shared by a task's workers. Task settings may
point at a real project dir — then *every* write is outside-sandbox → gated.

### The tool surface, as built (M6c)

`workers/tools.ts` declares each tool **twice** — JSON Schema for the model, zod for us —
written side by side, with a parity test asserting the pairing property-for-property. Drift
in either direction is a real bug: the model told about an argument we discard, or an
argument rejected that the model was never told to send. `parseWorkerArgs` returns a
*message* on any failure, because a worker that dies over a number where a string was wanted
has burned a whole subtask on something a one-turn correction fixes.

**`web_search` is declared only where a backend exists.** Until 2026-09-02 it was absent
outright, for the reason that still governs the conditional form: a tool that errors every
time costs a turn to discover and invites a retry. Now `workers/tools.ts` carries the full
list (`WORKER_TOOL_DEFINITIONS`) and a per-run `WorkerToolAvailability` — `{ webSearch }` —
that both `workerToolDefinitions()` (what the model is told) and `parseWorkerArgs()` (what is
accepted) derive from, so the two surfaces cannot disagree. On a daemon with no
`search.provider`, the worker is never told the tool exists, and a call to it anyway gets
`no such tool "web_search". Available: …` — the same message as any other typo. The tier-2
prompt says in so many words that an absent `web_search` means the daemon has no search
backend, so the model reads its absence as a fact about the host and not a bug. The design
note is [`docs/design/web-search.md`](design/web-search.md).

Two schema-level refusals earn their keep. An empty `path` is rejected, because
`resolve(cwd, "")` is `cwd` — a write "to the working directory" is never what the model
meant. An empty `old_text` is rejected while an empty `new_text` is allowed: the latter is how
a passage gets deleted, the former would match everywhere.

### The executor, as built (M6c)

`workers/execute.ts` is where a validated call meets the disk, and it is the **only** place
tools are implemented — one list to audit rather than one per caller. Four house rules:

- **Classify, then ask, then act.** `classify` says whether a path is in the zone, the gate
  decides, and only then does anything happen. A tool that acts and reports afterwards has
  already done the damage — so every deny test also asserts the disk was untouched, which is
  the half that catches an act-then-ask ordering bug.
- **Every failure is a tool result.** A missing file, a denied approval, a non-unique edit
  anchor, a command that exits 1 — all of them come back as text the model reads and responds
  to. Nothing throws except a bug. `errorText` maps errno to prose (`ENOENT` → "no such file
  or directory"), since the raw message repeats the syscall and the path the model already
  knows it asked for.
- **Output is capped, and says when it was cut.** Silently truncated output is worse than
  obviously truncated output: the model reasons confidently about a file it only half
  received. Files truncate **head**-first (the top is where a file's shape lives); `shell`
  keeps the **tail** (a failing build's useful line is the last one).
- **Reads are gated too, when they leave the zone.** A worker pointed at a project directory
  may read the project — that is the job — but not `~/.ssh`, and the only thing separating
  those two is `classify`.

The approval summary quotes the path **as the worker wrote it** alongside the resolved one: a
card reading `../../etc/passwd` tells you what was asked for, the resolved path tells you what
it means, and either alone can mislead.

Per-tool decisions worth stating:

- **`edit_file` refuses an ambiguous anchor** rather than editing the first match. An edit in
  a place the model never looked at is the failure mode most likely to be silently wrong, so
  the error counts the occurrences and asks for more surrounding lines.
- **The shared walk never follows symlinked directories.** A link back up the tree turns a
  walk into an infinite one, and a link out of the zone would read files the gate was never
  asked about — the same escape `classify` closes, one level up. `node_modules`, `.git`,
  `dist`, `build`, `.next`, `.venv` and `target` are skipped outright.
- **`globToRegExp` escapes every regex metacharacter**, so a pattern cannot smuggle in syntax
  matching far more than intended; `**` crosses separators and `*` does not, and `**/` also
  matches *zero* directories so `**/*.ts` finds `a.ts`.
- **`shell` passes `readOnly` to the gate rather than skipping the call.** Policy is the
  gate's to make, and passing the flag instead of bypassing is what keeps every command in the
  audit trail. It runs with **no stdin** — an interactive prompt would hang until the timeout,
  and a worker cannot answer one anyway — and `render` always states the exit code, because a
  worker seeing only output cannot tell a suite that passed from one that failed quietly.
  The **shell itself is resolved, not hard-coded** (`SHELL_PATH`): zsh first, because it is
  the login shell on the macOS host this daemon is built for and a worker's command should
  behave the way the same command behaves in the user's terminal, then bash, then `/bin/sh`.
  Naming `zsh` outright was a real bug — on any host without one, every command came back
  `could not run the command: no such file or directory`, which reads to the model as "your
  command was wrong" rather than "this daemon cannot run commands here". `$SHELL` is
  deliberately not consulted: it can name something that is not POSIX-compatible, and the
  tool's contract with the model — pipes, redirects, `&&` — is a Bourne-family one.
- **`web_fetch` is ungated but http(s)-only.** `file:` would be a way around the path gate
  entirely, which is the one thing a fetch tool must not become. HTML is reduced to text with
  `<script>`/`<style>` bodies dropped *first*, or a page's minified bundle would be the
  majority of what the worker reads.
- **`web_search` is ungated for the same reason, and its backend is one of three.**
  `workers/search.ts` normalizes searxng (keyless, `GET <base>/search?q=&format=json`),
  Brave Search (`X-Subscription-Token`) and Tavily (`POST`, bearer) to one
  `{ title, url, snippet }[]`. The endpoint must be http(s), hits without an http(s) URL are
  dropped (a result the worker cannot fetch is not a result), the row count is clamped to the
  configured `search.maxResults` (default 8, hard max 20, and the tool's own `max_results`
  argument cannot exceed the config), and each snippet is whitespace-collapsed and clipped to
  400 characters. The worker sees a numbered list — title, URL, snippet — sized for "pick one
  or two to `web_fetch`" rather than for reading. A backend error is a tool result naming the
  vendor and the HTTP status, never a throw. `createSearchBackend(config.search, env)` runs
  once at daemon boot; a configured provider whose key variable is unset logs one warning
  alongside the "provider disabled" lines and leaves the tool undeclared.

Its tests run against real temp directories rather than a mocked `fs`, because the thing worth
testing is exactly what a mock would paper over: symlink following, parent creation, resolved
paths, and a killed child process.

### The agent loop, as built (M6d)

`workers/tier2.ts` is the conversation that drives those tools. It satisfies the same
`WorkerRunner = (ctx) => Promise<WorkerOutcome>` shape as tier 1, so the engine's `spawn`
needs no case analysis — but where tier 1 is one call, this is a loop, and everything awkward
about it comes from the model being an unreliable participant in that loop. Four decisions
carry the weight:

- **The loop terminates on `finish_report`, and nothing else.** A model that stops calling
  tools and writes prose gets exactly one nudge; if it does it twice, that prose *becomes* the
  report rather than the run failing on a formality. The work may well be done, and refusing
  to read it would bill the user for tokens and return nothing. Turn exhaustion is still a
  failure — the initiator has to know the run was cut off rather than finished — but it keeps
  the last prose as the run's result text.
- **A repeated denied call is answered from memory, not re-gated.** The prompt tells the
  worker not to retry a refusal, and prompts are advisory. Re-running `approvals.require` for
  a call the user already denied would put the same card in front of them again, so a
  fingerprint — `name(arguments)`, trimmed — of every denied call is kept and a repeat is
  short-circuited with the original reason plus a note that it was already refused. The user
  is asked **once per distinct request**; a retry with different arguments *is* a different
  request and does ask again. The check runs before `dispatch` reaches `execute.ts` at all.
- **`report_progress` and `finish_report` are implemented here, not in `execute.ts`.** Neither
  touches the disk: one writes to the user's live feed and one ends the run. Keeping them in
  the loop is what preserves `execute.ts` as *the* module where every filesystem-reaching tool
  lives — the property that makes it auditable as a list.
- **A tool call is never a throw.** `parseWorkerArgs` failures, unknown tools, denials and
  exceptions all become `role: "tool"` messages, because the only way a model fixes a mistake
  is by being told about it in a turn it can respond to. A malformed `finish_report` is
  recoverable on the same terms: it is told what was wrong and may file again, rather than a
  bad JSON blob costing the whole run.

`createTier2Runner(opts)` is a **factory** rather than a bare runner because workspace and
approvals are per-*task* while `WorkerRunner` is per-*work-item*: the engine builds one when
it opens a session and hands the same runner to every tier-2 worker on that task. That seam is
what let tier 2 land without touching `WorkerContext` or `runTier1Worker`.

`write_file` and `edit_file` paths accumulate into an `artifacts` set that the rendered report
appends as `files touched:`, so the initiator sees what changed even when the model forgets to
list it. The report is rendered as a **document, not JSON**, because its reader is the
initiator — a model — and it will be pasted into a synthesis prompt. A `failure` status fails
the run but still stores the report text; `partial` succeeds with a `partial:`-prefixed
summary, since two findings out of three are worth more to the initiator than a failure.

**A truncated turn ends the run, rather than feeding the loop half of one.** Tier 1's rule
applies here with an extra edge: a tool call caught by the ceiling arrives with unclosed JSON,
so `parseWorkerArgs` rejects it, the loop answers "malformed arguments", and the model — being
told its *syntax* was wrong when its *length* was — tries the same too-long call again until
the turn budget is gone. The run then dies as `no finish_report after 16 turns`, which names
the wrong cause and sends the reader to raise `maxTurns`, the one knob that cannot help. So
`finishReason: "length"` fails the run on the spot, naming the turn number and the ceiling
actually in force, and keeps whatever prose arrived as the result text. As everywhere else, a
truncation *during* an abort is cancelled rather than failed: what the user did outranks what
the model did.

Lifecycle is unchanged from tier 1 and non-negotiable: `created → streaming → succeeded |
failed | cancelled`, with no shortcut edge in `WORKER_RUN_TRANSITIONS`. The loop's tests walk
**every** exit against a real in-memory database — report success/failure/partial, prose
fallback, turn exhaustion, provider throw, `finishReason: "error"`, truncation, pre-abort and
mid-flight abort — because a path that returns without transitioning throws at the repo write
in production rather than in a test. The denial tests count approval cards off the **event log**
rather than the pending list: by the time an assertion runs every card has been resolved, and
counting is the only way to see the difference between asking once and asking twice.

### The tier-2 prompt

`TIER2_SYSTEM_PROMPT` deliberately does **not** ask for tier 1's `SUMMARY:` line, and a test
asserts its absence — two sign-off conventions would give the model a reason to skip the
`finish_report` call the loop depends on. It states the terminator first, then that a denial
is a state to adapt to rather than a wall, then that reading precedes writing (`edit_file`
refuses a non-unique anchor, and having read the file is the cheapest way never to hit that).

`buildTier2Messages` names the scratch space **only when it differs from `cwd`**. When a task
points at a real project directory every write there is gated, so the model needs somewhere
ungated for temporaries and needs telling that its own working directory is not it; when the
two are the same, a second path would only suggest they differ.
The tier-2 prompt also has to explain the marker the engine stamps on an injected message.
`TIER2_SYSTEM_PROMPT` says an unprompted user turn beginning `[FROM THE ORCHESTRATOR]` comes
from the AI that assigned the work and **overrides the original instructions where the two
disagree**, including abandoning work already started. Without that paragraph the worker meets
a user turn its own prompt insists cannot exist, and the most likely reading of a mid-run
correction is that it is context rather than an order.

`ORCHESTRATOR_PROMPT_VERSION` is 3 — the tier ladder no longer says tier 2 is unavailable, it
now warns that work outside the workspace may pause for approval, and a `# Steering a running
worker` section tells the initiator when `send_to_worker` is worth a turn (it costs one; letting
a worker finish wrong costs the whole worker), that tier-1 workers cannot be messaged, and that
a message is in flight rather than acknowledged — so the initiator sends and then `wait`s.

### Wiring tier 2 into the engine (M6e)

The engine picks a runner **per work item, by tier**, in `Session.runnerFor`. Tier 1 goes
straight to `runTier1Worker`; tier 2 goes to a runner built from the task's workspace and
approval gate. An explicit `runWorker` option overrides *every* tier — that is the test seam,
and a dispatcher that honoured it for tier 1 but quietly ignored it for tier 2 would make a
tier-2 engine test reach the real filesystem.

- **The workspace and gate are opened on the first tier-2 spawn, not in the constructor.**
  Opening a workspace mkdirs a directory, and the overwhelming majority of tasks are pure
  tier-1 fan-outs that would otherwise leave an empty directory behind each.
- **Both are per-task, shared by every tier-2 worker on it.** Two workers on one task write
  to the same directory, and a denial one of them collected is a denial the other must not
  re-ask for — which is exactly the memory `Approvals` already keeps.
- **The runner is resolved before the concurrency limiter, not inside it.** A queued tier-2
  worker's workspace therefore exists — and its gate is reachable over HTTP — from the moment
  it is spawned rather than from whenever a slot frees up.
- **`autoApprove` is read through a closure, not captured.** The user may flip the per-task
  toggle in the dashboard while the task runs, and the next gate check should see it.

`Orchestrator.sessions` is a `Map<TaskId, Session>` of live orchestrations, and
`approvalsFor(taskId)` is what makes the M6 approval route possible: the pending Approval row
is in the database either way, but the **promise the worker is parked on only exists in
memory**, so resolving the row alone would leave the worker waiting forever. `null` is the
ordinary answer for a task that has finished or predates a restart — the caller then resolves
the row through `repos` and reports that no worker was waiting, rather than pretending it
unblocked something.

Registration is torn down from two places, because the two failure modes are different: the
stream's `finally` covers normal completion, and an `abort` listener covers a `start()` whose
stream is never pulled (which never runs that `finally`). `dispose` is idempotent, and it also
calls `approvals.cancel()` — cancelling workers aborts their signals, but a worker parked in
`approvals.require` is waiting on a *promise*, not a signal, and without that it would hold
the stream open for a click that is never coming. A task cancelled before its first tier-2
worker parks gets a gate that refuses rather than one that waits.

Where the workspaces live is config: `workspacesDir` (default `~/.rewter/workspaces`).
Deliberately **not** under `dbPath` — a worker that gets creative with a relative path should
not be able to walk into the database file. The engine's own fallback, used when an embedder
or a test never configures one, is under `tmpdir()` rather than `~/.rewter`, so an omission
cannot put a worker's writes in a real home directory.

## Tier 3: external harnesses (P2-M5)

Tier 3 delegates a work item to another agent program — the first adapter is **headless
Claude Code** — instead of rewter's own loop. Three files under `server/src/harness/`:
`types.ts` (the contract), `claude-code.ts` (the adapter), `runner.ts` (the
`WorkerRunner` that wears a session).

### The contract

```ts
interface HarnessAdapter {
  id: string;                 // what a project's allowedHarnesses lists ("claude-code")
  displayName: string;        // what the approval card says ("Claude Code")
  spawn(spec: HarnessSpec): HarnessSession;  // must not throw for foreseeable failures
}
interface HarnessSession {
  events: AsyncIterable<HarnessEvent>;  // session|text|tool_use|turn_end|fatal; fatal is always last
  send(message: string): void;          // mid-run follow-up; drops silently to a dead process
  end(): void;                          // close stdin → the process finishes and exits on its own
  kill(): void;                         // SIGTERM; idempotent
}
```

Everything synchronous by design (a single-process daemon), everything terminal by
convention: a missing binary, a crash, a bad flag all arrive as a `fatal` event on the
stream, never as a throw from `spawn` — the runner has exactly one exit staircase.

### The Claude Code adapter

`claude -p --output-format stream-json --input-format stream-json --verbose
--permission-mode acceptEdits` turns the CLI into exactly the shape `HarnessSession`
wants: NDJSON events on stdout, user frames accepted on stdin at any time (Claude Code
queues one that arrives mid-turn and reads it at the next turn boundary — the semantics
`send_to_worker` promises), and a process that exits when stdin closes after its last
turn. `--verbose` is required by the CLI for stream-json with `-p` and is also what makes
the init line (and with it the session id) appear.

The wire format is parsed **defensively**: every line goes through loose zod schemas and
anything unrecognized is skipped, because the format belongs to another program's release
cycle. Four shapes are read — `system/init` (session id), `assistant` (text + tool_use
blocks, everything else passed through and rendered as nothing), `result` (turn end with
`is_error`, cost, usage), and a line that refuses to parse — and all degrade to "skip",
never to a throw. Missing cost/usage fields degrade to **null, not zero**: zeros would be
recorded as "this turn was free"; nulls are "the harness did not say", which the cost
recorder knows to skip.

**Env sanitization**: the child gets the daemon's environment minus `ANTHROPIC_BASE_URL`
and `ANTHROPIC_AUTH_TOKEN`. Those two are how a machine points Claude Code at a router —
this daemon, typically — and a harness that routed back through the process that spawned
it would recurse: task → harness → `/v1` → task. There is a regression test that spawns a
real child and inspects what it sees. The strip is **best-effort, not a guarantee**:
Claude Code re-applies whatever `env` block its own `~/.claude/settings.json` carries,
which can point the child right back at a router — and at a model alias that router has
broken or exhausted, which live smoke showed produces a *completely silent* session (the
child emits `result` with `is_error:false` and an empty `result`). That is why the
`model` config option exists: the `--model` flag beats the child's settings env, and is
the one lever that reaches past it.

`permissionMode` defaults to `acceptEdits`: headless has no human to prompt, so
`default` would park forever on the first gated tool; `acceptEdits` lets it edit inside
its cwd while shell commands still refuse-and-adapt. The **spawn** is what rewter gates.

### The runner: three edges around a self-driving process

Tier 2 *drives* a model and decides when to call tools; a harness drives itself. The
runner (same lifecycle spine — created → streaming → terminal, every exit a repo
transition) only manages the three edges the process cannot:

- **The gate.** Per-action approval cannot reach inside another program — Claude Code
  prompts nobody in headless mode and rewter cannot intercept its tool calls. So the
  honest gate is **one approval, before the process exists**, kind `spawn_harness`, whose
  summary names the binary and the directory it will own (`run Claude Code in <cwd>`).
  It parks on the *same* `Approvals` object as the task's tier-2 workers, so
  auto-approve, the in-workspace short-circuit, and `cancel()` on dispose all apply
  without a second gate to forget. A denial is a failed worker with the reason in its
  summary — the initiator reads it and re-plans at tier 2.
- **The inbox.** `send_to_worker` messages are drained at every event and forwarded via
  `session.send()`. Session end is decided by an `expectAnotherTurn` flag, **not** by
  whether the inbox is empty at the turn boundary: a message forwarded *mid-turn* empties
  the inbox early while possibly owing the session another turn. Only a turn nothing was
  sent into triggers `end()` immediately; a turn a follow-up *was* sent into keeps stdin
  open under a **bounded grace** (`steerGraceMs`, default 15 s), because "another turn is
  coming" is a maybe, not a promise: Claude Code sometimes steers a mid-turn message into
  the turn already running and answers both in one result — live smoke did exactly this
  (both files created, one `result` line) and the pre-grace runner then waited forever
  for a second turn that would never start, leaving the task stuck `running`. The grace
  timer is disarmed by any subsequent event and firing it early is harmless — `end()`
  only closes stdin, and a turn in flight still completes and reports. The last turn's
  result wins. A "successful" last turn whose
  result text is **empty is a failed run**, not a success: Claude Code's result line
  always carries the final assistant message when a turn really happened, so an empty one
  means the model streamed nothing (dead upstream, silently exhausted quota) — live smoke
  produced exactly this and the run had closed "succeeded" while the requested work was
  never done.
- **The money.** Harness spend never touches the router, so without a CostRecord it
  would be invisible to the task's budget cap. Every `turn_end` that reports cost or
  tokens lands a CostRecord under the synthetic model id **`harness/<adapter id>`**
  (`harnessCostModelId()`, checked against `ModelIdSchema`; `harness/claude-code` for the
  first-class adapter) with an
  all-null pricing snapshot — "the harness said so" is the snapshot — and `overBudget()`
  sees it at the next spawn. A turn that reports nothing lands nothing.

The `session` event's id is persisted to `WorkerRun.harnessSessionId` (a data patch, not
a lifecycle transition — it emits no event), which is the seam
[restart re-adoption](#restart-re-adoption-p2-m5-slice-3) rides across a daemon restart.

### Engine wiring and config

`spawn_worker` now accepts `tier: 3` (`ORCHESTRATOR_TOOLS_VERSION 6`,
`ORCHESTRATOR_PROMPT_VERSION 6`: the ladder describes tier 3 as an external coding agent
that brings its own model — `model` is ignored, the work item is recorded under
`harness/<id>` of whichever adapter `pickHarness()` selects and the registry resolve is
skipped — and always pauses for
approval unless auto-approve is on; if refused, fall back to tier 2). Two pre-spawn gates
return tool-*result* refusals rather than throws, so the initiator can re-plan in one
turn:

1. the daemon has no harness adapters configured → "tier 3 workers … are not enabled on
   this daemon";
2. the task's project sets `allowedHarnesses` (null = all; a list = whitelist by adapter
   id) and none of the configured adapters match → "this task's project does not allow
   any of the configured harnesses". This makes `ProjectPolicy.allowedHarnesses`
   **enforced**, no longer a dormant seam.

`openTier3()` is built lazily on top of `openTier2()`'s workspace and approvals — the
harness works in the same directory tier-2 workers do (`cwdInWorkspace` is what lets the
gate auto-approve a workspace-confined spawn). Config is opt-in and additive:

```jsonc
"harnesses": { "claudeCode": { "enabled": false, "binary": "claude", "permissionMode": "acceptEdits", "model": "(optional — pins --model past the child's own settings)" } }
```

`HarnessesConfigSchema` defaults the whole block, so configs written before the feature
existed still parse. The daemon constructs the adapter only when `enabled` is true.
Under launchd the daemon has no user PATH, so `binary` should be an **absolute path**
(`whence -p claude` finds it — the interactive `claude` is often a shell function).

### The tmux mirror (P2-M5 slice 2)

`tmux attach -t rwtr_<runId>` shows a harness session live. A *mirror*, deliberately —
the harness process does **not** run inside tmux. Headless harnesses speak NDJSON over
pipes, and a pty would wreck both directions: tmux would render raw stream-json instead
of anything a human can read, and `send-keys` input rides the tty line discipline, whose
canonical-mode buffer (4KB on macOS) silently truncates the instruction frames we
actually send. So the child keeps its pipes exactly as slice 1 built them, and
`withTmuxMirror` (`server/src/harness/tmux.ts`) is an **adapter decorator** that tees the
*normalized* event stream into a rendered log a detached tmux session tails
(`tmux new-session -d -s rwtr_<runId> "exec tail -n +1 -f <log>"`). Watching costs
nothing; not watching costs nothing; the harness cannot tell the difference.

What the watcher sees: a header (harness name, cwd, task head), every event rendered
(`· session <id>`, text verbatim, `⚒ Tool <detail>`, `── turn end ($cost) ──`,
`✖ <fatal>`), **steering** as `⇄ user: <message>` — mid-run `send_to_worker` is the
feature the mirror exists to make visible — and a `── session ended ──` line before the
tmux session is killed. Log writes are synchronous (`writeSync` on an `openSync` fd): a
line lands the moment the event goes by, and the file exists before the `tail -f` starts.
`kill-session` fires exactly once, from the tee's `finally` — which runs on natural
exhaustion *and* when the runner abandons iteration (the abort path), so cancelled tasks
don't leave orphaned `tail -f` sessions on the daemon.

Placement and surfacing: logs live under `~/.rewter/harness-logs/rwtr_<runId>.log` — not
inside any task workspace, because a worker with a shell must not be able to rewrite what
the owner is watching. The decorated session carries `attach: { session, command }`, and
the runner emits `watch live: tmux attach -t rwtr_<runId>` as the **first** progress line
(it is only useful while there is still something to watch); the engine already forwards
progress lines to the feed and event log, so this needed zero engine changes.

Best-effort by construction: `withTmuxMirror` probes `tmux -V` once at decoration time
and returns the inner adapter **unchanged** when tmux is missing — a daemon without tmux
runs tier 3 exactly as before this slice. A per-spawn tmux failure after a successful
probe loses the mirror, never the session; a full disk kills the mirror, not the run.
Config (defaults shown — enabled-by-default is safe precisely because missing tmux is a
no-op):

```jsonc
"harnesses": { "tmux": { "enabled": true, "binary": "tmux" } }
```

Same launchd lesson as the harness binary: no user PATH, so a Homebrew tmux needs the
absolute `/opt/homebrew/bin/tmux` here.

Restart re-adoption does **not** depend on tmux: the child is still the daemon's child
and dies with it. Re-adoption rides the persisted `harnessSessionId` and the harness's
own resume mechanism (`claude --resume`), which survives daemon death precisely because
it needs no living process.

### Restart re-adoption (P2-M5 slice 3)

A daemon restart kills every harness child, and
[boot reconciliation](#boot-reconciliation-m8) closes their runs as `interrupted` — that part is unchanged, and deliberately so: the
run's liveness (process, pipes, parked promises) genuinely died. What survives is the
harness's own on-disk conversation, addressed by the persisted `harnessSessionId`. So
re-adoption is **not** boot cleanup silently restarting work; it is an *offer* to the
next orchestration. Resuming is a decision about new work, so it belongs to the model
that plans new work, not to the reconciler.

The pipeline, hop by hop:

1. **Discovery** — `Repos.listResumableHarnessSessions()` returns the newest interrupted
   tier-3 runs that carry a session id (limit 5), joined to the work-item title and the
   task's `workspaceDir` so the offer is legible: what was it doing, and where.
2. **Gating** — the engine only renders the offer when `pickHarness()` would let a
   spawn succeed. A header offering a resume that `spawn_worker` would refuse teaches
   the initiator to distrust the header.
3. **The prompt header** — a per-task "Resumable harness sessions" block (after the
   digest, so it never breaks the prompt cache; absent entirely when there is nothing to
   offer) lists `- <sessionId> — "<title>" — worked in <cwd>`. The cwd is
   `workspaceDir ?? <workspacesDir>/<taskId>` — the same rule `openWorkspace` uses —
   and it is printed because a resumed conversation continues *in that directory*; the
   ladder tells the model not to resume one whose directory does not match the work.
4. **The tool** — `spawn_worker` grew `resume_session_id` (tools/prompt version 6).
   Below tier 3 it is a tool-result refusal, not a throw: only a harness has a session.
5. **The spawn** — the runner threads it into the `HarnessSpec`, and the Claude Code
   adapter turns it into `--resume <id>` on argv. The harness reloads its own
   conversation; rewter never replays anything.

The run/session split is the whole design: the *run* stays `interrupted` (honest — that
attempt died), while the *session* — the harness's conversation with its full context —
is offered to a new run under a new task. Nothing auto-resumes; a fresh task whose work
continues the old one gets the offer, and the model decides.

### The generic adapter spec (P2-M5 slice 4)

Any CLI is a harness now, described in config instead of in code
(`server/src/harness/generic.ts`). The slice-1 promise made good: aider, codex, or a
five-line wrapper script are config entries, and everything downstream — the runner, the
spawn gate, mid-run `send_to_worker`, the tmux mirror, cost visibility, `allowedHarnesses`
— composes for free, because a generic adapter is just another `HarnessAdapter` in the
daemon's list.

```jsonc
"harnesses": {
  "generic": [{
    "id": "aider",                          // allowedHarnesses key; costs bill to harness/aider
    "displayName": "Aider",                 // optional; defaults to the id
    "binary": "/opt/homebrew/bin/aider",    // absolute under launchd — no user PATH
    "args": ["--message", "{instructions}", "--yes"],
    "parse": "plain",                       // or "jsonl"
    "donePattern": "^Applied edits",        // plain-only; optional
    "resumeArgs": ["--restore-chat-history"] // opts into restart re-adoption; optional
  }]
}
```

**Two parse modes.** `parse: "jsonl"` is the generic *JSON* adapter spec: the process
emits newline-delimited JSON shaped like rewter's own harness events (`session`, `text`,
`tool_use`, `turn_end` — lenient, so a minimal wrapper can emit nothing but
`{"type":"turn_end","resultText":"done"}`). Lines that don't parse or aren't recognized
are skipped, never thrown on — stray log output through the same pipe costs nothing.
`fatal` is deliberately **not** in the spec: a process does not get to declare its own
death; exits and spawn failures own that, exactly as they do for Claude Code.
`parse: "plain"` treats stdout lines as `text` progress. With a `donePattern` (a regex,
validated at config load), a matching line is a sentinel: the turn ends with the
accumulated lines as its result, the sentinel excluded, and the accumulator resets — a
REPL-style CLI gets multi-turn steering for free. Without one, the **process exit is the
turn end**: exit 0 succeeds with the accumulated stdout as the result, non-zero fails
with it (or with the stderr tail when stdout was empty).

**Delivery and substitution.** `{instructions}` and `{cwd}` substitute inside `args`;
when no arg mentions `{instructions}`, the task arrives on stdin followed by a newline.
Follow-ups (`send()`) are always plain stdin lines. Substitution happens in the argv
array — there is no shell, so instructions cannot inject. Unlike the Claude Code adapter,
the environment passes through **untouched**: the `ANTHROPIC_*` strip is a
claude-code-specific recursion hazard, and a generic CLI's env is its own business.

**Resume honesty.** `resumeArgs` (with `{sessionId}` substituted) opts a harness into
[restart re-adoption](#restart-re-adoption-p2-m5-slice-3); they are appended only when
resuming. A resume request against a harness *without* `resumeArgs` is a loud `fatal`,
never a silent fresh start — pretending otherwise would hand the initiator a stranger
claiming to remember.

**Config validation up front.** Ids are lowercase-alphanumeric with `._:-` and **no
slash** (the composite `harness/<id>` must always parse as a ModelId), must be unique,
and must not shadow the built-in `claude-code`; `donePattern` must compile as a regex and
only applies to `parse: "plain"`. In the daemon's adapter list, generic entries come
*after* claude-code — `pickHarness()` is first-allowed-wins, so a config that enables
both prefers the first-class adapter unless a project's `allowedHarnesses` says
otherwise. The shared `EventQueue` moved to `harness/queue.ts` (still re-exported from
`claude-code.ts`), since its drain-before-close ordering is the fatal-is-last guarantee
every adapter leans on.

## API surface

- `POST /v1/chat/completions` — OpenAI dialect; pass-through or orchestrator; stream +
  non-stream. **Live**, orchestrator included. Sends `x-rewter-task-id` on an orchestration;
  accepts it back to steer or reattach. Selects a [project](#selecting-a-project) via
  `auto@<slug>` or the `x-rewter-project` header (both channels also live on `/v1/messages`).
- `POST /v1/messages` — Anthropic dialect over the same router; stream + non-stream.
  **Live**, orchestrator included. Named-event SSE, no `[DONE]`; accepts `x-api-key` or
  `Authorization: Bearer`; same `x-rewter-task-id` contract.
- `GET /v1/models` — registry + pseudo-models. **Live.** `auto/orchestrator` is listed
  **first** so it is visible in every client's model picker; disabled models are hidden.
- `/internal`: tasks list/detail/`events?afterSeq=`, `cancel|steer|settings`, approvals
  list/resolve, models CRUD + `sync` + `generate-card`, provider CRUD, `costs?groupBy=`,
  `health`, and `WS /internal/ws` (`{subscribe, afterSeq?}` → replay then live).
  Live today: `health` (the full ops summary, not just counts — see
  [Health](#health-what-the-daemon-knows-about-itself)), `providers`, `models` (**including**
  disabled ones, unlike `/v1/models`), `events?afterSeq=[&taskId=]` (a non-numeric
  `afterSeq` reads as 0 rather than erroring; `?latest=&before=&type=` windows it for
  the log table — see [The event log, as a table](#the-event-log-as-a-table)), approvals — `GET
  /internal/approvals[?taskId=]` plus `POST /internal/approvals/:id` `{approved, note?}` —
  `POST /internal/tasks/:id/cancel` (`{task, aborted, alreadyFinished}`; 404 unknown, 409
  already terminal — see [Kill](#kill-who-writes-the-row-m7d)),
  `POST /internal/tasks/:id/steer` (`{message}` → 202 `{taskId, queued, remainder,
  approvals}`; 404 unknown, 400 empty message, 409 terminal **or** no live session — see
  [Steering by id](#steering-by-id-the-second-door-p2-m3)),
  `POST /internal/tasks/:id/settings` (`{maxSpendUsd: number|null}` → `{task, applied}`;
  404 unknown, 409 terminal, 400 for a zero/absent/non-numeric cap — see
  [Moving the cap](#moving-the-cap-m7g)), `GET /internal/costs`
  (see below), `GET /internal/failures?since=&until=` (a `FailureSummary`; 400 on a
  non-numeric bound — see [Failure recording](#failure-recording-issue-9)), the
  registry-editor writes — `POST /internal/models`,
  `PATCH|DELETE /internal/models/*`, `PUT /internal/card-overrides/*` (see
  [The registry editor](#the-registry-editor-m7f)) — `POST /internal/providers/:id/test`
  (a catalog read against the real upstream; every upstream failure is a **200 carrying a
  verdict**, 404 only for a provider rewter does not have — see
  [Readiness](#readiness-would-this-thing-actually-answer)) — `POST /internal/translate`
  (all three stages of a request, sending nothing), `POST /internal/chat-test` (one real
  completion from one model, bounded and itemised — see
  [What the model actually receives](#what-the-model-actually-receives)),
  `POST /internal/run` (starts an **orchestration**; 202 with an id, results arrive as
  events — see [Starting a task from the dashboard](#starting-a-task-from-the-dashboard-m7h)),
  `POST /internal/shutdown` (202 `ShutdownResult` **then** drains; 501 on a daemon built
  without a shutdown hook — see [Stopping the daemon from its own UI](#stopping-the-daemon-from-its-own-ui-m7i)),
  `GET /internal/registry/export[?note=]` and `POST /internal/registry/import`
  (`{bundle, onConflict?, dryRun?}` → a per-row report; 400 names the field that failed —
  see [Moving a registry](#moving-a-registry-between-machines-m7j)),
  the projects CRUD — `GET /internal/projects[?includeArchived=true]`,
  `POST /internal/projects` (201; 409 on a taken slug),
  `PATCH|DELETE /internal/projects/:slug` (see
  [Editing projects](#editing-projects-the-crud-and-the-panel))
  — and `WS /internal/ws` (see below). `run` and `chat-test` are the two routes on
  `/internal` that spend, and each refuses the other's model string.
  Providers are safe to serve as-is: only the env var *name* is ever stored.
  There is deliberately **no `GET /internal/tasks/:id`**: per-task detail is a fold over
  the event stream, the fold lives in `shared`, and building a second answer to the same
  question on the server would give the dashboard two sources of truth to disagree about.

### `WS /internal/ws`: replay and live, in one place (M7b)

`GET /internal/events?afterSeq=` has been able to hand over history since M1. What it cannot
do is *keep* a dashboard current: poll on an interval and a task can finish between two
polls, so the tree jumps rather than moves; poll fast enough to hide that and a live daemon
spends its life answering. The socket does both halves in one place, and the seam between
them is the part worth designing.

A client sends `{type: "subscribe", afterSeq?, taskId?}` — `afterSeq` is its own
`FoldState.lastSeq`, so a reconnect resumes rather than refolds. The server replays
everything after it, sends `ready`, **and only then attaches the live listener**. The
contract lives in `shared/src/socket.ts`; both sides parse the same schemas.

**Why replay-first, and why duplicates are the acceptable failure.** An event appended while
the replay is being written out gets delivered twice — once from the replay query, once from
the listener. That is exactly the case the fold's `seq <= lastSeq` guard already drops, and
`applyEvent` returns the identical state object for it, so a store can skip the render by
identity. Attaching the listener first would instead deliver that event *ahead* of the replay
rows that precede it. Reordering it cannot fix; redelivery it handles for free. This is what
the "delivers events in seq order across the replay/live seam" test pins, by appending a 21st
work item during the replay of 20 and asserting the received `seq`s equal their own sort.

**`ready` is a frame, not a silence.** It carries `seq` (the highest replayed, or the
client's own `afterSeq` if the replay was empty), `replayed` (a count, so an empty replay is
distinguishable from a stalled one), and `taskId` — nullable rather than optional, because
"all tasks" is an answer and a missing field would read as an older server. A dashboard that
is already current still needs to leave its loading state and still needs a seq to reconnect
with; a quiet socket gives it neither.

**Re-subscribing replaces, it does not stack.** A client that changes its filter would
otherwise receive every event twice, forever.

**A bad message costs an `error` frame, not the connection.** Malformed JSON and messages
that fail the schema both get `{type: "error", message}` and the socket stays open — a
dashboard that mistypes one subscription should see why, not silently lose its connection and
retry the same thing forever. `taskId` is a filter and not an authorization boundary:
`/internal` is localhost-bound, and a client that asks for everything gets everything.

The client half stays deliberately thin — `subscribe` is the only message it can send.
Approve/deny remain REST POSTs: they are actions with outcomes worth a status code (404 for
an id never seen, 409 for one already settled), not stream traffic.

One implementation detail that is easy to get wrong and invisible when you do:
`@fastify/websocket` recognizes `websocket: true` through an `onRoute` hook, and
`app.register()` is deferred to boot. A route declared at root level therefore runs its hooks
*before* the plugin has loaded and is served as a plain GET — the handshake fails with a
non-101 and nothing logs an error. The route is declared inside its own `register` scope so
it is queued behind the plugin. `app.inject()` cannot speak WebSocket at all, so those tests
pay for an ephemeral port.

### Resolving an approval

An approval is two things: a **row** in SQLite, and a **promise** a tier-2 worker is parked
on. Only the row is reachable from an HTTP request, and settling it alone would look exactly
like success while leaving the worker hung forever. So one resolution path serves all three
entry points — the dashboard's buttons, `curl`, and an in-band `approve <id>` reply — and it
tries the live gate first (`Orchestrator.approvalsFor(taskId)`), falling back to a direct row
write only when there is no session: a task that has finished, or one from before a restart.

The response says which happened. `resumedWorker: false` means the audit trail was settled
but no worker was released; claiming otherwise would send a reader looking for one. The list
route reports the same fact per card as `parked`. Status codes distinguish the two ways to be
wrong: **404** for an id never seen, **409** for one already settled — a race the caller lost,
not a mistake it made — and **400** for a body that does not say yes or no.

**In-band replies** are parsed by `orchestrator/steering.ts`, deliberately conservative: a
line is a command only if it is `approve`/`deny`/`reject` — or the one-letter keystrokes
`a`/`d` — followed by approval ids, worker labels (`w1`, `w2`, …), or the literal `all`, and
nothing else. The long verbs take a note only after `:`/`—`/`-`; the keystroke form takes
the rest of the line (`d w1 too dangerous`), because nobody types a colon on a live prompt.
Consuming a line hides it from the initiator, so anything ambiguous ("please approve whichever
you think is right", "a plan", "and then") stays steering — the tests pin the false-positive
cases, since `a plan` is how a person *starts* an instruction. One message can be both —
`approve apr_x` on one line and an instruction on the next does both things, and only the
remainder reaches the initiator. `approve all` is scoped to the pending rows of *that
conversation's* task, never another's.

**Labels resolve at apply time, not parse time.** `w1` is a name the engine gives a worker on
the running session (`Session.workers`), not a column — so the parser only *names* it, and
`applyApprovalCommand` in `http/app.ts` asks the orchestrator for the live session's
`workItemIdForLabel(taskId, label)` and resolves every pending approval row on that work item
through the same `resolveApproval` the dashboard buttons use. An unknown label, or one whose
worker has nothing parked, is a quiet no-op — the same as a stale id — never steering. The
paused feed line is the other half of the contract: it prints `[w1]` and leads with the
keystroke it accepts (`reply "a w1" / "d w1 reason", or "approve apr_…" / "deny apr_…"`), so
what the user reads is exactly what the parser takes; an approval with no worker behind it
(none exist today — every gate call carries a `workItemId`) falls back to the id-only line.

A denial comes back to the worker as a tool **result**, not an exception:
`command not run: denied by the user: use the fixture instead`. A worker told why can adapt;
one handed a crash cannot.

### The fold: events → task tree (M7a)

The event envelope is `{seq, ts, taskId, payload}`, with the discriminator nested one level
down on `payload.type`. The dashboard's view of a task is a **pure reduction over that
stream** — `shared/src/fold.ts`, imported by both sides, which is the same reason there is no
`GET /internal/tasks/:id`: two implementations of "what is this task doing" is two things that
can disagree, and the one the user is looking at would be the one nobody tested.

**Incremental by construction.** The unit is `applyEvent(state, event)`; `foldEvents` is a
loop over it. A dashboard replays `events?afterSeq=N`, then receives live events one at a
time, and the same `FoldState` survives that handover — a client never re-folds from zero to
show one new line. Replay and the live subscription *overlap* by design (an event appended
between the query and the subscribe arrives twice), so anything at or below `lastSeq` is
dropped and returns the **identical state object**, which lets a store skip the render by
identity. Without that guard a re-delivered `cost.recorded` bills the user twice on screen.

**What the fold cannot know.** Status transitions travel as `{from, to}` and nothing else, so
a folded entity gets `status`, `updatedAt` and `finishedAt` patched — all three derivable from
the transition and the envelope's `ts`, with terminality read from the lifecycle maps
(`isTerminal`) rather than a second hardcoded list — while `resultSummary` and `error` stay as
they were at creation, i.e. `null`. The final answer is read from the response stream, not
from here.

**Labels are derived, not transmitted.** The engine names workers `w1`, `w2`, … by spawn
order and that name appears in the user's feed, but it is engine-local state that never enters
an event. The fold reassigns it from `work_item.created` order — the same order, *provided the
fold saw every creation*.

**`orphanedEvents` is the honesty counter.** An event naming a task, work item or run this
fold never saw created is counted, not dropped, and `lastSeq` still advances (refusing to
record a seen event would make the next `?afterSeq=` ask for it forever). A fold that starts
mid-stream is a legitimate thing to want; it just cannot be complete, and silently discarding
the evidence would make an incomplete tree look like a complete one — including its labels.

**Cost is split, not just totalled.** Records land on the run that spent them and roll up to
the work item and the task. A record with no `workerRunId` is the **initiator's own**, tracked
separately because "the planner cost more than the work" is the question this whole design
exists to answer and a single total hides it. A record naming a run the fold never saw still
counts toward the task total — dropping money because the fold started late would understate
the bill, which is the one direction a cost display must not be wrong in.

Tested in `fold.test.ts` against a `seq`-assigning stream builder rather than hand-numbered
fixtures. The load-bearing case is the batch split: folding `[0,6)` then `[6,…)` must deep-equal
folding all of it at once, because replay-then-live *is* that split.

### The dashboard app: one store, one clock (M7c)

`apps/dashboard` is a Vite + React 18 SPA the daemon serves as static files, so there is one
process to start and one to forget to start. In dev, `vite dev` proxies `/internal` (socket
included) at port 20130 instead of rebuilding the bundle on every keystroke.

**How it is mounted.** `@fastify/static` is registered **last**, after every `/v1` and
`/internal` route is declared, so a file can never shadow an endpoint. Unmatched `GET`s fall
back to `index.html` — the dashboard does its own routing, and a deep link the server has
never heard of is the SPA's to resolve — but `/v1` and `/internal` paths are excluded from
that fallback and still 404 as JSON, because answering a mistyped fetch with a page of HTML
turns a 404 into a parse error inside the caller.

The bundle is located from the server module's own path, not `process.cwd()`: launchd starts
the daemon from `/`, the CLI from wherever the operator is standing, and tests from the
package root. A missing bundle is **not** fatal — a checkout that has not run `pnpm build`
boots a working API and logs why the UI is absent, since an operator debugging a provider
should not be blocked on a UI they are not looking at. This was all missing until
[#16](https://github.com/roowus/rewter/issues/16): the docs claimed static serving from the
first commit, but nothing registered it, and the dashboard was reachable only through
`vite dev`.

**There is no fetching layer, because there is nothing to fetch.** The daemon's answer to
"what is happening" *is* the event stream, and the fold that turns it into a task tree already
lives in `shared`. A REST layer beside it would be a second answer to the same question, and
the one on screen would be the one nobody tested. That is why there is no TanStack Query here
and no router: the whole app is one page over one `FoldState`. The costs panel
([M7e](#costs-the-one-panel-that-fetches-m7e)) broke that rule first and the health strip
([below](#health-what-the-daemon-knows-about-itself)) broke it second — each for reasons
the fold structurally cannot answer — and both keep the shape of the answer in `shared`,
where the endpoint and the panel point at one schema.

The store (`src/store.ts`, zustand) is therefore almost entirely socket lifecycle, and four
decisions in it are load-bearing:

- **Renders are skipped by identity, not by deep equality.** `applyEvent` returns the
  *identical* state object for `seq <= lastSeq`, so the replay/live overlap costs nothing —
  the store just sets what it got back.
- **A dropped socket does not blank the tree.** `close` moves to `reconnecting` and leaves the
  fold on screen; the status bar says the feed is stale rather than the page claiming the
  daemon has no tasks. Reconnect re-subscribes with the store's own `lastSeq`, so it resumes
  rather than refolds.
- **Backoff is capped** (250ms → 5s). A dashboard left open on a laptop that sleeps retries
  for hours; uncapped that is a tight loop against a daemon that is not running.
- **An unparseable frame is dropped, not fatal.** It means the daemon is newer than the
  bundle. The rest of the feed keeps working; folding a half-shaped envelope would corrupt the
  tree instead.

**One clock for the page.** `App.tsx` ticks `now` once a second and passes it down; nothing
calls `Date.now()` inside a render. A clock read during render is a different instant per row,
and a test that passes at different times of day.

**Money is formatted to be readable, not to be round** (`src/format.ts`). Sub-cent amounts
print four decimals — a task that cost `$0.0042` must not display as `$0.00`, which reads as
free. The task row shows the split the fold records: total, and the initiator's own planning
spend beside it.

**The approval card does not hide itself on click** (`src/ApprovalCard.tsx`). It disables its
buttons, POSTs, and shows what the daemon said; the card leaves when `approval.resolved` folds.
Hiding optimistically would mean a rejected POST leaves the UI claiming an approval the daemon
never recorded. The buttons come back **only** on failure — a dead daemon is retryable, but
after a success the row is about to fold away and buttons that return for a frame invite a
second click the daemon answers with 409. Each outcome is a different sentence, pinned in
`approvals.test.ts`: `resumedWorker: false` says "recorded — no worker was waiting" rather
than claiming a worker resumed. The card renders `summary` verbatim in a `<pre>`: approving a
paraphrase of a command is approving something you did not read.

Component tests drive `foldEvents` over real envelopes rather than hand-built `FoldedTask`
literals — a hand-built one is a second opinion about what the fold produces, and those tests
would keep passing after the fold changed shape.

### Kill: who writes the row (M7d)

`POST /internal/tasks/:id/cancel` is the dashboard's kill button, and the whole design of it
is a single question — **who writes the terminal row.**

A live orchestration's driving stream already ends with `transitionTask(…, "cancelled")` and a
`⊘ task cancelled (spent …)` line. So the route must **not** also write that row. Two writers
race, and because `cancelled` is terminal in `TASK_TRANSITIONS`, the loser gets
`IllegalTransitionError: cancelled → cancelled` thrown into a generator nobody is catching
for. `Orchestrator.cancel(taskId)` therefore only aborts — one `signal.abort()` on the task's
controller, which the worker tree is chained to — and touches no tables at all.

That leaves the route with two outcomes it reports rather than flattens:

| | | |
|---|---|---|
| live session | `200 {aborted: true}` | tree collapsing; **its own stream** settles the row |
| no session | `200 {aborted: false}` | the route settles the row itself |
| terminal | `409` | nothing to kill |

The middle case is a task from before a restart: the row says `running` but no session exists,
so the `running` is a lie on disk and settling it here is the repair. It looks identical in
the tree a second later and is a very different thing to have done, so the button says which
one happened — the same honesty `resumedWorker` gives approvals. The 409 covers both the
double-click and the task finishing between render and click; refusing is how the state
machine is protected from a request that would throw at it.

The button (`KillButton` in `TaskTree.tsx`) follows the approval card's rule: it does not
recolour the status or remove itself on click. The kill returns as a `task.status` event and
the fold changes the tree — so a POST the daemon refused leaves the UI still showing a running
task, which is the truth. It is absent entirely on a terminal task, because offering it would
be offering the 409.

The engine-side test hangs a worker's upstream call until its signal aborts, which is the only
state where a kill is distinguishable from a no-op: a worker that had already reported leaves
nothing to collapse, and the test would pass against a `cancel()` that did nothing.

### Costs: the one panel that fetches (M7e)

`GET /internal/costs?groupBy=model|day|task&since=&until=&tz=` returns a `CostSummary`:
totals plus buckets, every bucket carrying the same totals shape. The grouping key is
validated, not defaulted — an unknown `groupBy` is a 400, because defaulting would
answer a question the caller did not ask and the numbers would look plausible. Same for
`tz` (pre-flighted through `Intl.DateTimeFormat` so a typo is a 400 rather than a 500
thrown from inside the bucketer) and for a non-numeric `since`/`until`. The response
echoes the zone it bucketed in, so a page can label its day column with the zone that
actually shaped it.

**Why this is a fetch and not a fold** — the dashboard's stated architecture is "no
fetching layer and no cache", so this needed better reasons than convenience, and it has
two. First, a `cost.recorded` event with `taskId: null` — every plain `/v1` pass-through,
which is most of a router's traffic — has no task to attach to, so the fold counts it as
orphaned and drops the number. A costs panel built on the fold would report the
*orchestrated* spend of a daemon whose real bill is dominated by pass-through. Second, a
fold holds only what the socket replayed: a client that connected today would report a
week-old daemon's spend as this morning's. The compromise that preserves the original
principle: the **aggregation is shared code** (`summarizeCosts` in `shared/src/costs.ts`),
so the endpoint and the page cannot disagree — only the row supply differs.

**Why the aggregation is TypeScript and not SQL.** Grouping and summing in the query
would be a second implementation of the split (initiator vs worker, decided by
`workerRunId === null`) that drifts from the shared one the first time the definition
changes. A local daemon's cost table is thousands of rows, not millions — the day SQL is
faster is the day this moves, and the contract above it will not change when it does.
`Repos.allCosts(window)` therefore pulls whole rows (half-open `since <= t < until`, so
adjacent windows tile) and the summary is computed once, in `shared`, where both the
endpoint tests and the panel's expectations point at it.

**The initiator/worker split is the point.** Every total and every bucket carries
`initiatorCostUsd` (spend with `workerRunId === null` — the orchestrator's own planning
tokens) alongside `workerCostUsd`, and the two always sum to `costUsd`. A single number
would hide the failure the whole design exists to catch: an initiator that spends more
deciding than its cheap workers spend *doing* has failed at the thing it is for, and
reads as a perfectly healthy total. `NO_TASK_KEY` (`"(no task)"`) buckets the
pass-through spend under `groupBy: "task"` rather than dropping it — dropping it is what
the fold already does, and is the reason this endpoint exists.

Day buckets sort by key ascending (a chart reads left-to-right in time); model and task
buckets sort by cost descending with a key tiebreak, so the expensive thing is the first
row and equal snapshots are stable. Day keys come from `Intl` with the `en-CA` locale —
its short date format *is* ISO order, and fixed-offset arithmetic would misbucket an
hour of every DST-shifted day.

The panel (`src/CostsPanel.tsx`) is a small block above the task tree, not a page: cost
is context for the task that is running, not a destination. It subscribes to the store's
`fold.lastSeq` purely as a "something happened" tick and refetches — cheap on localhost,
and it avoids reimplementing the aggregation client-side. A failed refetch keeps the
last good numbers on screen with an error line: the panel refetches on every socket
event, so a transient failure is routine, and a panel that blanked would read as
"spent nothing". The fetched body is schema-parsed — `undefined` formatted as a dash is
the one wrong answer that looks like good news.

**The time range (shortlist item 3).** The panel opens on **7D**, not on everything: a
lifetime total answers "what has this cost since the beginning of time", which stops
being a question anyone has by about day three. `1D / 7D / 30D / All` are rolling
windows — `rangeStart()` in `src/costs.ts` subtracts whole days from the moment of the
fetch — and the filtering happens in the daemon via the `since` the endpoint already
accepted, so the cards and the table always describe the same rows.

Three details are deliberate. **"All" sends no `since` at all** rather than `since=0`: a
zero is a real window starting at the epoch, the endpoint echoes it back as `since: 0`,
and nothing downstream could then tell a bounded query from an unbounded one — which
matters because the empty state says different things about the two ("Nothing spent yet."
vs "Nothing spent in this range."). **The window re-anchors on every fetch**, from
`Date.now()` inside the effect rather than the page's ticking `now` clock: a `now`
dependency would refetch once a second, and a start fixed at mount would turn a rolling
window into a growing one. And **the four stat cards only show figures the summary
carries** — cost per request, input→output tokens, cache reads/writes, and the top bucket
of the current grouping. That is the rule the survey drew from OmniRoute's fourteen
tiles, and the same rule that kept latency off the health strip: zero calls renders `—`,
not `$0`, because a zero average claims a measurement that was never taken.

**The failures panel (`src/FailuresPanel.tsx`)** sits directly beneath and is built on the
same pattern — same range tabs, same `lastSeq` tick, same keep-the-last-good-numbers rule,
same schema parse — over `GET /internal/failures`. It is a second panel rather than a second
tab because it measures a different currency: what the upstreams cost in reliability, not in
dollars. The headline keeps `before output` and `mid-stream` apart all the way to the screen
(a single "errors" count would blend the retry-absorbed problem into the open one), the four
cards are mid-stream rate, failure rate, retried-of-before-output, and the top status, and
the per-model table shows successes beside the failures so every rate has its denominator in
view. No calls renders `—` for the same reason zero spend does. See
[Failure recording](#failure-recording-issue-9) for what the rows mean.

### Health: what the daemon knows about itself

First item off the [OmniRoute UI survey](design/omniroute-ui-survey.md)'s shortlist, and
the survey's own words for it: the biggest single gap. The daemon knew its uptime, its
bound URL, how much of the registry was actually enabled, its database's path and
footprint, how much event log there was, and whether anything was parked on an approval
gate — and displayed none of it anywhere a person could read. `GET /internal/health`
grew from a liveness probe into the ops summary; the schema is `DaemonHealthSchema` in
`shared/src/health.ts`, and the dashboard renders it as a facts strip above the spend.

Two constraints shaped the schema, and both are load-bearing:

- **`status`, `version`, `models`, `providers` keep their names *and their meanings*.**
  `service/control.ts` has read those four since M8 to decide whether the thing on the
  port is rewter at all; an older CLI probing a newer daemon must not decide it has
  found a stranger. `models`/`providers` therefore stay the *enabled* counts — what the
  router can actually reach — and the totals live in a new `registry` object beside
  them, which also carries the card count (the half of the registry that steers
  routing). A disabled provider disables routing but not its model rows; the two
  enabled flags are independent, which is exactly why both splits are shown.
- **Everything reported is a fact the process already has.** No latency percentiles:
  rewter instruments nothing per request today, and a percentile computed from worker-run
  timings would be orchestration latency wearing a router's label. A number on an ops
  page is read as measured; better a missing row than a plausible one. (Circuit-breaker
  state is absent for the same reason — it is not a rewter concept yet.)

Three of the fields are subtler than they look:

- **`db.sizeBytes` sums the `-wal` and `-shm` sidecars with the main file** (and is
  `null` for `:memory:`, or when nothing could be stat'd — an ops panel that 500s
  because it could not stat something is worse than one that says it does not know).
  WAL mode keeps recent writes in the sidecar until a checkpoint, so a busy daemon's
  main file can sit unchanged for hours while the sidecar grows; reporting the main
  file alone would answer "is this getting big?" with a confident no at exactly the
  moment it is getting big.
- **`events.lastSeq` is `MAX(seq)`, not the row count** (`EventBus.stats()` supplies
  both). AUTOINCREMENT never reuses a number, so once anything is deleted the two
  diverge — and `lastSeq` is the cursor a replaying dashboard compares itself against.
  Both are one indexed scan, cheap enough to answer on every poll.
- **`uptimeMs`/`startedAt` come from `RuntimeFacts`, not `process.uptime()`.** The
  process's age and the daemon's age are different things under a launchd KeepAlive
  restart, and differ by exactly the interval an operator is trying to notice. The one
  ordering wrinkle — the bound URL exists only after `listen()` resolves port 0, but the
  app must be built before it can listen — is closed by handing the route a *mutable*
  facts object it dereferences per request, which `startDaemon` fills in one line after
  `listen`. An injected app (every test) gets fallbacks: `url: null`, an unknown db
  path, and the instant of its own construction as the start time.

The panel (`src/HealthPanel.tsx`) follows the costs panel's rules and adds one of its
own. It refetches on the socket's `lastSeq` tick *and* on a slow interval (10s) — the
facts it shows move without the socket when the socket is down or the traffic is
pass-through. A failed refetch keeps the last good facts up with an error line: a
health strip that blanks reads as "daemon gone", which is a louder claim than "one
fetch failed". Uptime ticks against the page's shared `now` clock rather than
refetching every second — the fetch is for facts only the daemon can count, not for
the passage of time. The new rule: when `events.lastSeq` is ahead of the fold's own
`lastSeq`, the panel says so — "catching up, N events behind" — because a task that is
not on screen yet is not finished either, and replay lag is otherwise invisible.

### The event log, as a table

Second item off the [OmniRoute UI survey](design/omniroute-ui-survey.md) shortlist. rewter's
log is its best asset — the append-only source of truth everything else folds — and until
this it was readable only *as* that fold: aggregated into a task tree, which by design drops
the rows the tree cannot hold (pass-through `cost.recorded` events with no task, resolved
approvals, finished runs' transitions). The table is the raw log, newest first, filtered and
paged against the daemon.

**Two questions, one route.** `GET /internal/events` answers replay and inspection, and the
params pick the mode:

- `?afterSeq=N` — replay, unchanged since M1: everything after the cursor, oldest first,
  unbounded. A socket resuming wants the oldest unseen first and will read them all; a
  non-numeric value reads as 0 (machine-to-machine contract, tolerant by design).
- `?latest=N[&before=M[&type=a,b][&taskId=]]` — the inspection window: the newest N that
  match (or the newest N older than `before`), returned **ascending** like every envelope
  list, with `hasMore` saying whether matching history continues past the window.

Every window knob is validated rather than defaulted, for the same reason the costs
endpoint's are: `latest=0` silently meaning "everything" would turn a table refresh into a
full-log transfer (`MAX_EVENT_PAGE` = 500 caps it either way), and a typo'd `?type=` that
matched nothing would read as "this never happens" — a 400 naming the value is cheaper. The
type list validates against `EVENT_TYPES`, which is *derived from the payload union's own
members* (`EventPayloadSchema.options.map(...)`) — a hand-maintained list is a second
opinion about what the union contains, and it goes stale the day a type is added. The
dashboard's filter dropdown builds from the same constant.

**Why the window scans backwards.** `EventBus.latestEvents` orders by `seq` descending,
takes `limit + 1`, drops the extra, and re-sorts ascending — one indexed scan answers both
"which rows" and "is there more", where a separate `COUNT(*)` would walk the same rows
twice. The `before` bound is exclusive, so paging backwards (`before = oldest seq on
screen`) can never show a row twice.

**The panel** (`src/EventsPanel.tsx`, collapsed by default — the reason to open the
dashboard is the running task; the raw log is the inspection view you expand when you want
to know exactly what the daemon did, in order):

- **Filters go to the server.** The log can be thousands of rows; "fetch everything, filter
  in the browser" is the anti-pattern the window exists to avoid. Task titles in the filter
  dropdown come from the fold the socket maintains — the log has ids, the fold knows what
  they were called.
- **"Load older" pauses the live tail, and says so.** The newest window refreshes on every
  socket tick plus a slow interval; an operator who has paged into history is *reading* a
  moment, and prepending rows under their eyes would yank the view. The header offers
  "live tail paused — jump to latest" rather than silently going stale or silently moving.
- **One line per event** (`src/eventSummary.ts`), under the rule that the record renders,
  not a paraphrase of it: approval requests show `approval.summary` verbatim (the line a
  decision is made from), progress and steering show their text as written, transitions
  render as transitions (`running → succeeded`) — the type column already says the type.
  Long text truncates on a word boundary; the full line stays on the row's `title`.
- **A failed refetch keeps the loaded rows**, same as every fetching panel: a table that
  empties reads as "the log is gone".

### What the model actually receives

Fifth item off the [OmniRoute UI survey](design/omniroute-ui-survey.md) shortlist, and the
one that pays for the mesh this router is. rewter accepts two downstream dialects and
speaks three upstream ones, and every bug in that mesh reads the same from outside: *the
model got something I didn't send.* Answering it meant reading three files and holding the
translation in your head. `POST /internal/translate` shows it instead — the request as
posted, the `ChatMessage[]` it normalizes to, and the exact body the resolved provider
would be handed.

**The middle stage is the claim.** Two dialects converging is the whole reason
`toChatMessages()` and `fromAnthropicMessages()` exist, and it is unverifiable by reading:
flip the panel's dialect toggle with the equivalent request and the middle pane should not
move. The third stage is where quirks apply, and quirks are invisible by construction —
`max_tokens` becoming `max_completion_tokens`, a system prompt hoisted back out to a
top-level parameter, a model id moving into the URL.

**It sends nothing, and cannot.** The route builds stage three through
`createDescribeOnlyAdapter(provider)`, which skips the env-var lookup (so a provider whose
key is unset still describes) and installs a `fetch` that throws — a describe path that
could reach the network is one keystroke from being a billing surface, since the panel
describes as you type. The builder itself is `ProviderAdapter.describeRequest`, the *same*
function `stream()` calls to construct its own request, pinned by per-adapter equivalence
tests. The panel therefore cannot describe a request nobody would send; if the two ever
diverge, a test fails rather than a user being misled.

**A missing third stage is an answer.** An unknown model, a disabled provider, and
`auto/orchestrator` all produce `upstream: null` with a `note` saying which — and the
first two stages stay, because they are still real. A model that does not resolve is often
*why* the panel was opened.

**`POST /internal/chat-test` — the rung that spends.** Everything else on the debug surface
is free and therefore incomplete. Translate proves the *shape* is right without sending.
The provider probe (see [Readiness](#readiness-would-this-thing-actually-answer)) proves
the key and base URL work by reading a catalog — but a catalog read is not a completion,
six presets expose no catalog at all, and a catalog that *lists* a model is not a model
that serves. So this route sends one real completion, and every decision in it follows from
that:

- **It goes through `router.complete()`**, not an adapter directly — resolution, quirks,
  retry, and cost recording all run, so a test drive exercises the real path and lands in
  `cost_records` like any other spend. It shows up in the costs panel because it *was*
  spend; a debug route with a private accounting would be a hole in the ledger.
- **Bounded before, visible after.** `maxTokens` defaults to 256 and is capped at 1000 —
  this is a "does it answer" button, not a chat window, and the ceiling is what keeps a
  mistyped box from becoming a bill. The response carries `usage` and a `costUsd` computed
  from the same pricing snapshot the router just recorded with, so the two cannot disagree.
- **`costUsd: null`, never `0`.** Keyed off `CostBreakdown.incomplete`: when a component
  had tokens but no price, the total is a lower bound, and a lower bound printed as a
  dollar figure is a wrong dollar figure. The panel renders "unpriced".
- **The upstream's own words, at its own status.** `statusForUpstreamError` forwards 401 /
  404 / 429 and friends; "invalid x-api-key" is the entire answer someone pressed this
  button to get, and a generic 502 would send them back to the logs they came from.
- **`auto/orchestrator` is refused with a 400** before anything is sent. Testing *one
  model* is the question being asked; an orchestration would answer a different one at an
  unbounded price.

**The panel** (`src/TranslatePanel.tsx`, collapsed by default and sited next to the event
log — both are opened when something has gone wrong; this one answers what the log cannot,
which is not what the daemon did but what the upstream was handed). Describing is debounced
at 300ms and aborts its in-flight predecessor. An unbalanced brace is caught client-side by
`parseBody` and reported in place while the **last good render stays on screen** — a JSON
editor that blanks its own output on every half-typed object is unusable to type into. The
Test button takes its model from whatever is in the request box, so there is no second
field to keep in sync, and it is the only control on the page drawn in the warning colour,
because it is the only one that bills.

### The registry editor (M7f)

Five routes and one panel, and they exist to make a single rule visible instead of
buried in `registry/sync.ts`.

**The rule.** A row whose facts came from a provider's catalog carries
`source: "synced"`, and the next `rewter sync-models` refreshes it wholesale. So a
hand-corrected price on a synced row is not an edit — it is a countdown. It survives
until the next sync silently restores the upstream number, and the only symptom is a
cost report that stops matching the invoice. Editing a **fact** therefore promotes the
row to `source: "manual"`, which sync treats as authoritative and leaves alone. Three
consequences follow, and each one is a route decision or a UI decision:

- **`enabled` is not a fact.** Sync never flips it — it is the user's switch, not a
  claim about the model — so it is exempt from promotion (`FACT_KEYS` in
  `shared/src/registry.ts` lists the other seven). Without the exemption, switching a
  model off would take its prices off the sync path forever. The panel gives it its own
  button, sending `{enabled}` alone, so the toggle cannot ride along with a fact edit.
- **Comparison is by value, not by presence.** `applyModelPatch` returns `undefined`
  when the patch matches the row, so a form that POSTs every field on every Save cannot
  promote a row for having been opened. `PATCH` answers `{model, changed: false}` and
  writes nothing — `updatedAt` is the column someone reads to work out when a price
  moved, and a no-op save must not claim an edit.
- **`changed: false` is reported, not swallowed.** The panel says "no change", never
  "saved". The usual way to reach it is a form showing values someone else already
  saved, and a user told "saved" walks away believing a price is fixed.

The editor still sends only dirty fields. Sending the whole form would be harmless —
that is precisely what the value comparison buys — but a patch naming one field is a
patch whose rejection names the field that was wrong. Pricing goes as a whole object,
because a partial price cannot half-apply.

**Routing around the slash.** Model ids are slugs containing a separator
(`anthropic/claude-opus-5`) and Fastify's `:id` named param stops at it, so every
request would 404. The routes are trailing wildcards read via `params["*"]`, and since
a wildcard has to be the last segment, the card patch lives at its own prefix
(`PUT /internal/card-overrides/*`) rather than `/internal/models/:id/card-overrides`.
The client does **not** escape the id: a `%2F` would arrive literal and match no model.

**The five routes.** `GET /internal/models` returns models *and* cards in one
round-trip — the editor shows both on a row, and a second fetch per model would render
prices before rendering what a model is *for*, which is the half that steers the
orchestrator. `POST /internal/models` is a create, not an upsert: a duplicate is a 409,
because silently overwriting would be a way to edit a synced row without the promotion
rule ever running, and `source: "manual"` is set by construction rather than taken from
the body. An unknown `providerId` is a 400 rather than the 500 the foreign key would
otherwise throw from inside SQLite. `PATCH` is above. `DELETE` removes the capability
card first — `capability_cards.modelId` carries a foreign key and `cost_records.modelId`
deliberately does not, so spend history keeps naming a retired model. A report that
quietly loses rows when a model is deleted is worse than one naming something you can
no longer route to. `PUT /internal/card-overrides/*` is a separate lifecycle from the
card itself: `upsertCard` omits `userOverridesJson` from its conflict set, so a hand
correction survives `rewter card <model>` re-running; `{overrides: null}` clears the
patch and restores the generated card verbatim. It 404s when there is no generated card
to patch, because overrides are a patch and there is nothing under them yet.

**Nothing caches.** `Router` calls `repos.listModels()` per request, so an edit lands on
the very next `/v1/chat/completions` with nothing to invalidate — the alternative is a
price that is right on screen and wrong on the bill.

**The panel** (`src/RegistryPanel.tsx`, `src/ModelEditor.tsx`, `src/registry.ts`) fetches
for the same reason the costs panel does: a registry is not a stream of things that
happened, it is a table of what is true now, and there is no `model.edited` event
because there is nothing about a price a task tree would replay. It asks the daemon
nothing until it is opened, and keeps its rows on screen when a reload fails — a
registry that empties on a transient failure reads as "no models configured", which is a
very different problem. The promotion warning appears while the changed value is still
on screen and attributable to a field just typed in, not after the save. A non-numeric
price is refused locally rather than sent: an empty field means "we do not know this
price", `abc` means a typo, and JSON-encoding the resulting `NaN` as `null` would
silently delete a price that was correct. `unpriced` is rendered as itself — a local
Ollama model costs nothing, a model whose price we never learned is a different fact,
and `$0` reads as the first.

**Narrowing the table** (`src/modelFilter.ts`). The panel was written for a registry of
dozens; a [local aggregator](#provider-presets) makes it hundreds, and a hundred-row
table with no way to narrow it is a list you scroll past rather than a registry you edit.
A filter row — query, provider, on/off — sits above the table, and the matching rules
are a pure function so they are provable without the DOM. Three of them are decisions
rather than defaults:

- **The query matches the full id, not the shortened one the table shows.** A registry
  holding both `zai/glm-5.3` and `9router/glm/glm-5.3` renders two rows ending
  `glm-5.3`, and typing the provider is the only way a reader can tell them apart.
  Matching what is on screen would make that impossible.
- **It also matches a card's `bestAt` tags.** "Which of my models is good at OCR" is the
  question the registry exists to answer, and the tags come from the fixed vocabulary
  the digest renders and the initiator reads — so the user types the same token the
  orchestrator does.
- **Order is the daemon's, never re-ranked by relevance.** A row that jumps to the top
  mid-keystroke moves the Edit button out from under the pointer.

The header shows `10 of 109 models` while narrowed rather than `10 models`, because a
bare small number on a large registry reads as a sync that went wrong. A filter matching
nothing gets its own empty state, distinct from an empty registry: the two send you to
different places — one to the filter box, the other to `rewter sync-models`. The provider
dropdown appears only when more than one provider exists, since a dropdown whose every
option shows the same table is furniture. Nothing is debounced: filtering is an array
pass over rows already in memory, so the only cost of a keystroke is a re-render.

### Readiness: would this thing actually answer?

Fourth item off the [OmniRoute UI survey](design/omniroute-ui-survey.md) shortlist, and the
one that spans three layers, because the question it asks — *is this daemon in a state where a
task would work* — has three different answers depending on how far you want to reach. In
increasing cost: a judgement over facts already fetched (the landing card), a count over the
registry in memory (the category chips), and a real request to a third party (the Test
button). Each is a separate piece and they are deliberately not merged.

**`POST /internal/providers/:id/test` — the probe** (`registry/probe.ts`,
`ProviderTestResult` in `shared`). Before this, the only way to find out that a key was
unset, a base URL stale, or a local runtime not running was to route a real request and read
the failure — which arrives mid-task, attributed to a *model* rather than to the provider that
could never have served it.

- **A catalog read, not a completion.** The probe is `GET /models` and its per-vendor
  equivalents — the same request `sync.ts` makes, sharing the path deliberately, since a test
  that took a different route could pass while the route that matters fails. It carries the
  same key down the same base URL, so it answers the same question, and it bills nothing. A
  Test button that quietly spends money each time it is pressed is a button people stop
  pressing. The cost of that choice is `untestable`: six of the seventy-five presets publish
  no catalog endpoint, and for those the honest answer is "this cannot be checked without
  spending" rather than a fabricated verdict.
- **Five verdicts, separated by where the failure is**, because that is what decides what the
  user does next: `no_key` (the named env var is unset — nothing left the machine),
  `unreachable` (the request went out, nothing came back), `refused` (the upstream answered,
  with a refusal — 401 "your key is wrong", 403 "your key is not entitled"), `untestable`, and
  `ok` (with `models` counting the catalog, because "reachable but lists nothing" is a real
  state for a local runtime with nothing pulled).
- **Every upstream failure is a 200 carrying a verdict.** The status code belongs to *this*
  request: 404 means rewter has no such provider. A 502 for a provider that refused would be
  rewter reporting someone else's problem as its own, and the dashboard client's
  `Result.ok: false` would then mean two unrelated things.
- **Redaction is not incidental.** Google authenticates its catalog by *query parameter*, so a
  thrown `fetch` error can print the key inside the URL; an upstream is free to quote your key
  back in its own error body. Every message is passed through `redact()` before it leaves. The
  key is known at that point, so this is a substring replacement, not a guess at what a secret
  looks like.
- **The app takes the env by injection** (`AppOptions.env`), the same object the daemon seeded
  the registry against — so a test answers for the process that would serve the request, not
  for whatever `process.env` holds.

**The providers panel** counts *verdicts*, not rows. "4 providers" is already on the health
strip; `2 ok · 1 no key · 1 untestable` is the fact that is nowhere else — and it only exists
once someone has pressed something. Before that the summary is "none tested yet", never a
green light inferred from `enabled`, which only says a human has not switched the provider
off. Results are triaged `refused, no_key, unreachable, untestable, ok`: the top of that list
is where the work is. "Test enabled" fans out at concurrency 4. Collapsed by default — with
seventy-five presets this is a thing you open when something is wrong.

**Category chips** (`modelFilter.ts`) count the registry along one more axis: `local`, `free`,
`paid`, `unpriced`. Not a copy of anyone's taxonomy — a hosted catalog sorts by vendor and
modality because those are the axes *its* users choose along; rewter's user has already
chosen, and what a hundred-row table hides from them is how much of it costs money and how
much is running on their own machine. Three decisions:

- **`local` derives from `apiKeyRef === null`**, never from a model-id prefix. Every local
  preset is keyless because a runtime you started yourself has nobody to authenticate you to,
  and a hand-added keyless provider lands in the same bucket — correctly, since that is also
  something the operator is running.
- **`unpriced` is not folded into `free`.** They are opposite facts wearing the same `$0`: one
  costs nothing, the other costs an amount nobody has told us. The costs panel bills the
  second as zero, so counting them is how you discover your spend figure is fiction.
- **A half-priced row counts as `paid`.** Something about it bills, and calling it free on the
  strength of the half we happen to know is how a surprise arrives.

The chips are a filter *and* a count, and the axes are independent of `enabled` and provider,
so the four never sum to the registry size — which is why each chip shows its own number
rather than a share of a whole.

**The landing readiness card** (`readiness.ts`, `ReadinessCard.tsx`) turns the health strip's
`2/8 providers · 3/180 models · 41 cards` into the two things worth knowing: whether anything
is blocking, and the command that unblocks it. `0/8` and `2/8` are the same *shape* of fact
and completely different situations, and only one of them means the next task fails.

- **Blocked vs degraded is the whole design.** No enabled model: nothing to route to, the
  orchestrator cannot start — `blocked`. No capability cards: it starts fine and picks badly,
  since the digest is then a list of names and prices with nothing to prefer a vision model
  *for* — `warn`. `ready` is defined as *no blocked check*, so a warn is still ready.
  Collapsing the two would either cry wolf about a working daemon or stay quiet about a broken
  one.
- **The same `0` from two situations gets opposite advice.** An empty registry needs `rewter
  sync-models`; a full one entirely switched off needs the editor. Telling someone to sync 180
  models they already have is advice that does nothing. Same split for providers.
- **No card-coverage ratio.** `cards` counts across the whole registry, `modelsEnabled` counts
  enabled models — different populations, so "how many enabled models have a card" is not a
  number this payload can answer, and a ratio between two populations would read as one that
  is. Only the zero case is flagged.
- **It probes nothing.** A card on the landing view that fired seventy-five outbound requests
  to render is a page you learn not to open; the Test button already answers "is this key
  good" on demand.
- **It disappears the moment a task exists**, and falls back to the original one-line
  invitation before the first health payload lands. A daemon with history has answered the
  question by demonstration, and a permanent "ready ✓" banner is chrome that teaches people to
  stop reading the top of the page.

One fetch feeds two readers: `HealthPanel` takes an optional `onHealth` callback and `App`
holds the payload. A second poller would double the request rate to say the same thing twice,
and occasionally disagree with itself mid-flight.

### Moving the cap (M7g)

`Task.settings.maxSpendUsd` has existed since M5 and, until now, was reachable only by editing
the config file and restarting the daemon — which is no help at all to the person watching a
task they started from Claude Code walk up to its ceiling. `POST /internal/tasks/:id/settings`
is the control that closes that, and everything interesting about it is the same question the
kill button asked: **who writes what.**

Three layers each own exactly one thing, and the tests are written so that none of them can
pass on another's behaviour:

| | writes | reports |
|---|---|---|
| `Orchestrator.setMaxSpendUsd` | the **live session's** settings; nothing on disk | `false` when there is no session |
| `repos.updateTaskSettings` | the **row**, as a patch, emitting `task.settings_changed` | the updated `Task` |
| the route | calls both, in that order | `applied` |

`applied: true` means a live session took the cap, so what the task *will* spend changed.
`applied: false` means the row moved and nothing is executing under it — real, but it is
editing history, and a route that reported both the same way would be claiming the first when
it had only done the second. The row is written on **both** paths, unlike `cancel`: no stream
is racing to write it, and the log should read the same whether or not the daemon happened to
be running the task. 409 on a terminal task, because a cap in force over nothing is not a
thing that happened, and a 200 there would read in the log as a budget that held.

**`null` is not `0`, at every layer.** `TaskSettingsSchema` says `positive().nullable()`, so
zero is rejected by the one contract rather than by a second check at the route; `null` is the
only way to *remove* a cap, and a client that collapsed the two would make removal unreachable.
An absent field is refused too — `{}` and `{maxSpendUsd: null}` are different requests, and
reading the first as the second removes a cap nobody asked to remove. The dashboard's input
carries the same rule: empty means uncapped, `0` is refused client-side without troubling the
daemon.

**The 80% latch resets on a raise.** `budgetWarned` is a one-shot, so `Session.setMaxSpendUsd`
clears it: a user who granted another dollar after seeing the note is owed that note again at
80% of the *new* cap, and a latch left set would spend the difference in silence. The engine
test pins this by asserting two notes quoted against two different caps.

One ordering fact shapes how any of this can be tested: the hard `overBudget()` refusal in
`spawn_worker` fires **before** the worker's callback runs, so a test that raises the cap from
inside a worker must keep spend under the ceiling or the second worker never starts at all.

`Budget` in `TaskTree.tsx` follows the kill button's rule — **no optimistic write.** The
number on screen is the daemon's, arriving as `task.settings_changed` through the fold, so a
POST the daemon refused leaves the old cap visible, which is true. `FoldedTask` already
carries the whole `Task`, so *displaying* the cap needed no new plumbing; only setting it did.
The control is absent on a terminal task for the same reason `Kill` is: offering it would be
offering the 409. The cap itself still shows, because it is history worth reading.

### Starting a task from the dashboard (M7h)

Every other route on `/internal` reports on tasks that already exist; every task itself came
from a client. `POST /internal/run` is the one that makes one, and it is the counterpart to
[`chat-test`](#what-the-model-actually-receives): that route is *one model, one completion,
bill attached*, this one is *an orchestration, a task row, results by event*. Neither wants
to be the other's cheap version, so **each refuses the other's model string** — a concrete
model here is a 400 pointing at the chat tester, and `auto/orchestrator` there is a 400
pointing back — and the refusal names the route that does want it, because "use the chat
tester" is the entire answer someone pressed the button to get.

**It answers 202 with an id, not a result.** The task is started and the request is done.
Awaiting the answer would tie the task's life to a browser tab and would hand back a second
copy of something the dashboard already has: the socket is folding every event this task will
emit, so the row on screen is the daemon's, not a local optimistic one that could disagree
with it. What comes back is only what the caller could not compute — the title the engine
derived and the initiator the registry picked.

**Registration is what makes it outlive the request**, and it is free. `live.register(...)`
would elsewhere put a task on the 30-second disconnect clock, but that timer is started by
`LiveTask.subscribe`'s `finally` — by the **last subscriber leaving**. A task nobody ever
subscribed to has therefore never started one, and a dashboard-started run is not on a clock
at all. The test that pins this simply lets a run finish with no SSE stream ever opened.
Registering also means a client that later re-POSTs the same conversation can adopt and steer
it, which is the whole point of the index and costs nothing extra here.

**A refused run leaves no row behind.** `Orchestrator.start()` writes the task row eagerly, so
a bad initiator pin throws in the half of `start` that runs before the generator — the only
window in which a status code is still sendable — and nothing is written. The status is the
registry's own 404 for a name it does not know, the same one the chat routes give: a second
vocabulary for the same mistake would be one more thing to learn.

**The three meanings of an empty budget box.** Blank is *say nothing* and inherits whatever
the daemon is configured with; the word `uncapped` sends `null` and clears it; `0` is refused
on both sides, because the dangerous reading is "no limit" and nobody types the other one on
purpose. This matters because the engine layers request over configured over schema, so a form
that posted absent fields as present would silently overwrite the daemon's configuration with
the schema's — hence `parseBudget` returning `undefined | null | number` and the client
omitting `settings` entirely when nothing was chosen. `prompt` is `z.string().trim().min(1)`:
a textarea holding a stray newline is refused here rather than starting a task whose title is
blank.

**`workspaceDir` is deliberately not exposed.** A filesystem path typed into a web form is a
different feature with a different threat model, and the panel is a "try an orchestration"
control, not a project launcher.

**The panel** (`src/RunPanel.tsx`) is collapsed by default and sits directly above the tree,
because the tree is where its output goes. It is the only reporting-adjacent panel that starts
collapsed, for the reason its button is drawn with the accent border: it is the one control on
the page that spends *unboundedly*. The Run button is `disabled` on an empty prompt rather than
validating on click — a stray click starting a fan-out is the failure worth designing against.
On success it shows one terse line naming the initiator and nothing else, and it clears the
prompt but keeps the settings, since the next thing anyone does here is the same run worded
differently. The pin dropdown fills from the registry, and a registry that will not load does
not take the form with it: the empty pin is the common case and needs no list at all.

### Stopping the daemon from its own UI (M7i)

`rewter stop` has always existed; it needs a terminal, and the pidfile it reads is written
only by a daemon started as a service ([The pidfile](#the-pidfile-and-talking-to-a-daemon-you-did-not-start-m8)).
`POST /internal/shutdown` is the same act from the page the daemon is serving.

**Answer, then act.** A response body cannot cross a socket the server has already closed,
so the route builds the payload, schedules the stop on `setImmediate`, and returns **202**.
`ok: true` therefore means *accepted and draining*, never *stopped* — the port going away is
the rest of the story, and the caller is expected to watch for it. A hook that throws on that
later tick has nothing to catch it but the route's own handler, so it logs there rather than
becoming an unhandled rejection. The route is a **POST**: a `GET` that stopped the daemon
could be fired by a prefetch.

**`stop()` and `requestStop()` are different things**, and the split is what makes the route
testable. `stop()` drains — pidfile, live index, server, database. `requestStop()` drains
*and* ends the process, through an `onExit` hook that whoever owns the process lifetime
installs; `runUntilSignal` installs it, an embedded daemon installs nothing, and then the two
are identical. Without the split, a route that only drained would leave a process with no
port and no database still running (a hang, from the operator's side), and an unconditional
`process.exit` would take the test runner with it. The drain is memoised **on its promise**,
not a boolean: a SIGTERM racing the button must await the *same* drain, or the second caller
returns while the first is still closing the database and the close throws.

**There is no Restart button.** The generated LaunchAgent sets `KeepAlive` to
`{ SuccessfulExit: false }` on purpose ([Living under launchd](#living-under-launchd-m8)) —
a crash comes back, a clean exit stays down, so that `rewter stop` is not silently undone a
second later. A Restart button would therefore stop the daemon and then wait for something
deliberately not coming. What ships instead is the daemon telling the truth about its own
situation: `ShutdownResult` (in `shared`) carries `supervisor`, `willRestart` and the exact
`restartWith` command.

**`willRestart` is nullable, and that is the point.** `detectSupervisor`
(`service/supervisor.ts`) answers `launchd` only when `XPC_SERVICE_NAME` **equals rewter's own
label** — a rewter started by hand inside someone else's launchd job inherits *that* job's
label, and answering "launchd" there would print a `kickstart` line naming a service that is
not rewter's. A process under a login shell inherits the placeholder `"0"`, which is why the
check is an equality and not a presence test. When it genuinely cannot tell — reparented to
init, or under a container or third-party supervisor — the answer is `willRestart: null`, not
`false`, because "nothing will restart this" would be a guess printed as a fact. The field is
**nullable, not optional**: a client reading `undefined` could not tell a daemon that declined
to guess from one too old to have been asked.

**501, not `ok: false`.** A daemon built without a shutdown hook (an embedded one, a
deployment that withheld it) cannot do this at all, and the schema has no failure shape —
a shutdown that could not start is a status code, and the dashboard turns it into "this
daemon cannot stop itself — use `rewter stop`". `cannot` is not `failed`.

**The client's honest network error.** A `fetch` that rejects here is almost always the
shutdown winning the race against its own reply — a successful stop wearing a `TypeError`'s
clothes. `shutdownDaemon` reads it as `{ ok: true, result: null }` and says "the connection
closed before it answered", because reporting "daemon unreachable" would be true and useless.
An accepted-but-unparseable body lands in the same arm for the same reason: it is going down
regardless, and a failure message would leave someone waiting for a daemon that is already
gone.

**The footer** (`src/DaemonFooter.tsx`) carries both halves of the survey's item 8. The
button is **armed, not immediate** — the first click opens an `alertdialog` naming what is
lost, and only the second posts; a misclick here does not lose a form, it kills the process
serving the page. Once accepted the control is **spent and does not return**, because a
second POST lands on a draining socket and reads as the first one having failed; the 501 case
is the exception, since nothing was attempted. Beside it, the persistent **Local Mode**
sentence: rewter looks exactly like a hosted control plane and says nowhere that it is not
one, so the footer states that tasks, events, costs and the registry live in a SQLite file on
this machine and that API keys are read from the environment by name and never saved. The
version renders from `/internal/health` when it arrives and is **omitted entirely** until
then — `v—` reads as a version the daemon reported.

**The header liveness dot** is the same `data-status` the connection label already carried,
drawn as a dot in `currentColor` so colour and words cannot drift apart. Only `reconnecting`
pulses (and not under `prefers-reduced-motion`): a steady dot is the resting state and must
not compete with the tree, while a blinking one means "this view may already be stale".

### Moving a registry between machines (M7j)

A synced registry is hundreds of rows and, once cards are generated over it, a real amount of
spent money. Reproducing that on a second machine — a laptop, a reinstall, a colleague — should
not mean re-running every sync and re-billing every card. The last item of the OmniRoute survey
is a **bundle**: models, cards and the overrides typed over them, as one JSON file.

**The "no keys" promise is structural, not a filter.** The obvious implementation exports
`Provider` rows with `apiKeyRef` deleted, and stays correct exactly until someone adds a column.
`BundleProviderSchema` (`shared/transfer.ts`) is instead its own **`.strict()`** schema of four
fields — `id`, `name`, `kind`, `baseUrl` — and `buildBundle` constructs each entry field-by-field
rather than spreading and deleting. A secret added to `Provider` tomorrow cannot ride along,
because the format has nowhere to put it. (`apiKeyRef` is an env-var *name* and not itself a
secret; it is still absent, since it describes this machine's environment rather than the models
being described.) Only providers something references are exported at all: a provider with no
models in the registry is local setup, not part of the description.

**Cards export raw.** `getCard`/`listCards` return the merged view — generated fields with
`userOverrides` applied on top — and that is what almost everything should read. The export uses
`listRawCards`, keeping the two layers separate, because merging is lossy in the one direction
that matters: the overrides are the half a person typed, and flattening them into the generated
text means the next `rewter card --regenerate` on the far machine silently discards them.
Import writes both layers back, which takes two calls (`upsertCard` deliberately never touches
`userOverrides`; `setCardOverrides` does the reverse — see [The registry editor](#the-registry-editor-m7f)).

**Import inherits sync's two rules and adds a third.** Never overwrite a human: `onConflict`
defaults to `skip`, and `overwrite` is a thing you ask for. Never delete: a local model the
bundle does not mention is not in the plan at all, since cost records name model ids forever.
And, new here, **never create a provider** — a bundle carries no credentials, so a provider
invented from one would be a row that fails much later and much further away, as a 503 from
inside a task. Models whose provider is absent come back as `no_provider`, with the bundle's
own name for it and a count, because "OpenRouter is not configured here — 14 models skipped"
is a fix and fourteen identical rows is a wall.

**One planner answers both the preview and the write.** `planImport` is pure and lives in
`shared`; `dryRun` runs the identical call and skips the writes. A preview that re-derived its
counts could describe a merge other than the one the button performs. Every row is reported by
name with an outcome (`added | replaced | exists | no_provider | no_model`) and a reason where
one is needed, so a bulk operation does not summarise to a pair of numbers that cannot
distinguish a duplicate from a misconfiguration.

**Four surfaces, one merge.** `registry/transfer.ts` (`applyImport`) turns a plan into rows;
`GET /internal/registry/export`, `POST /internal/registry/import`, the dashboard control and
the CLI all go through it, so there is one place that knows `updatedAt` is stamped locally
(the row was written *here*, and "last touched" is the column read when working out why a price
moved) while `createdAt` stays the bundle's. The HTTP route's own job is the **400**: a
malformed bundle names the field path, because the caller handed us a file and "which line of
it" is the whole question.

**The dashboard control is three steps on purpose** (`RegistryTransfer.tsx`). Picking a file
parses it *client-side* and previews; nothing is written. Changing the conflict mode
**re-previews** rather than applying, so the counts under the button always describe the button.
Only an explicit second press writes, with the mode that was previewed. A file the browser
cannot read never reaches the daemon — the round-trip would have said the same thing, later and
without the filename.

**The CLI works with the daemon down**, against the database directly:
`rewter export-registry [<file>] [--note <text>]` (no file → stdout, so
`rewter export-registry | jq '.models | length'` works) and
`rewter import-registry <file> [--overwrite] [--dry-run]`. The version is checked **by hand
before zod**, because "made by a newer rewter (bundle v2, this one reads v1)" is a useful thing
to say about a file someone believes is an export and `Invalid literal value, expected 1` is
not. A missing provider exits **1**: not a crash, but not a success either — the models it
named did not land, and a scripted import needs to go red.

## Design docs

Larger decisions and investigations live under [`docs/design/`](design/):

- [**Phase 2 direction**](design/phase2-direction.md) — the decided shape of phase 2,
  settled 2026-08-31: **projects** replace sessions as the top-level unit (Multica's
  workspace model — resources, policy, model prefs, and learned state scoped per project
  with a global layer, like `CLAUDE.md` scopes), a **skills learning loop**
  (Hermes-style agentskills.io `SKILL.md` distillation, advise-only with gated writes),
  a **native `rewt` TUI** as the primary interface (a thin client of the existing
  daemon surfaces — the harness already exists server-side), **Tailscale exposure**
  (which requires giving `/internal` the auth it currently lacks), and mid-run
  prompting as a hard requirement. Includes the P2-M1…M5 build order.
- [**OmniRoute UI/UX survey**](design/omniroute-ui-survey.md) — a written record of
  [OmniRoute](https://github.com/diegosouzapw/OmniRoute)'s dashboard (10 sidebar sections,
  118 routes), read to decide what rewter's one-page ops UI is actually missing. Documented,
  not copied: no OmniRoute source was taken for any of it. Ends in a shortlist — a health
  panel, a filterable event-log table, a time range on costs,
  [provider readiness](#readiness-would-this-thing-actually-answer),
  [a translation debug panel](#what-the-model-actually-receives) — and an
  explicit account of what is deliberately *not* adopted (tabs, a router, a command palette,
  combos) and why, argued against [the dashboard app](#the-dashboard-app-one-store-one-clock-m7c).
- [**`web_search` for tier-2 workers**](design/web-search.md) — the note issue #10 asked for
  before code, shipped 2026-09-02. Weighs a search API against scraping and against a
  provider's native search; picks the API, made free-first by a keyless self-hosted searxng
  ahead of Brave and Tavily, with **no per-model dependence** and the tool **declared only
  where a backend exists**. Records the wire shape of each backend, the strict config block
  that cannot hold a key, and what is deliberately left for later.

## Phases

- **Phase 1 (MVP)**: routing + provider adapters, registry + capability cards, orchestrator
  pseudo-model, tier-1 fan-out, tier-2 loop with approval gates, dashboard (live task tree,
  approvals, kill, costs), daemonization. Milestones M0–M8 in [progress.md](progress.md).
- **Phase 2** — redefined 2026-08-31, see [the direction doc](design/phase2-direction.md):
  **P2-M1** projects (top-level unit, Multica-style — resources, policy, model prefs,
  scoped learned state), **P2-M2** Tailscale hardening (`/internal` auth, fail-closed
  non-loopback boot), **P2-M3** the native `rewt` TUI (always-live input, mid-run
  prompting — the steer route and [`rewter chat`](#rewter-chat-the-terminal-client-p2-m3)
  are its first two slices), **P2-M4** the skills loop (agentskills.io `SKILL.md`, distill → stage →
  approve → progressive-disclosure retrieval), **P2-M5** tier-3 harness #1 (Claude Code
  headless on the committed `HarnessAdapter` seam, tmux attach). The original phase-2
  items all survive inside this: harness adapters are P2-M5, tmux attach rides with it,
  and learned stats landed 2026-09-02 as the
  [stats recorder](#learned-stats-the-recorder-and-the-digest), the learning loop's second
  dimension after skills. (The plan listed Anthropic-native `/v1/messages` here; it was
  pulled into phase 1 as M3d once it became clear M3's own acceptance criterion depends on it.)
- **Phase 3**: multi-initiator handoff chains, budgets, scheduling; practices memory as the
  learning loop's third dimension; a possible project rename
  ([#17](https://github.com/roowus/rewter/issues/17)).

## Key risks

- **Orchestrator prompt quality is the product** — prompts are versioned `.md` files,
  snapshot-tested; a small hand-scored eval script (5–10 canned tasks) is built in M5.
- **Streaming edge cases** — contract fixtures include truncated/error/split-tool-arg streams.
- **Dev cost surprises** — FakeProviderAdapter default in tests; `REWTER_DRY_RUN=1` routes
  everything to local Ollama.
