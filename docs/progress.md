# rewter — Progress Log

Newest first. Every milestone/behavioural change gets an entry in the same commit.

## Phase 1 milestones

| # | Milestone | Status |
|---|---|---|
| M0 | Repo scaffold + docs skeleton + CI + public repo | ✅ 2026-08-27 |
| M1 | Shared contracts + DB (entities, state machines, drizzle schema, event bus) | ✅ 2026-08-27 |
| M2 | Provider adapters + contract test suite | ⚪ |
| M3 | Pass-through router + OpenAI endpoint + SSE + cost recording | ⚪ |
| M4 | Registry + capability cards + digest renderer | ⚪ |
| M5 | Orchestrator + tier-1 fan-out + steering/handoff/cancellation | ⚪ |
| M6 | Tier-2 agent loop + approval gates + workspaces | ⚪ |
| M7 | Dashboard (task tree, approvals, kill, costs, registry editor) | ⚪ |
| M8 | Daemonization (CLI, launchd, boot reconciliation) | ⚪ |

## Log

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
