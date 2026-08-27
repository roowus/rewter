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
| M4 | Registry + capability cards + digest renderer | 🟡 storage + digest done; sync + card generation left |
| M5 | Orchestrator + tier-1 fan-out + steering/handoff/cancellation | ⚪ |
| M6 | Tier-2 agent loop + approval gates + workspaces | ⚪ |
| M7 | Dashboard (task tree, approvals, kill, costs, registry editor) | ⚪ |
| M8 | Daemonization (CLI, launchd, boot reconciliation) | ⚪ |

## Log

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
