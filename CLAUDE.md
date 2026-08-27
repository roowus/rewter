# rewter — agent instructions

## DOCS RULE (mandatory)

Every commit/PR that changes behaviour MUST update the relevant docs **in the same
commit/PR**:

- `docs/ARCHITECTURE.md` — the living design source of truth. Any change to routing,
  orchestration, entities, lifecycles, API surface, adapters, or safety gates updates it.
- `docs/progress.md` — add a dated log entry; keep the milestone board current.
- `README.md` — keep the pitch, status, and dev commands accurate.
- Larger design decisions get a doc in `docs/design/` and a link from ARCHITECTURE.md.

No behavioural change lands with stale docs. This is enforced, not aspirational.

## Commands

```sh
pnpm install         # bootstrap
pnpm build           # pnpm -r build (topological)
pnpm test            # pnpm -r test (vitest)
pnpm typecheck       # tsc --noEmit everywhere
pnpm lint            # biome check .
pnpm lint:fix        # biome check --write .
```

## Conventions

- TypeScript strict, ESM only (`"type": "module"`), Node ≥ 22, pnpm 10 workspaces.
- All cross-boundary types (entities, events, API payloads) live in `@rewter/shared` as
  zod schemas; server and dashboard import the same schemas. Never duplicate a contract.
- Entity state changes go through the lifecycle guards in `shared` (`assertTransition`) —
  no ad-hoc status writes.
- LLM-produced JSON (tool args, capability cards) is always zod-parsed defensively.
- API keys are referenced by env var *name* (`apiKeyRef`) — never store raw keys in the DB
  or commit them.
- Tests: vitest; provider adapters are tested via the shared contract suite with msw
  fixtures; orchestrator logic via FakeProviderAdapter/ScriptedModel. No real keys or
  network in CI.
- Commit green work as you go; small focused commits.
