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
| M6a | Workspace sandbox (`classify`, symlink-resolved containment) | ✅ 2026-08-28 |
| M6b | Approval choke point (`approvals.require`, read-only allowlist) | ✅ 2026-08-28 |
| M6c | Tier-2 tool surface + executor (10 tools, every one gated) | ✅ 2026-08-28 |
| M6d | Tier-2 agent loop (`runTier2Worker`) + its system prompt | ✅ 2026-08-28 |
| M6e | Tier-2 engine wiring (tier dispatcher, per-task gate, feed lines) | ✅ 2026-08-28 |
| M6f | Approval routes + in-band `approve`/`deny` twin | ✅ 2026-08-28 |
| M6g | `send_to_worker` (engine-side inbox, turn-boundary injection) | ✅ 2026-08-28 |
| M6 | *acceptance: a gated shell command approved by curl mid-task* | ✅ 2026-08-28 |
| M7a | The fold: `EventEnvelope[]` → task tree, in `shared` | ✅ 2026-08-28 |
| M7b | `WS /internal/ws` — replay then live, over one socket | ✅ 2026-08-28 |
| M7c | Dashboard app: store, task tree, approval cards | ✅ 2026-08-28 |
| M7d | Kill: `POST /internal/tasks/:id/cancel` + the button | ✅ 2026-08-28 |
| M7e | Costs: `GET /internal/costs` + the spend panel | ✅ 2026-08-28 |
| M7f | Registry editor: models/card CRUD routes + the panel | ✅ 2026-08-29 |
| M7 | *acceptance: approve from the browser while the stream runs* | 🟡 built, not yet run live |
| M8a | Boot reconciliation: `running` → `interrupted`, before the socket opens | ✅ 2026-08-29 |
| M8b | Pidfile + `rewter status` / `rewter stop` (liveness by health probe) | ✅ 2026-08-29 |
| M8c | `~/.rewter/env`, launchd plist, `rewter logs`, `rewter gc` | ✅ 2026-08-29 |
| M8 | *acceptance: README walkthrough verbatim; survives a reboot* | 🟡 built, not yet run live |

## Log

### 2026-08-29 — M8c: living under launchd

launchd starts a process with a nearly-empty environment. No `~/.zshrc` has run, so no
`ANTHROPIC_API_KEY` is exported and `PATH` is not something to rely on. Everything in this
milestone follows from that one fact.

**`~/.rewter/env`.** Keys are referenced by variable *name* everywhere in rewter, which
works from a shell and not at all at login; a daemon started by launchd would come up with
every provider disabled and no obvious reason why. So: one file of `KEY=value` lines, read
at boot and merged **under** the real environment, so `ANTHROPIC_API_KEY=sk-x rewter start`
still overrides for one run and a shell that already exports a key does not have it
silently replaced by a stale one. It is separate from `config.json` — that is the file
people paste into issues — and being the only place a raw key sits on disk, a mode with any
group or other bit set is reported at boot. A **warning, not a refusal**: refusing would
leave a login daemon dead with its explanation in a log the user does not yet know how to
read. Malformed lines are named by line number and never echoed, since the thing on a
malformed line in this file is quite likely to be half of a key.

**The plist.** `rewter install-service` renders
`~/Library/LaunchAgents/com.roowus.rewter.plist` with an absolute `process.execPath` and an
absolute CLI path, and creates the log directory first, because a `StandardOutPath` launchd
cannot open makes the job fail with nowhere to say so. It carries **no
`EnvironmentVariables` key** — `launchctl print` reads a plist back to anyone who asks,
which is exactly why the keys live in a file whose mode we can check; there is a test
asserting the rendered XML contains neither `EnvironmentVariables` nor `API_KEY`.
`KeepAlive` is conditional on `SuccessfulExit: false`, so a crash restarts and `rewter stop`
is not undone a second later, with `ThrottleInterval: 10` to make a config error a slow
retry rather than a spin. And it **writes the file and then stops**, printing the `bootout
… || true` / `bootstrap` pair rather than running them: `bootstrap` on a loaded label fails
with a bare code, and a tool holding your API keys should not shell out on your behalf. An
existing plist that differs is not clobbered — exit 1 naming `--force`.

**`rewter logs`** reads the two files launchd writes rather than talking to the daemon,
because the case it exists for is a daemon that is *not* running. Both streams are merged by
timestamp with a **stable** sort, so a stack trace stays under the error it followed; "it
printed warnings and then died" is only legible merged, and launchd will only ever give us
two files. pino JSON renders as level + message, non-JSON passes through untouched, and
fields longer than 80 characters are dropped — a log reader is not the place to discover a
leaked key. No logs yet is exit 0: before the first boot neither file exists.

**`rewter gc`** collects finished tasks with their work items, runs, approvals, events and
workspaces, in one transaction, children first. Two things it refuses to do: collect a
**cost record** (nullable `task_id`, no foreign key, on purpose — dropping a transcript is a
storage decision, dropping its price destroys the answer to "what did I spend in March"),
and collect an **unfinished task**, whatever its age. `--vacuum` is opt-in and skipped on a
dry run.

- 149 tests added across the four modules and the CLI (env file 23, gc 24, launchd 17,
  logs 22, plus 17 CLI wiring tests taking that package to 46).

### 2026-08-29 — M8b: a pidfile is a claim, not a fact

`rewter start` runs in the foreground, so `rewter stop` in another terminal has nothing to
go on but what the running process left on disk. That file — `~/.rewter/rewter.pid`, or
`--pidfile` / `REWTER_PIDFILE` — is the whole mechanism, and the thing worth being careful
about is that **it lies**: the daemon was killed before it could clean up, the machine
rebooted and the file survived, or, worst, the pid was *reused* by an unrelated process.
Signalling a pid because a file mentions it is how a stop command kills a stranger.

So nothing here trusts the pid. The file records the **URL** the daemon bound, and liveness
is decided by asking it: a `GET /internal/health` that answers `status: "ok"` is proof that
rewter is the thing listening, which is the question actually being asked. The pid is used
only after that passes, and only to deliver the signal. Two ordering rules fall out. The
file is written **after `listen`** — under port 0 there is no true address until the socket
is bound, and a file saying `:0` is exactly the one `stop` could not probe. And it is
removed **first** in `stop()`: from the moment we have decided to stop, its claim is false,
and a `status` racing the drain should read "not running" rather than point at a closing
socket. Write-then-`rename` makes the commit atomic, so a reader never sees half a pid it
might go on to signal.

Four states, named rather than collapsed into "running / not running", because they call
for different actions: `stopped` (no usable claim — a truncated or wrong-shaped file counts
as none), `stale` (the URL does not answer — the file is removed and the fact printed,
because it means the last shutdown was not graceful and this boot's reconciliation has
interrupted rows to show), `unreachable` (**something answers, but not as rewter** — refuse
to signal), and `running` (health answered, and its payload rides along so `status` prints
provider/model counts without a second request).

`stop` sends **SIGTERM only, with no escalation**. Shutdown drains in-flight SSE streams;
killing harder mid-drain leaves the client parsing a truncated event *and* leaves rows for
the next boot to close. It waits on the health probe rather than the pid — the stronger
check, and the one that answers what the caller wants to know: the port is free. A drain
still running after 10s is reported for a human to decide, not papered over on a timer.
`start` probes the same way and refuses over a running daemon, because the alternative
failure is `EADDRINUSE`, which reads as a port problem rather than "rewter is already
running".

`startDaemon` writes a pidfile only when told to; every test and every library embedding
omits it, since three port-0 daemons must not leave three contradicting claims on disk.
Fifty-one tests: the file's malformed shapes, the four states, the refusal to signal an
`unreachable` port, SIGTERM-then-poll with injected `kill`/`sleep`/`fetch`, the grace
timeout, uptime formatting, and — at the daemon level — that the recorded URL is the one
actually bound and answering, and that it is gone after `stop()`.

### 2026-08-29 — M8a: boot reconciliation, and why `interrupted` is not `failed`

A daemon killed with `kill -9` leaves rows saying `running`, because the code that would
have written a terminal status died with the process. Every boot now sweeps the non-terminal
rows and closes them — in `startDaemon`, **before `listen`**, so that no request and no
dashboard socket ever observes a task claiming to be running with nothing behind it.

The decision that took the thinking was which status to write. `failed` was there already
and would have cost nothing. But a failure is a *judgement* — something tried and did not
work — and nothing judged these. An operator scanning history six weeks later would read
"the model got it wrong" where what happened is that the machine went away. Worse, phase-2's
learned stats key off exactly that success/failure distinction, so every reboot would
quietly teach the router that some model is unreliable. A new terminal state costs one enum
member per machine and keeps the record honest.

Not resuming was the other choice, and it is the conservative one. A task's liveness is
entirely in memory: its `AbortController`, the promises parked on pending approvals, the
open upstream sockets. Replaying the event log would re-run side effects that already
happened — a tier-2 worker killed mid-`shell` has an unknown amount of its command already
applied to the filesystem. Marking interrupted keeps the whole history for the fold and
leaves it to the user whether to ask again.

Three properties the sweep is built around, each with a failure it prevents:

- **Deepest-first** (runs → work items → tasks), so a parent is never closed while a child
  is still open — anything reading the tree mid-sweep sees a consistent shape.
- **Through the ordinary lifecycle-guarded repo methods**, so each write emits its
  `status_changed` event. Interruption becomes part of the replayable history rather than a
  task that simply stops updating.
- **Idempotent by construction** — it only touches non-terminal rows and `interrupted` *is*
  terminal. This runs on *every* boot including the ones right after a clean stop; were it
  not a no-op the second time it would throw on a terminal row instead of starting the
  daemon.

Pending approvals on a closed task resolve to `expired`. The promise waiting on them is
gone; left pending they would sit in the dashboard forever inviting a click that resolves a
row nobody is listening to.

One incidental cleanup that was really the risky part of the change: `repos.ts` kept three
hand-written arrays of terminal statuses, used to decide when to stamp `finishedAt`. Adding
a fourth terminal state to `shared` would have left all three quietly disagreeing, and the
symptom would have been an `interrupted` row whose `finishedAt` stayed null — a bug you find
by noticing an absence. They are now `isTerminal(MAP, status)` reads off the lifecycle maps,
which is already how `fold.ts`, the events route and the dashboard do it.

Twenty-four tests: eleven on the sweep, one at the daemon level booting twice over the same
database file and asserting the earlier events survive with the interruption *appended*, and
the lifecycle sweep's terminal lists extended.

### 2026-08-29 — the shell was hard-coded to zsh, and CI had been telling us since M6c

Eleven tests have been failing in Actions since M6c and passing on this laptop, which is
the exact shape of a bug worth chasing rather than a flaky runner. `shell` spawned
`zsh -c` by name. `ubuntu-latest` has no zsh, so every command came back
`could not run the command: no such file or directory` — and that is not a CI-only
problem: rewter on any stock Linux host could not run a single worker command, and the
message a model would read reports it as *its own command being wrong* rather than as the
daemon being unable to run commands at all. The worst kind of error text: it points the
reader away from the fault.

`SHELL_PATH` now resolves once at import — zsh, then bash, then `/bin/sh`. zsh stays first
on purpose: this daemon is built for a macOS host where it is the login shell, and a
worker's command should behave the way the same command behaves in the user's terminal.
`$SHELL` is deliberately not consulted, because it can name something that is not
POSIX-compatible and the tool's contract with the model — pipes, redirects, `&&` — is a
Bourne-family one.

The new test asserts the resolved path exists. That is the test that was missing: without
it the symptom was eleven unrelated-looking shell failures, each blaming the command in it,
rather than one named failure saying the daemon has no shell to run.

Lesson recorded because it will recur: **a green local run and a red CI run is a claim
about the difference between two hosts, and the difference is usually real.** Two
milestones shipped over a red board on the assumption it was an environment quirk.

### 2026-08-29 — M7f: the registry editor, or: making one rule visible

Five `/internal` routes (models list-with-cards, create, patch, delete, card-overrides PUT)
and the panel that drives them. 1127 tests green (from 1063). Closes the last third of
[#6](https://github.com/roowus/rewter/issues/6).

Almost every decision here follows from one rule that already existed and was previously
only enforceable by reading `registry/sync.ts`: a row whose facts came from a provider's
catalog is `synced`, and the next `sync-models` refreshes it wholesale. That makes a
hand-corrected price on a synced row a *countdown* rather than an edit — it survives until
the next sync silently restores the upstream number, and the only symptom is a cost report
that quietly stops matching the invoice. So editing a fact promotes the row to `manual`,
and the editor's real job is making that legible before it happens: a `source` column, and
a warning that names the model *while the change is still on screen* and still attributable
to the field you just typed in. A promotion nobody was told about is a model that stops
tracking its provider's prices, discovered when a price change never arrives.

Three consequences fall out of that rule, and each is a test:

- **`enabled` is not a fact.** Sync never flips it, so it must not promote. It is a separate
  button sending `{enabled}` alone rather than a form field, because bundled with the facts,
  switching a model off would take its prices off the sync path forever.
- **Comparison is by value, not presence.** `applyModelPatch` returns `undefined` when a
  patch matches the row, so a form that POSTs every field on every Save cannot promote a row
  for the sin of having been opened. The route answers `{changed: false}`.
- **`changed: false` is reported, not swallowed.** The panel says "no change", never "saved".
  The usual way to reach it is a form showing values someone else already saved; a user told
  "saved" walks away believing a price is fixed.

Two smaller things worth writing down. Model ids are slugs containing slashes, and Fastify's
`:id` named param stops at `/` — so these are trailing-wildcard routes read via `params["*"]`,
which is also why the card route is `/internal/card-overrides/*` rather than
`/internal/models/:id/card-overrides`: a wildcard has to be the last segment. Client-side the
id is deliberately *not* escaped, since a `%2F` arrives literal and matches no model. And
DELETE removes the capability card first because `capability_cards.modelId` has a foreign key
while `cost_records.modelId` does not — cost history keeps naming a deleted model on purpose.

The route tests spent an hour looking like a routing bug: fourteen 500s reading `Cannot read
properties of undefined (reading 'safeParse')`. The cause was a stale `@rewter/shared` build —
consumers resolve it through `exports` → `dist/`, so `ModelPatchSchema` was genuinely
`undefined` at runtime while the source in front of me was correct. `pnpm build` in `shared`
turned 14 failures into 0. Recorded as a sixth sighting of [#3](https://github.com/roowus/rewter/issues/3):
the gate is `pnpm build`, and `pnpm test` alone proves less than it looks like it does.

### 2026-08-28 — M7e: costs — the one panel that fetches

`GET /internal/costs?groupBy=model|day|task&since=&until=&tz=` plus the spend panel above
the task tree. 1063 tests green (from 1025). Closes the second third of
[#6](https://github.com/roowus/rewter/issues/6).

The interesting decision was against the dashboard's own architecture. The store has no
fetching layer and no cache, on the principle that the event stream *is* the answer to
"what is happening" — so a costs panel built on the fold needed either a rebuttal or a
redesign. It got the rebuttal, on two structural grounds: a `cost.recorded` with
`taskId: null` (every plain `/v1` pass-through — most of a router's traffic) is an
orphaned event the fold drops, so a folded costs panel would report a daemon's
orchestrated spend while its real bill was pass-through; and a fold holds only what the
socket replayed, so a client connecting today would report a week-old daemon's spend as
this morning's. The panel fetches — but the **aggregation is shared code**
(`summarizeCosts` in `@rewter/shared`), so the endpoint and the page cannot disagree.
Only the row supply differs. The exception is fenced in ARCHITECTURE.md so it cannot
become a precedent.

Inside `summarizeCosts`, the load-bearing idea is the **initiator/worker split**: every
total and every bucket carries `initiatorCostUsd` (spend with `workerRunId === null` —
the orchestrator's own planning tokens) beside `workerCostUsd`, always summing to
`costUsd`. A single total hides the failure the whole router exists to catch: an
initiator spending more *deciding* than its cheap workers spend *doing* reads as a
perfectly healthy number. There is a test for the case that would otherwise pass
vacuously — one model used both as initiator and as worker, where a top-level-only
split would look right and read wrong.

Aggregation is TypeScript, not SQL, deliberately: grouping in the query would be a
second implementation of the split that drifts from the shared one the first time the
definition changes. `Repos.allCosts(window)` pulls whole rows (half-open, so adjacent
windows tile); `summarizeCosts` computes the answer once where both sides' tests point
at it. Day bucketing goes through `Intl` with the `en-CA` locale — its short date
*is* ISO order, and fixed-offset arithmetic misbuckets an hour of every DST-shifted
day. The zone is echoed in the response so the panel labels its day column with the
zone that actually shaped it.

Route hardening: unknown `groupBy` → 400 (defaulting would answer a question the caller
did not ask, and the numbers would look plausible); bad `tz` pre-flighted through
`Intl.DateTimeFormat` → 400 rather than a 500 thrown from inside the bucketer;
non-numeric `since`/`until` → 400. The panel keeps the last good numbers on a failed
refetch — it refetches on every socket event, so a transient failure is routine, and a
panel that blanked would read as "spent nothing" — and schema-parses the body, because
`undefined` formatted as a dash is the one wrong answer that looks like good news.

Test counts: shared `costs.test.ts` 13, server `app.costs.test.ts` 9 + one new
`repos.test.ts` case, dashboard `costs.test.ts` 8 + `CostsPanel.test.tsx` 7.

### 2026-08-28 — M7d: kill, and the question of who writes the row

`POST /internal/tasks/:id/cancel`, plus the button in the task header. 1025 tests green
(from 929). Closes the first third of [#6](https://github.com/roowus/rewter/issues/6).

The route is four lines of intent and one real hazard. A live orchestration's driving stream
**already** writes its own terminal row — `transitionTask(…, "cancelled")` and a
`⊘ task cancelled (spent …)` line. A route that wrote that row too would race it, and because
`cancelled` is terminal in `TASK_TRANSITIONS` the loser gets `IllegalTransitionError:
cancelled → cancelled` thrown into a generator with no catch anywhere above it. So
`Orchestrator.cancel()` **only** aborts the task's controller and touches no tables; the
stream finishes its own sentence.

That gives three outcomes, reported rather than flattened into "cancelled":

- **live** → `200 {aborted: true}` — the tree is collapsing; the row lands a moment later.
- **no session** → `200 {aborted: false}` — a task from before a restart, whose `running` was
  a lie on disk. The route settles it here. Same honesty `resumedWorker` gives approvals: "I
  cut off your workers" and "I tidied a stale row" are different things to have done.
- **already terminal** → `409` — the double-click, or the task finishing between render and
  click. Refusing is how the state machine is kept from seeing a transition that would throw.

The live-kill test hangs the worker's upstream call until its signal aborts, which is the only
state where a kill is distinguishable from a no-op — verified by mutation: deleting
`session.abort()` from `cancel()` hangs the test rather than passing it. A worker that had
already reported would have left nothing to collapse.

The button reuses the approval card's rule — no optimistic hiding, no recolouring the status,
buttons back only on failure — and is absent entirely on a terminal task, since offering it
would be offering the 409.

### 2026-08-28 — known gaps moved into the issue tracker

A survey of the whole tree turned up eleven things worth tracking, and they were previously
scattered across code comments, this log, and nobody's memory. They are now
[issues on the repo](https://github.com/roowus/rewter/issues). Two of them are the same bug:

- **[#1] `steering.received` and [#2] `worker_run.progress` are folded but never emitted.**
  Both have a schema, a fold handler and a fold test; neither has a producer anywhere in
  `packages/server/src`. Steering goes straight into the transcript (`engine.ts:1078`) and a
  worker's progress note goes straight to the SSE feed (`engine.ts:466`) — the event log sees
  neither. M7c is what made this visible: the dashboard now renders both arrays, and both are
  always empty. The real cost is durability, not display — a reconnecting client replays the
  log, so everything a worker said before the reconnect is gone, as is any evidence that a
  steering message landed.
- **[#3] vitest doesn't typecheck.** Fifth occurrence, twice in the M7c session alone. CI has
  always caught it (`build` runs before `test`); the cost is entirely local. Proposed fix is a
  single `pnpm check` gate rather than asking a human to remember two commands.
- **[#4] `parseOpenAi` asserts capability facts the catalog never reported.** A plain
  OpenAI-compatible `/models` response is an id list, but the parser writes
  `{tools: true, vision: false, …}` into the registry, where the digest presents it to the
  initiator as fact. `tools: true` on a model without tools burns a worker run; `vision: false`
  on one that sees removes the only correct choice for an OCR subtask. Hits Ollama and LM Studio
  hardest — enrichment can only correct models OpenRouter also lists.
- **[#5] The Anthropic adapter demotes a non-leading system message to a user turn**, silently.
  Structurally forced (the API has one system slot), but a mid-conversation "respond only in
  JSON from here on" delivered as a user turn is weaker than it was written to be, and reachable
  from any OpenAI-dialect client that injects a system reminder.
- **[#6] the M7 remainder** (kill, costs page, registry editor), **[#11] the M8 CLI stubs**, and
  four deferred-by-design limits worth watching rather than fixing now: **[#7]** `send_to_worker`
  cannot reach tier 1, **[#8]** the digest budget is a char count, **[#9]** streams are
  unretryable after the first chunk, **[#10]** `web_search` is specified but unimplemented.

Two suspected findings did **not** survive checking, which is worth recording so nobody
re-files them: the `@fastify/websocket` root-route trap *does* have a regression guard
(`app.ws.test.ts` uses a real socket, so a route served as a plain GET fails the handshake and
the test), and `sync-models` already warns when `--provider` scopes OpenRouter out of enrichment
(`cli/src/index.ts:145`). There are also no `TODO`/`FIXME` comments and no skipped tests
anywhere in the tree.

### 2026-08-28 — M7c: the dashboard itself, with nothing to fetch

`apps/dashboard` exists now: Vite + React 18 + zustand, five source files and 41 tests. It has
no data-fetching layer at all, and that is the design rather than an omission. The daemon's
answer to "what is happening" *is* the event stream; the fold that turns it into a task tree
already lives in `shared` and is already tested there. A REST layer beside it would be a second
answer to the same question, and the one on screen would be the one nobody tested.

So the store is socket lifecycle and nothing else — connect, subscribe from `fold.lastSeq`,
fold what arrives, reconnect without losing our place. Four decisions worth keeping:

- **Identity, not deep-equality, gates the render.** `applyEvent` returns the *same* state
  object for an event at or below `lastSeq`, which is exactly the replay/live overlap and the
  common case rather than a rare one. `if (after !== before) set(…)` means a duplicate costs
  nothing; comparing by value would re-render the whole tree on every one of them.
- **A dropped socket does not blank the tree.** Status goes to `reconnecting` and the fold stays
  on screen, because a two-second blip that clears the view looks exactly like a daemon that
  lost the task. The resubscribe then asks for `afterSeq: lastSeq` — on a long-lived daemon,
  refolding from zero every time a laptop lid closes is the entire history, every time.
- **Backoff is capped** (250ms → 5s). A dashboard left open on a sleeping laptop retries for
  hours; a fixed delay is a tight loop against a daemon that is down for the afternoon.
- **An unparseable frame is dropped, not fatal.** That is the daemon being newer than the
  bundle. Folding a half-shaped envelope would corrupt the tree instead; the feed keeps working
  and the status bar says so.

The approval card is the milestone's acceptance criterion, and its one real rule is that it
does **not** hide itself on click. The answer travels to the daemon, becomes `approval.resolved`,
comes back down the socket and folds — and *that* removes the card. Hiding optimistically would
leave the UI claiming an approval the daemon rejected. On failure the buttons come back (a dead
daemon is retryable); on success they stay disabled, because the card is about to be folded away
and buttons that return for a frame invite a second click on a settled row, which is a 409.

Costs render as the split, not the total: `$0.0070 total — $0.0049 planning`. "The planner cost
more than the work" is the question this whole design exists to answer and a single number hides
it. Relatedly, `usd()` keeps four decimals below a cent — a `$0.00` beside every worker row makes
the feature look free right up until the bill.

Two build-gate notes, both of which cost time:

- `vite.config.ts` needs `defineConfig` from **`vitest/config`**, not `vite`. The usual
  `/// <reference types="vitest" />` never loads under an explicit `types` list in tsconfig, so
  the `test` block typechecks against a `defineConfig` that has never heard of it. Tests were
  green throughout; `pnpm build` was not. Fourth time this distinction has bitten.
- Vite pinned to **^5.4.11**, not 6. vitest 2 bundles vite 5's types, and two vite majors in one
  workspace makes `@vitejs/plugin-react`'s `Plugin` incompatible with `PluginOption` under
  `exactOptionalPropertyTypes` — forty lines of type error for a version skew.

Not built yet, and so M7 stays amber: kill (needs `POST /internal/tasks/:id/cancel`), a costs
page (needs `GET /internal/costs?groupBy=`), and the registry editor (needs the models CRUD
routes). All three are server work first. Workspace is 5 projects now: 1007 tests.

### 2026-08-28 — M7b: `WS /internal/ws`, and the seam between replay and live

The fold needed a feed. `GET /internal/events?afterSeq=` could always hand over history; what
it cannot do is keep a dashboard current without polling, and polling is the thing that makes
a task tree jump instead of move. So one socket does both halves, and the interesting part is
the order they happen in.

`{type: "subscribe", afterSeq?, taskId?}` → replay everything after `afterSeq` → `ready` →
*then* attach the live listener. Attaching first is the obvious implementation and the wrong
one: an event appended mid-replay would arrive ahead of the replay rows that precede it, and
nothing downstream can repair a reordering. Replay-first turns that same race into a
*duplicate*, which the fold's `seq <= lastSeq` guard already drops and `applyEvent` already
answers with the identical state object. Redelivery is handled for free; reordering is not
handled at all. The test that pins this appends a 21st work item during the replay of 20 and
asserts the received `seq`s equal their own sort — it fails on an attach-first implementation
and passes on this one, which is the only reason it exists.

Three smaller decisions, each with a test:

- **`ready` is a frame, not a silence.** It carries the resume `seq`, a `replayed` count, and a
  nullable `taskId`. An already-current dashboard replays nothing — and still has to leave its
  loading state and still needs a seq to reconnect with. `replayed: 0` says "you are current";
  no frame at all says "something may be broken", and those are different facts.
- **Re-subscribing replaces the previous subscription.** A client that changes its filter would
  otherwise get every event twice, forever. The test waits 50 ms after a single append to give
  a leaked listener time to show itself.
- **A bad message costs an `error` frame, not the connection.** Malformed JSON and a schema
  failure both leave the socket open and usable. A dashboard that mistypes one subscription
  should see why, not lose its connection and retry the same thing forever.

The contract is `shared/src/socket.ts` with 10 tests of its own — mostly of what gets
*rejected*, since these schemas are all that stands between a mistyped message and the event
bus. A negative or fractional `afterSeq` is refused rather than passed through: it cannot have
come from a fold, and silently replaying from the top would look like a slow reconnect.
`approve`/`deny` are deliberately not client messages; they stay REST POSTs, because they are
actions with outcomes worth a status code.

One trap worth writing down, because it is invisible when you hit it: `@fastify/websocket`
recognizes `websocket: true` through an `onRoute` hook, and `app.register()` is deferred to
boot. A route declared at root level runs its hooks before the plugin loads and is quietly
served as a plain GET — the handshake fails with a non-101 and nothing anywhere logs an error.
The route now lives inside its own `register` scope so it is queued behind the plugin. And
because `app.inject()` cannot speak WebSocket at all, these 9 tests pay for a real ephemeral
port, unlike the rest of the HTTP suite.

Server 694 → 703; shared 232 → 242; 966 across the workspace.

### 2026-08-28 — M7a: the fold, in `shared`, folding one event at a time

`shared/src/fold.ts` reduces an `EventEnvelope[]` to a task tree. Both sides import it, which is
the point: the daemon can fold to answer a question and the dashboard folds a WS replay, and
neither can drift from the other. It is also why `GET /internal/tasks/:id` still does not exist.

The unit is `applyEvent(state, event)` rather than a batch function, because a dashboard's life
is one replay followed by a long tail of single events, and the same state has to survive that
handover. Replay and the live subscription overlap by design, so an event at or below `lastSeq`
returns the *identical* state object — a store can skip the render by identity, and a
re-delivered `cost.recorded` cannot bill twice on screen.

Three things the fold refuses to fake:

- **Labels.** The engine's `w1`/`w2` never enter an event, so the fold re-derives them from
  `work_item.created` order — correct only if it saw every creation.
- **Results.** Transitions carry `{from, to}` and nothing else, so `status`/`updatedAt`/
  `finishedAt` are patched (terminality read from the lifecycle maps, not a second hardcoded
  list) and `resultSummary`/`error` stay `null`. The answer text lives in the response stream.
- **Completeness.** An event for an entity it never saw created increments `orphanedEvents`
  instead of vanishing, and `lastSeq` advances anyway. A mid-stream fold is legitimate; one that
  *looks* complete is not.

Cost splits initiator from workers (`initiatorCostUsd`), because "the planner cost more than the
work" is the question this design exists to answer. Spend naming an unseen run still counts
toward the task total — understating a bill is the one direction that display must not be wrong
in.

18 tests, built on a `seq`-assigning stream builder so inserting an event mid-fixture cannot
silently renumber the ordering contract under test. The load-bearing one is the batch split:
`fold([0,6))` then `fold([6,…))` must deep-equal `fold(all)`, since replay-then-live *is* that
split. Shared 214 → 232; 947 across the workspace.

Two events in the schema, `steering.received` and `worker_run.progress`, are folded but not yet
emitted by the server — tier-2 narrates progress into the SSE feed without appending an event.
The dashboard will show nothing for them until the engine appends; noted here so the gap is a
decision and not a bug report later.

### 2026-08-28 — **M6 acceptance met live**: approve, deny, and the in-band reply

Three runs against a real daemon (:20131, local 9router as a keyless upstream, workspaces in
`/tmp/rewter-m6/ws`), each with the SSE stream open in `curl` while the card was answered from a
second terminal:

- **Approve by curl, mid-task.** `auto/orchestrator` was asked for the kernel version and told to
  delegate. It planned, spawned one tier-2 worker on the *cheaper* `nine/gemini-3-flash`, and the
  worker's `uname -a` parked: `⏸ approval needed — uname -a` with the real `apr_…` id in the feed
  and a `pending` row with `parked: true` in `GET /internal/approvals`. `POST
  /internal/approvals/:id {"approved":true}` returned `resumedWorker: true`, and the same stream
  continued `✔ [w1] done ($0.0047, 38.0s)` followed by the correct Darwin string.
- **Deny, and the worker adapts.** Same shape with `curl -s https://example.com` and a note —
  "no shell network access — use web_fetch". The worker did not retry and did not crash: `· [w1]
  Attempting to fetch example.com using curl` → the card → `· [w1] Fetching example.com using
  web_fetch` → `Example Domain`. The note is the working half; "denied" alone invites a retry.
- **The in-band `approve` reply, adopting a live task.** Re-POSTing the conversation with a
  trailing `approve apr_…` turn and the `x-rewter-task-id` header resolved the card *and* adopted
  the task: the second stream replayed the feed from the event log and then carried on to the
  answer. The **original** stream — still open the whole time — also finished with the same
  answer and its own `[DONE]`, so answering out-of-band does not orphan the client that asked.

Two things only a live run showed:

- **A worker can fail upstream and the initiator just respawns.** `nine/claude-sonnet-4-6`
  returned 403 twice; the feed printed `✖ [w1] failed: 403 … (after 2 attempts)` and the
  initiator spawned `w2` on a different model unprompted. Worth noting for anyone timing these
  runs: the second worker's card appeared ~90s in, well after the first attempt's retry budget.
- **`GET /internal/tasks/:id` does not exist.** The internal surface is `health`, `models`,
  `providers`, `events`, and `approvals` (+ the resolve POST); per-task detail is a fold over
  `GET /internal/events?taskId=…`, which is what the dashboard will do in M7. ARCHITECTURE's API
  section lists routes not yet built — they are M7's, not missing M6 work.

### 2026-08-28 — M6g: correcting a worker that is already running

The initiator could spawn, wait, read and cancel; the one thing it could not do was tell a
worker it was wrong. `send_to_worker({label, message})` closes that: a **running tier-2**
worker gets a message it reads at its next turn boundary.

- **The queue belongs to the engine, not the runner.** `spawn` returns a label immediately and
  the work may still be behind the concurrency limiter, so a message can be aimed at a worker
  whose runner does not exist yet. `Session.spawn` closes over an `inbox: string[]`, shares the
  same array with the `Worker` record, and hands the runner a puller —
  `inbox: () => inbox.splice(0)` on `WorkerContext`. The drain is destructive on purpose: a
  message read twice is a worker nagged twice, and the nag grows the transcript it is billed for
  on every pass. The loop asks on **every** turn rather than once at the top, or a message sent
  mid-run would never land.
- **Injection happens at a turn boundary and nowhere else**, prefixed `[FROM THE ORCHESTRATOR] `.
  Mid-turn would leave the model an unanswered tool call, which several providers reject
  outright. The prefix is one exported constant (`ORCHESTRATOR_MESSAGE_PREFIX`) shared by the
  loop that stamps it and the tier-2 prompt that explains it — a worker meeting the marker
  without the explanation reads a user turn its own prompt insists cannot exist.
- **Three refusals, and the order matters.** Unknown label (naming the labels that do exist),
  already-finished worker (pointing at `get_result`), tier-1 target. All three come back as tool
  *results*, never throws. The tier-1 case is structural rather than an omission — one model
  call has no point at which it could read anything — so the refusal names tier 2 as the thing
  to use when steering is expected. The ordering is load-bearing in the tests too: the default
  stub runner resolves at once, so the tier-1 test needs a worker that stays running or the
  already-finished branch answers first and the assertion passes for the wrong reason.
- **The delivery is in the user's feed**, as `⇄ [w2] told: …`. A worker changing course mid-run
  is only explicable if the instruction that caused it is visible in the same place.
- The happy-path test makes the worker *prove* delivery: its runner polls the inbox on a real
  timer and reports `heard: <messages>` as its summary, so the assertion can only pass if the
  engine actually delivered. A runner that read its inbox once would pass vacuously, since the
  message arrives on a later initiator turn.

`ORCHESTRATOR_TOOLS_VERSION` and `ORCHESTRATOR_PROMPT_VERSION` are both 3. 929 tests green.
This was the last code in M6; the acceptance ran the same day (entry above).

### 2026-08-28 — M6f: answering the card

M6e could raise an approval; nothing could answer one. A worker parked and stayed parked. The
gate now has three entrances and one resolution path behind them: `POST /internal/approvals/:id`
(dashboard buttons and `curl`), `GET /internal/approvals[?taskId=]` to see what is waiting, and
`approve <id>` / `deny <id>: why` typed as the next user turn.

- **The row/promise split is the whole problem.** An approval is a row in SQLite *and* a promise
  a worker is parked on; only the row is reachable from HTTP. Settling it alone looks exactly
  like success and leaves the worker hung forever. So the resolver tries the live gate first
  (`approvalsFor(taskId)`) and writes the row directly only when there is no session — a
  finished task, or one from before a restart.
- **`resumedWorker` is reported, not hidden.** "Approved, but nobody was waiting" is a different
  fact from "approved and the worker resumed"; a caller told the first knows to go look. Same
  fact per card as `parked` on the list route, which is what `Approvals.isParked` exists for —
  distinct from the row being `pending`.
- **404 vs 409 vs 400.** Never seen, already settled, malformed body. The middle one is a race
  the caller lost, not a mistake it made, so it is not an error the dashboard should shout about.
- **The parser is conservative on purpose** (`orchestrator/steering.ts`). Consuming a line hides
  it from the initiator, so "please approve whichever you think is right" must survive as
  steering. A line is a command only if it is `approve`/`deny`/`reject` + ids or `all`, and one
  message can be both — only the remainder is injected.
- **`approve all` is scoped to that conversation's task.** Typing it into one chat must not clear
  another's cards.
- **A denial is a tool result, not a throw**, carrying the note: `command not run: denied by the
  user: use the fixture instead`.

The tests (`http/app.approvals.test.ts`, 12) run a **real tier-2 worker** — no stub runner —
because `Session.runnerFor` returns an injected runner for *every* tier, so a test that stubs the
worker never opens a workspace, never builds a gate, and asserts against a `null` that always
agrees with it. They assert on disk: the shell command's file does not exist before the approval
and does after, and never appears at all on a denial. 742 tests green.

### 2026-08-28 — M6e: tier 2, spawnable

The loop existed; nothing could ask for it. `spawn_worker` refused every tier above 1, so
M6a–M6d were four green modules the initiator had no way to reach. Now the engine picks a
runner **by tier** (`Session.runnerFor`): tier 1 to `runTier1Worker`, tier 2 to a runner bound
to the task's workspace and approval gate, and only tier 3 still comes back as a refusal —
worded to point at tier 2 rather than to say "not yet", since a refusal the model can act on
costs one turn.

- **The workspace and gate open on the first tier-2 spawn, not in the constructor.** Opening a
  workspace mkdirs a directory, and most tasks are pure tier-1 fan-outs that would each leave
  an empty one behind.
- **Both are per-task**, shared by every tier-2 worker on it: two workers write to the same
  directory, and a denial one collected must not be re-asked by the other.
- **The runner resolves before the concurrency limiter**, so a queued worker's gate is
  reachable over HTTP from the moment it is spawned, not from whenever a slot frees up.
- **`Orchestrator.sessions` + `approvalsFor(taskId)`** is what makes the approval route
  possible at all: the pending row is in the database, but the *promise the worker is parked
  on* only exists in memory, so resolving the row alone would leave it waiting forever. `null`
  for a finished or pre-restart task is the honest answer, not a failure.
- **Two teardown paths, because there are two failure modes**: the stream's `finally` for
  normal completion, and an `abort` listener for a `start()` whose stream is never pulled (that
  `finally` never runs). `dispose` also cancels the gate — aborting a worker's signal does not
  wake one parked on a promise, and it would hold the stream open for a click never coming.
- **An explicit `runWorker` overrides every tier**, not just tier 1. A dispatcher that ignored
  the test seam for tier 2 would send engine tests at the real filesystem.

Two new feed lines come from *inside* a worker: `· [w2] <note>` for its own
`report_progress`, labelled because four concurrent loops make an unlabelled note meaningless,
and `⏸ approval needed — …` carrying the **full approval id** rather than the label, since the
REST route, the in-band reply and the audit row all address it by id.

Config gained `workspacesDir` (default `~/.rewter/workspaces`), deliberately *not* under
`dbPath`: a worker creative with a relative path should not be able to reach the database file.
The engine's own fallback is under `tmpdir()`, so an embedder that configures nothing cannot
have a worker write into a real home directory.

One meaning changed quietly and is worth naming: `concurrency` (default 4) now bounds
**agent loops**, not just single model calls. Four simultaneous multi-minute loops each with a
shell is a materially larger thing to have four of than four one-shot completions — which is
why the default did not rise with the tier.

- 893 tests green (214 shared + 658 server + 21 CLI). The tier test that asserted "tier 2 is
  not available" became two: one that spawns tier 2 and asserts it *ran* and that the feed
  says `tier2`, one that spawns tier 3 and asserts the refusal still names tier 2 as the way
  forward.

### 2026-08-28 — M6d: the tier-2 agent loop

The conversation that drives the ten tools. Same `WorkerRunner` shape as tier 1 — so the
engine's `spawn` needs no case analysis — but where tier 1 is one call, this is a loop, and
everything awkward about it comes from the model being an unreliable participant in it. Four
decisions carry the weight:

- **The loop terminates on `finish_report`, and nothing else.** A model that stops calling
  tools and writes prose gets exactly one nudge; if it does it twice, that prose *becomes*
  the report rather than the run failing on a formality. The work may well be done, and
  refusing to read it would bill the user for nothing. Running out of turns is still a
  failure, but it keeps the last prose as the run's result text — the initiator has to know
  the run was cut off, not that it produced nothing.
- **A repeated denied call is answered from memory, not re-gated.** The prompt tells the
  worker not to retry a refusal, and prompts are advisory. Re-running `approvals.require`
  for a call the user already denied would put the same card in front of them again, so a
  fingerprint (`name(arguments)`) of every denied call is kept and a repeat is
  short-circuited with the original reason. The user is asked **once per distinct request**;
  a retry with different arguments is a different request and does ask again.
- **`report_progress` and `finish_report` are implemented in the loop, not `execute.ts`.**
  Neither touches the disk: one writes to the user's feed and one ends the run. That keeps
  `execute.ts` the module where every filesystem-reaching tool lives, which is what makes it
  auditable as a list.
- **A tool call is never a throw.** `parseWorkerArgs` failures, unknown tools, denials and
  exceptions all become `role: "tool"` messages, because the only way a model fixes a
  mistake is by being told about it in a turn it can respond to. A malformed
  `finish_report` is recoverable too — it gets told what was wrong and can file again.

`createTier2Runner(opts)` is a factory rather than a bare function because workspace and
approvals are per-*task* while `WorkerRunner` is per-*work-item*: the engine makes one when
it opens a session and hands the same runner to every tier-2 worker on the task. That is
what let tier 2 land without touching `WorkerContext` or `runTier1Worker`.

The prompt (`TIER2_SYSTEM_PROMPT`) deliberately does **not** ask for tier 1's `SUMMARY:`
line — a test asserts its absence. Two sign-off conventions would give the model a reason to
skip the `finish_report` call the loop depends on. `buildTier2Messages` names the scratch
space only when it differs from `cwd`; when a task points at a real project directory, every
write there is gated, so the model needs somewhere ungated for temporaries and needs telling
that its own cwd is not it. `ORCHESTRATOR_PROMPT_VERSION` is 2: the ladder no longer says
tier 2 is unavailable.

26 loop tests. They walk every exit against a real in-memory database — report, prose
fallback, turn exhaustion, provider throw, error finish, pre-abort, mid-flight abort —
because `WORKER_RUN_TRANSITIONS` has no shortcut edge and a path that returns without
transitioning throws at the repo write and takes the task down. The denial tests **count
approval cards off the event log** rather than checking the pending list, since by the time
an assertion runs every card has been resolved; counting is the only way to see the
difference between asking once and asking twice. One trap worth recording: the loop grows a
single `messages` array in place and hands the same reference over every turn, so a test
router that stores requests as-is has every recorded turn aliasing the final state — an
assertion about "what the model was told at turn 2" silently becomes one about turn 9. The
scripted router copies.

Still to come in M6: the engine wiring (the `tier !== 1` refusal, the hardcoded `tier: 1` in
the progress line, and a tier-aware dispatcher in the single `runWorker` slot),
`send_to_worker`, the `/internal/approvals/:id` route with its in-band `approve|deny` twin,
and the acceptance — a gated shell command approved by curl mid-task.

### 2026-08-28 — M6c: the tier-2 tool surface and executor

Ten tools a worker can reach the disk with, and every one of them consults the gate from
M6b before it does anything. Two files:

- **`workers/tools.ts`** — each tool declared twice, JSON Schema for the model and zod for
  us, side by side, with a parity test asserting the pairing property-for-property (same
  keys, same required set, every property described). Drift either way is a real bug: the
  model told about an argument we discard, or an argument refused that it was never told to
  send. `parseWorkerArgs` returns a *message* on every failure — a worker that dies because
  it passed a number where a string was wanted has burned a subtask on a one-turn fix.
- **`workers/execute.ts`** — one function per tool, and the only place tools are implemented,
  so there is one list to audit rather than one per caller.

`web_search` from the design is **absent on purpose**, and the tool-name list is asserted
exactly so that stays a decision: there is no search backend, and a tool that errors every
time costs a turn to discover and invites a retry.

The four rules the executor is built around:

1. **Classify, then ask, then act.** Every deny test also asserts the disk was untouched —
   that second half is the one that catches an act-then-ask ordering bug, since a tool that
   acts and reports afterwards has already done the damage.
2. **Every failure is a tool result, never a throw.** Missing file, denied approval,
   non-unique anchor, exit 1 — all text the model can respond to. Errno codes become prose,
   because `Error#message` repeats the syscall and the path the model already knows.
3. **Output is capped and says so.** Silently truncated output is worse than obviously
   truncated: the model reasons confidently about a file it only half received. Files keep the
   **head** (the top is where a file's shape lives), `shell` keeps the **tail** (a failing
   build's useful line is the last one).
4. **Reads are gated too when they leave the zone.** A worker in a project dir may read the
   project and not `~/.ssh`; only `classify` tells those apart.

Decisions inside the tools:

- `edit_file` **refuses an ambiguous anchor** instead of taking the first match — an edit in a
  place the model never looked at is the failure mode most likely to be silently wrong.
- The shared walk **never follows symlinked directories**: a link up the tree makes the walk
  infinite, a link out of the zone reads files the gate was never asked about.
- `globToRegExp` **escapes every metacharacter**, so a pattern cannot smuggle in regex that
  matches far more than intended; `**/` matches zero directories too, so `**/*.ts` finds `a.ts`.
- `shell` **passes `readOnly` to the gate rather than skipping the call** — policy is the
  gate's, and passing the flag is what keeps every command in the audit trail. No stdin (a
  prompt would hang to the timeout and a worker cannot answer it), and the exit code is always
  stated.
- `web_fetch` is ungated but **http(s)-only**: `file:` would be a way around the path gate
  entirely, which is the one thing a fetch tool must not become.
- The approval summary carries the path **as written** *and* resolved — `../../etc/passwd`
  tells you what was asked, the resolved path tells you what it means, either alone misleads.

Tests run against real temp directories, because the thing worth testing is exactly what a
mocked `fs` would paper over. Two bugs fell out of writing them rather than out of reading the
code: `stripHtml` left a space at the start of every line (each dropped tag leaves one behind —
invisible in a browser, enough to break an exact quote out of a worker's context), and
`readdir`'s type resolved to the Buffer-name overload, so `entries` needed an explicit
`Dirent[]`. The second only showed up in `pnpm build` — vitest transpiles without
typechecking, which is now twice this milestone that the build caught what green tests could
not.

860 tests green (625 server, incl. 104 new; 214 shared; 21 CLI).

### 2026-08-28 — M6a+M6b: the sandbox and the gate

The two pieces every tier-2 tool will depend on, built before the tools that use them,
because a file tool written against a wrong `inside` boolean is a file tool that has already
escaped.

**The sandbox** (`workers/workspace.ts`) answers one question and refuses nothing:
`classify(ws, path).inside`. Policy lives one layer up, with `autoApprove` in hand — a
sandbox that refuses on its own could not be pointed at a real project directory, which is
the case `workspaceDir` exists for. `root` (the auto-approve zone) and `cwd` (where relative
paths resolve) are separate fields precisely so that a task working in the user's repo gets
`inside: false` for its own relative paths.

- **A real bug the tests caught, not a test artifact.** `openWorkspace` returned a resolved
  `root` and a raw-`resolve()` `cwd`. On macOS `/var` is a symlink to `/private/var`, so the
  two fields named the same directory and compared unequal — `contains(root, cwd)` reported
  the workspace as being outside itself. Both fields are now realpath'd, which is the
  invariant the comment now states.
- Containment is checked on **symlink-resolved** paths with the separator appended: the
  string test is defeated by `root/../etc/passwd`, by a symlink inside the workspace
  pointing out, and by `/workspaces/task-1-evil` sorting as a prefix of `/workspaces/task-1`.
- A path whose parent does not exist yet is resolved as far up as it does exist. You cannot
  `realpath` a file you are about to create, and skipping the check for those would be the
  one hole that matters — that *is* the write case.
- An empty-string `workspaceDir` means unset, not `resolve("")`. A config field left as `""`
  must not silently point a worker at wherever the daemon happens to be running.
- `workspaceDir` is resolved but deliberately **not created**: a typo in a project path
  should fail loudly on first use, not `mkdir` a new directory beside the one meant.

**The gate** (`workers/approvals.ts`) is one `require()` method, and there being exactly one
is the safety property — a second path to the disk is a second place to forget it.

- **Auto-approval is logged, never silent.** The row's note names which rule let the action
  through, so "nothing needed asking" and "the user turned the gate off" are distinguishable
  in the audit trail afterwards. `autoApprove` is read fresh per call, so flipping it
  mid-task takes effect.
- **A denial is a result, not an exception**, and carries the user's note: "denied: use the
  test fixture instead" redirects a worker, where bare "denied" invites the identical retry
  and a throw kills it.
- **Cancellation is checked before policy.** Everything parked is denied, and later requests
  are refused without writing a row — a task being torn down must not leave a worker
  awaiting a human who has closed the tab, however safe the step looks in isolation.
- **The read-only allowlist forfeits on any shell metacharacter.** `ls; rm -rf ~` starts with
  `ls`; the check is "one simple command from the list", not "begins with one". `-o` /
  `--output` are refused as well — the verb reads, the flag writes.
- The two approval events are emitted by `repos` as part of the write; the gate appends
  none of its own, or one prompt would render two dashboard cards.

36 new tests (14 sandbox + 22 gate) — nearly all of them attempts to get `inside: true` for
a path that is not, or a `true` out of the allowlist for something that writes. **756 green**
(214 + 521 + 21), build and lint clean.

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
