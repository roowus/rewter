# rewter — Progress Log

Newest first. Every milestone/behavioural change gets an entry in the same commit.

## Phase 1 milestones

| # | Milestone | Status |
|---|---|---|
| M0 | Repo scaffold + docs skeleton + CI + public repo | 🟡 in progress |
| M1 | Shared contracts + DB (entities, state machines, drizzle schema, event bus) | ⚪ |
| M2 | Provider adapters + contract test suite | ⚪ |
| M3 | Pass-through router + OpenAI endpoint + SSE + cost recording | ⚪ |
| M4 | Registry + capability cards + digest renderer | ⚪ |
| M5 | Orchestrator + tier-1 fan-out + steering/handoff/cancellation | ⚪ |
| M6 | Tier-2 agent loop + approval gates + workspaces | ⚪ |
| M7 | Dashboard (task tree, approvals, kill, costs, registry editor) | ⚪ |
| M8 | Daemonization (CLI, launchd, boot reconciliation) | ⚪ |

## Log

### 2026-08-27 — M0: project born

- Design finalized (see [ARCHITECTURE.md](ARCHITECTURE.md)): OpenAI-compatible router +
  AI-controlled orchestration via `auto/orchestrator` pseudo-model, 3-tier worker ladder,
  approval gates, capability-card registry, local daemon + SQLite.
- Monorepo scaffolded: pnpm workspaces (`shared`, `server`, `cli`, dashboard app slot),
  strict TS, Biome, vitest, CI workflow.
- Name **rewter** chosen; verified free on npm and GitHub.
