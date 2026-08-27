# rewter — Progress Log

Newest first. Every milestone/behavioural change gets an entry in the same commit.

## Phase 1 milestones

| # | Milestone | Status |
|---|---|---|
| M0 | Repo scaffold + docs skeleton + CI + public repo | ✅ 2026-08-27 |
| M1 | Shared contracts + DB (entities, state machines, drizzle schema, event bus) | ✅ 2026-08-27 |
| M2 | Provider adapters + contract test suite | ✅ 2026-08-27 |
| M3 | Pass-through router + OpenAI endpoint + SSE + cost recording | ⚪ |
| M4 | Registry + capability cards + digest renderer | ⚪ |
| M5 | Orchestrator + tier-1 fan-out + steering/handoff/cancellation | ⚪ |
| M6 | Tier-2 agent loop + approval gates + workspaces | ⚪ |
| M7 | Dashboard (task tree, approvals, kill, costs, registry editor) | ⚪ |
| M8 | Daemonization (CLI, launchd, boot reconciliation) | ⚪ |

## Log

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
