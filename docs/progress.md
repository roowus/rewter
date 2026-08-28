# rewter — Progress Log

Newest first. Every milestone/behavioural change gets an entry in the same commit.

## Phase 1 milestones

| # | Milestone | Status |
|---|---|---|
| M0 | Repo scaffold + docs skeleton + CI + public repo | ✅ 2026-08-27 |
| M1 | Shared contracts + DB (entities, state machines, drizzle schema, event bus) | ✅ 2026-08-27 |
| M2 | Provider adapters + contract test suite | ✅ 2026-08-27 |
| M3 | Pass-through router + OpenAI endpoint + SSE + cost recording | ✅ 2026-08-27 |
| M3d | `/v1/messages` (Anthropic-native) — what Claude Code actually speaks | ✅ 2026-08-27 |
| — | *M3 acceptance: Claude Code live on rewter, 2 providers, tool calls* | ✅ 2026-08-27 |
| M4 | Registry + capability cards + digest renderer | ✅ 2026-08-27 |
| M5a | Orchestrator engine + tier-1 fan-out + handoff + cancellation + budget | ✅ 2026-08-27 |
| M5b | Wiring: HTTP routes, in-band steering + adoption, daemon construction | ✅ 2026-08-27 |
| — | *M5 acceptance: live 3-way parallel fan-out through `auto/orchestrator`* | ✅ 2026-08-28 |
| — | *M4 acceptance: real cards for 3 models, written and eyeballed* | ✅ 2026-08-28 |
| M6 | Tier-2 agent loop + approval gates + workspaces | ⚪ |
| M7 | Dashboard (task tree, approvals, kill, costs, registry editor) | ⚪ |
| M8 | Daemonization (CLI, launchd, boot reconciliation) | ⚪ |

## Log

### 2026-08-28 — three real cards, eyeballed — **M4 acceptance met**

M4's last open item was "real cards for 3 models eyeballed", and it earned its place on the
board: reading the output found two defects that no fixture could have.

Cards written by `nine/gemini-3-flash` for `nine/glm-5.3`, `nine/claude-sonnet-4-6`, and by
`glm-5.3` for the flash model — three real generations against a live upstream.

- **`MAX_TOKENS` cleared the answer but not the thinking.** A card is ~80 tokens of JSON, so 800
  looked generous. A reasoning generator spends its budget reasoning *first*, charged as
  completion tokens and emitted before a single answer byte; the reply came back cut off at 796
  tokens with `finish_reason: "length"`. Raised to 4,000.
- **…and the error blamed the wrong layer.** All the caller saw was "no JSON object in the
  generator's reply", which reads as a bad model. It was our ceiling. `generateCard` now appends
  the truncation explicitly when `finishReason === "length"`, so the next reader raises the cap
  instead of debugging the generator. +1 test, +1 negative assertion that an *untruncated*
  failure does **not** mention the ceiling.
- **A card invented a specification.** It described glm-5.3 as a "9B-parameter" model — a number
  that appears nowhere in the registry, in the prompt, or (as far as anyone can check) in
  reality. The old prompt asked for honesty about *ignorance* but never forbade fabricating
  *specs*, and a spec is worse than a bad tag: unknown tags get dropped by the parser, while
  prose is stored verbatim and quoted back as fact. `CARD_PROMPT_VERSION 2` adds an explicit rule
  — state no specification you were not given; judgement is the job. Regenerating with it
  produced a card that sticks to registry facts and opinion, and the invented parameter count
  was gone.

**720 green** (214 + 485 + 21), build and lint clean. Still open from M5: the tiny hand-scored
eval (5–10 canned tasks).

### 2026-08-28 — M5 acceptance met live, and the cap that wasn't

The M5 acceptance ran against a real upstream: a daemon on :20131 with a local 9router as a
keyless OpenAI-compatible provider, two models registered, and `auto/orchestrator` asked for
three independent facts in parallel. It planned, spawned three tier-1 workers, waited on all
of them, and synthesized a correct numbered list — `▶ [w1..w3]` down the feed, one
`x-rewter-task-id` header, three `work_items` in the database and eight `cost.recorded`
events. Notably the initiator (`nine/glm-5.3`, pinned by config) put every worker on the
*cheaper* `nine/gemini-3-flash` unprompted, which is the cost argument for this whole design
working on its own.

Two things the live run showed that 717 passing tests could not:

- **A configured spending cap did nothing.** `config.orchestrator.maxSpendUsd` parsed, validated
  and was documented as the per-task default — and was never passed to the engine, so every
  task got the schema's uncapped `null`. The task row in SQLite said `maxSpendUsd: null` while
  the config said `1`. Fixed with `OrchestratorOptions.defaultSettings`, merged under the
  request's own settings in `start()`; `concurrency` was inert by the same omission and is
  fixed by the same change. The merge strips `undefined` before spreading, since a partial that
  mentions a key without setting it would otherwise erase the configured value. +2 tests, **719
  green**. Worth stating plainly: every unit test passed because they all supplied settings
  explicitly, and the one path nobody exercised — *say nothing and inherit* — was the only path
  real clients take.
- **`glm-5.3` spends its first tokens on reasoning**, so a 32-token cap returns
  `content: null` with `finish_reason: "length"`. Not a rewter bug — the router reported exactly
  what the upstream sent — but it is what a too-small `max_tokens` looks like from the outside,
  and worth recognizing before debugging the wrong layer.

Still open from M5: the tiny hand-scored eval (5–10 canned tasks). M4's "real cards for 3
models eyeballed" is now unblocked — the same keyless provider can write them.

### 2026-08-27 — M5b: `auto/orchestrator` goes live — **M5 complete**

The engine existed and answered `501`. Now both dialect routes serve it, streaming and not,
and a client can steer a task it already started. `orchestrator/live.ts` + the wiring in
`http/app.ts` and `daemon.ts`; +23 tests (13 `live.test.ts`, 12 `app.orchestrator.test.ts`,
minus overlap), **717 green** (214 shared + 482 server + 21 CLI).

- **`start()` exists because a header has one moment.** M5a's `run()` is a plain async
  generator, so its body does not execute until the first pull — and by then the response has
  begun and `x-rewter-task-id` can no longer be set. `start()` does the eager part (resolve
  the initiator, parse settings, write the task row) and hands back
  `{ taskId, abort, stream }`. The side benefit is the one that matters more: a bad `:pin`
  now fails as a clean JSON `404` instead of as a truncated event stream, and there is a test
  asserting no task-id header goes out on that path.
- **The engine's stream is not the client's stream.** A `LiveTask` pumps the engine into an
  unbounded replay buffer and broadcasts to whatever subscribers exist *at that moment,
  possibly none*. Pumping with nobody attached is the whole design: it makes disconnect,
  reconnect and steering the same mechanism — a subscriber that replays the buffer, then
  follows live — rather than three features.
- **Steering is a re-POST, because that is the only thing an OpenAI client can do.** There is
  no channel for "say something to a request in flight"; there is only posting the
  conversation again, one turn longer. `continuationKeys()` hashes the request's *prefixes*
  (longest first, bounded at 8) and looks each up, so the newest task wins. Two edges got
  tests because both are silent when wrong: an identical re-POST must **not** match itself
  (that is a retry, and matching it would replay the entire conversation into the task as
  steering), and a conversation continuing a task that already **finished** must start a
  fresh one.
- **`app.inject()` cannot test any of this, and that took five instrumentation passes to
  see.** Two steering tests kept starting a second task. The index had the right key; the
  follow-up's `continuationKeys` contained it; `match` still missed — because `live.size`
  logged *from inside the route* was 0. `inject()` serializes in-flight streaming requests:
  the second handler does not run until the first stream has finished, and `onIdle` has by
  then forgotten the completed task. Not a production bug — a test-harness one, and the same
  blind spot `app.socket.test.ts` was written for. Those two tests now bind an ephemeral port.
  The follow-up's `fetch` must also be *awaited* before the parked worker is released, or the
  first task wins the race and there is nothing left to steer.
- **`daemon.stop()` collapses live tasks before closing the socket.** Closing first would
  leave a fan-out's upstream calls billing with nobody left to read the answer.

### 2026-08-27 — M5a: the orchestrator engine and tier-1 fan-out

The thing the whole project is named for. `packages/server/src/orchestrator/` — six modules,
six test files, 111 tests. The engine is complete and driven end to end by scripted models;
**the HTTP routes still answer `501`**, because the wiring (steering index, daemon
construction, replacing the two stubs in `http/app.ts`) is a separable piece and is M5b. What
follows is what the code decided, not what the plan hoped.

- **`run()` returns `AsyncIterable<StreamChunk>` — the exact type `Router.stream()` returns.**
  This is the load-bearing decision of the milestone. An orchestration is indistinguishable
  from a model call at the HTTP boundary, so both dialect routes, both SSE translators, the
  `[DONE]` framing, disconnect handling and `collectStream()` for the non-streaming case all
  work on it *unchanged*. The alternative — a bespoke progress channel — is a second
  implementation of every one of those, kept in sync by hand. Progress lines are therefore
  ordinary `text_delta`s, and every engine test reads the run as plain text.
- **Nothing throws for bad model behaviour.** A hallucinated model id, a tier that does not
  exist yet, a `wait` on a label never spawned, a handoff to an alias of the model already
  running, a spawn past the spending cap — all are *tool results* phrased back to the model,
  and the task carries on. There is a test per path asserting the task still succeeds. A task
  must not die because a model passed a number where a string was wanted.
- **Two real bugs surfaced in code that had already built clean**, both found by tests written
  bottom-up (leaves first, engine last) so that a failure at the top was unambiguously the
  top's fault:
  - **`wait(mode: "any")` hung forever** when one named worker had already finished before the
    call. The engine filtered to still-*running* workers and then raced them, so a satisfied
    "any" blocked on a second result nobody had asked for. Fixed with an explicit `satisfied`
    check. The first regression test I wrote covered the already-settled branch but *not* the
    race, so there is now a second one that holds both workers open and releases exactly one.
  - **`splitSummary` mangled `**SUMMARY:**`** — both bold placements occur in the wild and
    neither parsed. It also scans from the **end** of the text on purpose: a worker
    summarizing a document that itself contains "SUMMARY:" would otherwise hand back a line of
    its own input, and there is a test with exactly that shape.
- **Two test failures that were my error, not the engine's**, both worth recording because the
  received output taught something:
  - A handoff test asserted the successor never sees `"context_summary"`. It always will —
    `ORCHESTRATOR_CORE_PROMPT` uses the phrase when *describing the tool*. The real property is
    that the successor does not see the handoff **reason**, and that is what it asserts now.
  - A budget test expected `$0.90 of $1.00` and got `$0.95`. Correct: **the initiator's own
    turns bill to the task**, so a task's ledger always exceeds the sum of its workers' spend.
- **Spend is read back from `cost_records`, never accumulated in memory** — it survives a
  restart and cannot drift from the ledger the dashboard will show.
- **Resolution happens before the self-handoff check**, because `resolve` accepts aliases and
  bare names: `handoff("glm-5.3")` from `zai/glm-5.3` is a loop that a raw string compare
  would wave through. Test included.
- **A cancelled task ends `message_end`/`stop`, not `error`.** The user asked for it. Only a
  genuine failure gets `error`.
- **Every worker exit path writes the run lifecycle.** `WORKER_RUN_TRANSITIONS` has no
  `created → succeeded` edge, so a path that forgets `streaming` throws at the repo write and
  takes the whole task down with it. All five exits (pre-aborted, throw, error-finish, success,
  mid-flight abort) are walked against a real in-memory database. A throw *during* an abort
  counts as cancelled, not failed — the signal is the only thing that can tell them apart, and
  the two mean different things to the user.
- **The client's conversation passes through untouched, system message and all.** A router that
  quietly rewrote the caller's system prompt would be a bug the caller could never see from the
  outside; there is a test asserting byte equality.
- **684 tests green** (214 shared + 449 server + 21 CLI), +111. `pnpm build` again caught what
  `pnpm test` could not — vitest transpiles without typechecking, and a test helper typed its
  task id as `string` where the brand demands `TaskId`. Build is the gate, for the fourth time.

Still open for M5b: the `LiveTaskIndex` + `x-rewter-task-id` header + stream adoption (the
`fingerprintConversation` half exists and is tested, the index does not), the 30s
disconnect grace, daemon construction, and the two `501` stubs. *(All done — see M5b below.
The small hand-scored eval slipped past M5 and is still open.)*

### 2026-08-27 — M4c: AI card generation, and `rewter card` — **M4 complete**

A model now writes the capability card for another model. This is the last M4 piece: the
registry has rows (M4b), the rows have a card slot (M4a), and something finally fills it.

- **The module is written against one premise: the generator is an unreliable narrator.** Not
  as a slogan — as the thing that decides every branch. It will invent tags, fence its JSON in
  prose, write a paragraph where a clause was asked for, and claim a model is both good and bad
  at the same thing. So `parseCardJson` throws only when there is *no card at all*, and repairs
  everything short of that. The draft schema types tags as `string` rather than the enum
  precisely because a `z.enum()` would reject the whole array — losing four good tags to one
  invented one.
- **A tag claimed as both a strength and a weakness is kept as the weakness**, because the two
  readings are not symmetric: a false strength gets a model *chosen* for work it bills for and
  fails, whereas a false weakness only forgoes an option. The asymmetry is the whole argument.
- **What was thrown away is printed, not swallowed.** `unknownTags` and `contradictions` ride
  along on the result and `formatCardReport` says them out loud. A card silently missing the one
  tag the generator cared about reads as the generator's opinion rather than our filtering.
- **JSON is extracted by counting braces**, string- and escape-aware — not by slicing to the
  last `}`, which is the obvious implementation and breaks the moment a reply ends with
  "…use {curly} braces carefully." There is a test with exactly that shape.
- **The prompt interpolates the tag vocabulary from the schema** rather than retyping it, so a
  tag added in `shared` cannot silently go un-offered to the generator and end up permanently
  unused. A test asserts every tag appears in the prompt. The user turn states the facts we
  already hold (context, price, modalities) instead of asking for them: the generator's job is
  judgement, not guessing at a number sitting in the database.
- **Two guards in the CLI stand between a typo and a bill.** `--using` is required and has no
  default — the generator is billed and its judgement outlives the call, so choosing it silently
  is the wrong kind of convenience. And a bare `card` is not "do them all": a synced registry is
  hundreds of rows, so `--all` must be asked for. An unknown target or an unresolvable `--using`
  fails before anything is spent; there is a test asserting `fetch` was never called.
- **`--regenerate` needs no confirmation prompt**, and that is a property, not an oversight:
  generation never authors `userOverrides` and `upsertCard` writes only the generated half, so
  regenerating cannot destroy a hand correction. Cost is not accounted for here either — the
  call goes through `Router`, which already writes a CostRecord per completion, so cards land in
  the same spend ledger as everything else.
- **Generation is sequential on purpose.** An interactive command against a single upstream; a
  parallel burst buys a few seconds at the price of rate-limit failures halfway through a run
  the user then has to repeat.
- **573 tests green** (214 shared + 338 server + 21 CLI), +33. Two fixtures were wrong before
  the code was: a `parseCardJson` test expected `/invalid JSON/` from `"{not json at all"`, but
  the brace-counting extractor correctly rejects an *unterminated* object before `JSON.parse` is
  ever reached — split into one input per path. And the CLI's completion fixture returned a
  plain JSON body, which the router (which streams everything, even a one-shot `complete()`)
  read as "stream ended without finish_reason" and then, once framed, "without usage".
- **Still open from the M4 plan: "real cards for 3 models eyeballed."** That needs a live
  generator, and the keyless-path constraint from M3 still applies.

### 2026-08-27 — M4b: model sync, and `rewter sync-models`

The registry stops being hand-authored. Catalog parsing for four dialects, a policy layer over
it, and a CLI command that writes straight into the daemon's database.

- **The whole design is two rules about a row someone else may own.** *Sync never overwrites a
  human*: a `source: "manual"` row's pricing is usually the **corrected** pricing — typed
  because the upstream's number was absent or wrong — so sync fills its nulls and changes
  nothing else. *Sync never deletes*: a model that vanishes from a catalog goes `enabled: false`,
  because cost records and events hold references to it and a catalog blinking out for one
  request must not vaporize history. Everything else is a corollary — `enabled` is the user's
  switch and never sync's to flip; new models arrive **disabled** so a 400-row catalog is not
  opt-out; a row whose facts match is left untouched so the report never claims work that did
  not happen.
- **A provider's display name is not a slug.** The first version derived the slug by lowercasing
  the name, which round-trips for maybe two thirds of the 27-row preset table — `"Google Gemini"`
  → `googlegemini`, `"Z.AI (GLM)"` → `zaiglm`, `"Together AI"` → `togetherai`. And because
  `canSync(undefined)` is `false`, a failed preset lookup **silently skips** the provider rather
  than erroring, so the bug presented as "sync did nothing" with no message. Fixed by inverting
  the derived `prv_…` id through a reverse index (`presetSlugForProvider`), which is exact
  because `providerIdForSlug` is deterministic.
- **Enrichment is a bonus, and says when it didn't happen.** Most catalogs are an id list and
  nothing else, so OpenRouter's prices fill everyone else's gaps — on by default, since an
  unenriched sync leaves the orchestrator no basis for preferring a cheap model. If OpenRouter
  itself fails the sync still runs and the report flag says unenriched; if `--provider` scopes
  OpenRouter out of the list the flag becomes a no-op, and the CLI warns on stderr rather than
  leaving you staring at null prices.
- **A failing provider is recorded and stepped over** — one vendor rate-limiting you must not
  block the other twenty-six — but the CLI **exits non-zero**, because a cron'd sync that
  silently half-works is worse than a red one.
- **`sync-models` opens the database directly**, not a running server: it has to work whether or
  not the daemon is up, and booting a second server to read a table would fight the first for
  the port. WAL makes that safe. `openRegistry()` is the extracted config → db → seed prefix of
  `startDaemon`, so the CLI sees exactly the rows the daemon would.
- **540 tests green** (214 shared + 312 server + 14 CLI), +53. The four sync tests that failed
  first time round were three bad fixtures and one real bug: the fixtures used Baseten as the
  "publishes no catalog" case (it *does* publish one), set a `displayName` that always diffed,
  and put a manual row in the `openai/` namespace while syncing OpenRouter — so sync computed a
  different id, found nothing, and created a second row instead of merging.

### 2026-08-27 — M4a: card storage and the digest renderer

The two halves of M4 that the orchestrator actually reads from. Sync and AI card generation
are still to come; these are the pieces they will write into and render out of.

- **Cards are stored in two halves** — generated content, and a `userOverrides` patch — and
  every design decision falls out of one tension: a regenerated card must not destroy a hand
  correction, and a hand correction must not be able to lie about provenance. So `upsertCard`
  omits `userOverridesJson` from its conflict clause, `setCardOverrides` touches nothing else,
  and the merge strips `modelId`/`generatedBy`/`generatedAt` from the patch before applying it.
  A patch that fails to re-parse is **discarded whole** — a typo'd tag in a hand-edit must not
  take a model out of the registry. Merging replaces lists rather than appending: the common
  correction is "this list is wrong", and an append cannot express a deletion. 12 tests, and
  the plan's "override survives re-sync" criterion is one of them.
- **The digest renderer's real requirement is byte-stability**, because it sits behind a
  `cache_control` breakpoint: a digest that renders differently for the same registry makes
  every orchestration pay full input price for a prompt that did not change. So the tests that
  matter are not "does it render" but "does it render the *same bytes*" — order-independence,
  no timestamps, no mutation of the caller's array, and prices normalized through the number.
  That last one is not hypothetical: `0.1 + 0.5` is `0.6000000000000001` in IEEE 754, and a
  synced price arrives as arithmetic.
- **Omission is stated, never silent.** Over budget, models drop from the end of the sorted
  list and the digest says how many. An initiator that cannot see a model will not choose it,
  and it should know that is why. Same instinct as the rest of the renderer: absent facts are
  omitted rather than printed as `unknown`, `$0/$0` reads as `free`, and only the *absence* of
  tools is worth a word, since their presence is the norm and carries no information.
- **487 tests green** (214 shared + 275 server + 8 CLI), +25.
- The **vitest-doesn't-typecheck trap bit for the third time** this milestone: 12 digest tests
  passed against a `renderLine` that did not compile, because `parts` inferred its element type
  from the branded `model.id` and rejected every plain string pushed after. `pnpm test` green is
  not the gate; `pnpm build` is.

### 2026-08-27 — M3 acceptance met: Claude Code runs on rewter

The live run M3 has been owing since it was declared done. It found a bug in the first
request, which is the entire reason acceptance criteria are run rather than reasoned about.

- **The bug: `system` inside `messages`.** Claude Code puts a `system`-role message *in the
  message array*, which Anthropic's own docs do not list — `AnthropicMessageSchema` allowed
  `user`/`assistant` only, so every Claude Code session died on
  `messages.1.role Invalid enum value`. Now accepted, and **kept in place** rather than
  hoisted: unlike the top-level `system` parameter, a mid-conversation system turn means
  something where it sits. A role we genuinely cannot map is still rejected — the widening is
  one role, not a hole. See
  [ARCHITECTURE.md § The Anthropic surface](ARCHITECTURE.md#the-anthropic-surface-post-v1messages).
- **473 tests green** (214 shared + 251 server + 8 CLI), +5. That all 468 passed while the
  product was unusable from its headline client is the lesson: the request shape came from
  the vendor's documentation, and the documentation is not what the client sends.
- **Live, verified against the database rather than the reply text.** A first apparent
  success was a false positive — Claude Code's `~/.claude/settings.json` `env` block
  overrides shell environment variables, so `ANTHROPIC_BASE_URL` still pointed at 9router and
  rewter never saw the request. Re-run with `--settings`, and `cost_records` shows the real
  transit: `ninerouter/glm-5.3 | 57785 | 4 | $0.0349` — that input count *is* Claude Code's
  system prompt and tool schemas.
- **Tool calling works end to end**: `claude --allowedTools Read -p "read note.txt …"` issued
  a real tool call through `/v1/messages` and answered from the file's contents.
- **Two providers on the Anthropic surface**: glm-5.3 via a local 9router upstream (with
  Claude Code as the client) and Ollama `llava-phi3` (direct, since a 4K window cannot hold a
  58K-token client prompt). M3's acceptance criterion — "point Claude Code at it as a plain
  router across 2 providers" — is now met.

### 2026-08-27 — M3d: the dialect Claude Code actually speaks

M3 says "replaces 9router", and that test could not even be run: Claude Code talks
Anthropic's Messages API, not OpenAI's. `/v1/messages` is now live over the same router.
See [ARCHITECTURE.md § The Anthropic surface](ARCHITECTURE.md#the-anthropic-surface-post-v1messages).

- **One router, two dialects.** Everything below the parse is the same `router.complete()` /
  `router.stream()` call the OpenAI route makes — both surfaces converge on `ChatMessage[]`
  at the edge, so routing, retry, cost recording and cancellation have exactly one
  implementation and cannot drift apart.
- **Request translation** (`shared/anthropic.ts`) is a `flatMap`, not a `map`: Anthropic
  batches several `tool_result` blocks into one user turn where we give each its own
  message, and those results are ordered *before* the turn's own text because they answer
  the previous assistant turn. `system` is a sibling field hoisted to a leading message.
  Unknown blocks (`image`, `document`, `thinking`) are dropped, not rejected — vision
  routing is M4, and dropping a block beats 400-ing a whole conversation.
- **The stream is stateful, unlike OpenAI's.** Anthropic requires content blocks to be
  opened and closed with at most one open at a time, so `AnthropicStreamTranslator` is a
  class that tracks the open block and its index: a tool call after text closes the text
  block first, parallel calls get distinct indices, and the message is *always* terminated —
  a mid-stream error emits `error` and still closes, and `finishIfOpen()` catches a stream
  that died with no terminal chunk. No client is ever left waiting on a `message_stop`.
- **Framing differs too**: named `event:` lines (a data-only frame is invisible to an
  Anthropic client) and **no `[DONE]`** — that sentinel is OpenAI's and is an unparseable
  frame here. New `SseWriter.sendEvent()`.
- **Auth accepts both conventions on one key** — Anthropic clients send `x-api-key` and
  never set `Authorization`. Rejections use the error envelope of whichever surface was
  called.
- The M3c disconnect bug is **re-introducible here**, since `streamAnthropic` carries its
  own copy of the listener — so the Anthropic route got its own real-socket cover rather
  than trusting `inject()`. Negative control run: reintroducing the bug in
  `streamAnthropic` alone fails the new socket test with the exact production symptom
  (`"request aborted"` in place of content). Checked, not assumed.
- 468 tests green (209 shared + 251 server + 8 CLI), +55 this milestone.
- Still outstanding: the **live** run of M3's acceptance criterion — Claude Code pointed at
  the daemon across two providers.

### 2026-08-27 — M3c: streaming was broken in production while 31 tests said otherwise

The first live run of M3's acceptance criterion — a real daemon, two real upstreams — found
that **every** streaming request returned a role frame and then `request aborted`. Non-stream
worked. Direct curl to the same upstreams worked. See
[ARCHITECTURE.md § SSE and the OpenAI wire format](ARCHITECTURE.md#sse-and-the-openai-wire-format).

- **Cause**: the client-disconnect listener sat on `req.raw`. An `IncomingMessage` emits
  `"close"` once the *request body* has been read, which on a POST is immediately — so the
  abort controller fired before the first token, every time. Fixed by listening on
  `reply.raw` (the `ServerResponse`, which closes when the socket does) behind a
  `!writableEnded` guard so our own clean finish isn't mistaken for a hang-up.
- **Why the tests missed it**: all 31 wire-format tests run through `app.inject()`, which
  has no socket and therefore cannot express the bug. Green tests, broken product. New
  `http/app.socket.test.ts` binds a real ephemeral port: one test pins that a stream
  survives its own request body, the other that a genuine disconnect still aborts the
  upstream (~25ms). Reverting the one-line fix makes the first test fail with the exact
  production symptom — checked, not assumed.
- A detour worth recording: that disconnect test first took **4s**. Not the abort — undici
  holds an aborted socket ~4s before releasing it, and `app.close()` waits for it.
  `closeAllConnections()` in teardown; 136ms.
- **Live re-verification**, two providers, both streaming real content: Ollama
  (`llava-phi3`, keyless local) and a local 9router upstream (`glm-5.3`) as a plain
  OpenAI-compatible provider. Cost rows land with real token counts
  (`ninerouter/glm-5.3 | 2013 | 264 | $0.0017886`).
- 413 tests green (185 shared + 220 server + 8 CLI).
- **M3's acceptance criterion is not met yet, and the reason is structural**: Claude Code
  talks the *Anthropic* Messages API (`/v1/messages`), not OpenAI's. The plan filed
  `/v1/messages` as a "phase-2 nicety", which was a misread — without it the milestone's own
  "replaces 9router" test cannot run. Tracked as M3d.

### 2026-08-27 — M3b: config, seeding, and a daemon you can actually start

M3's acceptance criterion is "point Claude Code at it as a plain router" — which needed a
bootable daemon, and there wasn't one: `index.ts` was exports only and nothing called
`listen()`. Now there is. See
[ARCHITECTURE.md § Configuration and boot](ARCHITECTURE.md#configuration-and-boot).

- **Config** (`config/config.ts`) — `~/.rewter/config.json`, everything defaulted, `{}` is
  valid. Providers are named by **preset slug**, so a working config is three lines. No
  secret ever lands in the file: `apiKeyEnv` is an env var *name*, for provider keys and for
  rewter's own bearer token alike. Precedence env > file > defaults
  (`REWTER_HOST/PORT/DB/CONFIG`). A non-numeric `REWTER_PORT` throws instead of falling back
  — a typo'd port that silently moves the daemon is a daemon nobody can find. A config path
  asked for *explicitly* and missing throws; the default path missing does not.
- **Seeding** (`config/seed.ts`) — idempotent and keyed by slug. Provider ids are *derived*
  from the slug (`prv_` + 6 readable chars + 6 of FNV-1a) rather than generated, so a
  restart updates rows in place instead of orphaning the costs and events that reference
  them — the same property M4's `sync-models` needs, a milestone early. `createdAt` survives
  a re-seed. A provider with an unset key env var seeds **disabled, not absent**: disabled
  gives a loud 503 naming the model, absent gives "unknown model" and sends you looking in
  the wrong place. Unknown presets and models naming an unseeded provider are warnings; a
  duplicate slug is fatal (two rows would collide on the derived id).
- **Boot** (`daemon.ts`) — config → db → registry → router → listening app, returning the
  running pieces rather than owning the process, so tests boot a real daemon on port 0 and
  M8's launchd wrapper adds signal handling without this module knowing about processes.
  `bootSummary()` prints the bound URL and enabled counts, nothing secret.
  `runUntilSignal()` wires SIGINT/SIGTERM to a graceful drain and returns a promise that
  never settles — the caller's `await` *is* the running state; a second Ctrl-C is ignored
  rather than starting a second `stop()`.
- **`main.ts`** is a separate entrypoint from the `index.ts` barrel, so importing
  `@rewter/server` never starts a server as a side effect.
- **CLI is real** — `rewter start [--config <path>] [--port <n>]`, `version`, `help`.
  The unimplemented commands name their owning milestone (`stop`/`status`/`logs`/
  `install-service`/`gc` → M8; `sync-models`/`card` → M4) and exit 1 rather than pretending.
- **Port 20130**, deliberately not 9router's 20128, so both can run during the switch.
- Two bugs caught while writing rather than after: the first `providerIdForSlug` truncated
  slug+hash to 12 chars, so any two slugs sharing a 12-char prefix would have collided onto
  one row (now 6 readable + 6 hash, with a regression test); and `DEFAULT_PORT` was a
  function called from `ConfigSchema` above its own declaration.
- 411 tests green (185 shared + 218 server + 8 CLI; 62 new). Two of them assert the
  invariant directly rather than trusting it: a literal key value never appears in a
  serialized provider row, nor in the boot summary.

### 2026-08-27 — M3: pass-through router + OpenAI endpoint + SSE + cost recording

rewter now answers OpenAI clients. See
[ARCHITECTURE.md § Router and the OpenAI surface](ARCHITECTURE.md#router-and-the-openai-surface).

- **Model resolution** (`router/resolve.ts`) — four tiers, decreasing confidence: exact
  registry id → exact upstream id → bare name → `/`-anchored suffix match. Each tier is
  tried *whole*, so two bare-name hits are a 400 `AmbiguousModelError`, never a drop to a
  fuzzier tier that happens to yield one. A disabled provider is a loud 503, not a
  disappearing model.
- **Router** (`router/router.ts`) — retry lives here, not in adapters, because only this
  layer knows whether bytes have been *delivered*. Retry applies to the connection attempt
  and stops the instant the first chunk escapes; a pre-emission error is captured and the
  retry-or-surface decision is made once, after the loop, so the upstream's own message and
  `statusCode` survive (annotated `(after N attempts)` only when N > 1). Backoff
  `min(250·2ⁿ⁻¹, 4000)`ms, injectable so tests never sleep. A silent stream and a throwing
  adapter are both contract violations, and both still terminate the caller rather than
  hanging. `complete()` folds `stream()` so retry and cost recording have one
  implementation.
- **Cost recording** — computed at `message_end` from a **pricing snapshot** (a later price
  change cannot rewrite history), once per request rather than per attempt, and with a
  nullable `taskId` so plain pass-through calls are metered too. A stream that dies before
  reporting usage records nothing.
- **SSE writer** (`http/sse.ts`) — byte-exact `data: …\n\n` framing over `reply.raw`,
  literal `data: [DONE]\n\n` terminator, 15s `: ping` heartbeats (an orchestration can think
  for minutes; proxies cut idle sockets long before that). Client disconnect aborts the
  upstream call — on a paid upstream those tokens cost real money.
- **`POST /v1/chat/completions`** — stream and non-stream. Resolution happens *before* any
  bytes go out, because after SSE headers there is no status code left for a bad model name.
  Permissive parsing: unknown knobs (`top_p`, `seed`, …) ignored rather than 400'd;
  `max_completion_tokens` accepted; `developer` role normalized to `system`; Claude Code's
  multi-part content array flattened.
- **`GET /v1/models`** — `auto/orchestrator` listed first so it shows up in every model
  picker; disabled models hidden. The pseudo-model itself returns a `501 not_implemented`
  until M5, rather than silently routing to some arbitrary concrete model.
- **Gateway status policy** — an upstream failure is a 502 from where the client sits,
  *except* statuses that describe the caller's own request (400/401/403/404/413/422/429),
  which are forwarded verbatim. A rate limit buried under a generic 502 hides the one thing
  the client can fix.
- **Bearer auth** on `/v1` (optional; absent = open localhost daemon). `/internal` stays
  open — localhost-bound, and the dashboard holds no key.
- Two bugs the new tests caught rather than review: the router's give-up branch was
  **unreachable** for a final-attempt error (it fell through and lost the attempt count),
  and the HTTP layer passed an upstream 500 straight through as a 500 instead of a 502.
  Both fixed, both now pinned by tests.
- 349 tests green (185 shared + 164 server; 95 of the server tests are M3, including 31
  `app.inject()` wire-format tests asserting raw SSE bytes — the milestone's own
  verification criterion).

### 2026-08-27 — M2: provider adapters + contract test suite

- Three adapter classes in `packages/server/src/providers/`, all emitting the same
  normalized `StreamChunk` grammar (see
  [ARCHITECTURE.md § Provider adapters](ARCHITECTURE.md#provider-adapters)):
  - **anthropic** — native SDK; leading system messages hoisted to the top-level `system`
    param, `cache_control: ephemeral` placed on the *last* system block via
    `cacheUpToMessage`, consecutive tool results merged into one user turn.
  - **openai-compat** — one class for ~25 of the 27 presets, parameterized by
    `{baseUrl, apiKey, quirks}`.
  - **google** — `@google/genai`; `systemInstruction` hoist, `user`/`model` roles,
    `functionResponse` parts folded into a single user turn keyed by function *name*.
- **Quirks instead of subclasses**: `usageOptional` (local runtimes omit usage entirely),
  `maxCompletionTokens`, `noStreamOptions`.
- **Provider presets table — 27 upstreams** (the OmniRoute-breadth requirement): 3
  first-party SDK, 12 aggregators, 8 direct vendors, 4 local runtimes. Adding an upstream is
  a table row, not code. Slugs are constrained to `[a-z0-9-]+` because they namespace model
  ids; `apiKeyEnv` is an env var *name* only (asserted SCREAMING_SNAKE — a real key could
  never match).
- **Factory** is the single place that reads secrets from the environment. Unset *or empty*
  key → `MissingApiKeyError` naming the provider and the variable, never a value. Falls back
  `provider.baseUrl ?? preset.baseUrl` and inherits preset quirks. Local providers may be
  keyless.
- **`describeAdapterContract()`** — eight assertions run against all three adapters over
  recorded wire fixtures replayed through a stub `fetch` (chunked at event boundaries):
  text, split tool arguments, parallel tool calls, HTTP error, truncated stream, abort.
  Adding an adapter means adding fixtures, not tests.
- Two semantics the contract pins down: a stream that dies before its upstream terminal
  event yields a **retryable error**, never a clean `message_end` (truncation must not
  masquerade as a complete answer); and **aborts are non-retryable**, so a cancelled task is
  not retried back to life.
- Two upstream facts discovered while wiring Google: `@google/genai` calls the **global**
  `fetch` (no injectable transport — tests stub and restore it), and Gemini reports
  `finishReason: STOP` even on a pure function-call turn. The adapter lets a seen function
  call outrank `STOP` and normalizes to `tool_calls`, and synthesizes `gemini_call_<n>` ids
  since Gemini sends none.
- Dropped the unused `msw` devDependency — the adapters take an injectable `fetch`, so a
  stub `fetch` is simpler and closer to the wire than HTTP interception.
- 254 tests green (185 shared + 69 server; 58 of the server tests are M2).

### 2026-08-27 — M1: shared contracts + DB

- `@rewter/shared` now exports the full cross-boundary contract:
  - branded IDs (`task_`/`wi_`/`run_`/`apr_`/`evt_`/`prv_`/`cst_` + `ModelId` slug schema);
  - lifecycle state machines (`assertTransition` per entity, `IllegalTransitionError`) —
    exhaustively tested: every (from → to) pair of every machine, reachability,
    terminality, no self-transitions (167 cases);
  - zod entities: Provider (apiKeyRef = env var name only), Model, CapabilityCard
    (fixed 14-tag vocabulary shared with ModelStat), Task/TaskSettings, WorkItem,
    WorkerRun (incl. `harnessSessionId` tier-3 seam), Approval, CostRecord
    (pricing snapshot at write time), ModelStat (phase-2 schema, day-one);
  - event envelope: discriminated-union payloads (`task.created`,
    `*.status_changed`, `approval.requested/resolved`, `cost.recorded`,
    `steering.received`, `handoff.initiated`, …) + `NewEvent` (seq/ts assigned at append);
  - unified chat format: `ChatMessage`/`ToolCall`/`ToolDefinition`/`Usage` and the
    normalized `StreamChunk` union the adapter contract suite (M2) will enforce.
- `@rewter/server` DB layer: drizzle schema (all tables incl. phase-2
  `model_stats` + `harness_session_id`), generated SQL migration, `openDb`
  (WAL, foreign_keys ON, busy_timeout 5000, synchronous NORMAL; `:memory:` for tests),
  `EventBus` (synchronous durable append → fan-out; `eventsAfter(seq)` replay),
  `Repos` — every status write goes through `assertTransition` and emits the
  matching event; rows re-parsed through shared zod schemas on read.
- 196 tests green (185 shared + 11 server: round-trips on in-memory SQLite,
  FK enforcement, replay ordered by seq, subscriber isolation).

### 2026-08-27 — M0: project born

- Design finalized (see [ARCHITECTURE.md](ARCHITECTURE.md)): OpenAI-compatible router +
  AI-controlled orchestration via `auto/orchestrator` pseudo-model, 3-tier worker ladder,
  approval gates, capability-card registry, local daemon + SQLite.
- Monorepo scaffolded: pnpm workspaces (`shared`, `server`, `cli`, dashboard app slot),
  strict TS, Biome, vitest, CI workflow.
- Name **rewter** chosen; verified free on npm and GitHub.
- Published to [github.com/roowus/rewter](https://github.com/roowus/rewter) (public); first
  CI run green (build + typecheck + lint + test).
