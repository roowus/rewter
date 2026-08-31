# Phase 2 direction — projects, learning, a native CLI

*2026-08-31. This is the decided direction for phase 2, settled in a design Q&A with the
owner. It reframes what "phase 2" means: the original phase-2 list (tier-3 harnesses, tmux
attach, learned stats) is still in here, but it is no longer the organizing idea. The
organizing idea is a blend of three reference projects:*

- **[Multica](https://github.com/multica-ai/multica)** — the *workspace shape*. Work lives
  in **projects**, not sessions. A project pins resources (repos, dirs, docs), agents are
  durable entities, every run is replayable, and work lands in review.
- **[Hermes Agent](https://hermes-agent.nousresearch.com/)** — the *learning shape*. The
  system distills what it did into reusable **skills** (agentskills.io `SKILL.md`), keeps
  small durable **memory** facts, and gets measurably better at repeated work.
- **[OmniRoute](https://github.com/diegosouzapw/OmniRoute)** — already absorbed in phase 1:
  provider breadth (75 presets) and the dashboard survey shortlist (9/9 done).

rewter's phase-1 skeleton fits this blend unusually well, and that is not luck — most of
the load-bearing seams were built for exactly this. Multica's
"issue + isolated workspace + spawn a CLI + stream events + replay" is structurally
rewter's Task + `~/.rewter/workspaces/<taskId>` + the tier-3 `HarnessAdapter` seam + the
append-only event log the dashboard already folds. Hermes's skill retrieval trick — a
compact always-in-context digest of frontmatter, full documents loaded on demand — is the
registry-digest pattern rewter already uses for models, pointed at a different table. And
`model_stats` plus the `best_at` tag vocabulary were built day one for "learns which
models are good for what."

## Decisions (locked)

1. **Primary interface: a native CLI (`rewt` TUI) + the existing dashboard.** The OpenAI
   endpoint stays — any client keeps working — but the owner's day-to-day surface becomes
   a purpose-built terminal client of the daemon. The dashboard stays the ops plane.
2. **Projects replace sessions as the top-level unit**, and a project owns *all four*:
   resources (repos/dirs/docs), learned state (skills + memory), policy (budget +
   approval rules + allowed tools/harnesses), and model preferences (pinned initiator,
   per-project stats). **Learned state and practices are scoped like `CLAUDE.md`**: a
   global layer that applies everywhere, and a project layer that overrides/extends it —
   the owner asked for this explicitly ("practices n whatnot that is global like how
   claude.md can have different scopes").
3. **Learning milestone one is the skills loop** (before stats-driven routing, before
   practices memory — both stay on the roadmap).
4. **Advise-only, gated writes.** Learned stats/skills/practices are rendered into the
   initiator's prompt as *evidence*; the model still decides. Agent-authored skills and
   memories are **staged for owner approval** before they take effect (Hermes ships this
   gate off; rewter ships it on). Per-project loosening can come later.
5. **The daemon becomes safely exposable over Tailscale** — like Multica and OmniRoute,
   usable from other machines on the tailnet, *without* handing the tailnet an
   unauthenticated kill switch (see below: today `/internal` has no auth at all).
6. **Mid-run prompting is a hard requirement of the CLI**, not a nice-to-have. The owner:
   "a feature i rly need is the way u can prompt claude while another prompt is running
   idk how they do it but other clis cant for some reason." Design below.
7. **A possible rename to `rewt`** is parked as
   [issue #17](https://github.com/roowus/rewter/issues/17) with the full blast-radius
   checklist (npm scope, CLI binary, `x-rewter-task-id` header, `~/.rewter/`, launchd
   label, repo). Nothing in this doc depends on the name; when the rename lands it is one
   sweep, one commit, docs included.

---

## 1. Projects

### What a project is

A durable, named container for related work — "clarity", "portfolio", "school" — with
everything an agent needs to work inside it attached *once*:

```
Project
├── id (proj_…), name, slug, description
├── resources[]        — { kind: "dir" | "repo" | "doc" | "url", path/url, note }
├── policy             — { maxSpendUsd, autoApprove, allowedTools[], allowedHarnesses[] }
├── modelPrefs         — { initiatorPin?, prefer[]/avoid[] model hints }
└── (owns, by scoping) — skills, memory facts, practices, model stats
```

`Task` gains a nullable `projectId`. **Nullable is the compatibility story**: every
existing flow — a bare `POST /v1/chat/completions`, a dashboard-launched task — keeps
working with no project, exactly as today. A project-less task behaves like phase 1.

### What attaching a project changes for a task

- **Workspace**: instead of the throwaway `~/.rewter/workspaces/<taskId>`, the task's
  workspace *is* the project's primary `dir` resource (Multica's model). Writes inside it
  are in-sandbox; the approval gate's "outside the workspace" boundary moves with it.
  Tasks that shouldn't touch the real dir can still opt back into a scratch workspace.
- **Context**: the initiator prompt gains a *project block* — name, description, resource
  list, and the project's practices — rendered by the same stable-sort/budget discipline
  as the registry digest (cacheability is still the rule). Multica writes a
  `resources.json` into the working directory; rewter injects into the prompt *and*
  drops `.rewter/project.json` into the workspace so tier-2/3 workers can read it with
  their own file tools.
- **Policy**: the project's budget cap and auto-approve rules apply before task-level
  settings; task settings can tighten but not loosen a project cap.
- **Model prefs**: a pinned initiator wins over the global default; prefer/avoid hints
  are appended to the digest as advice (advise-only — decision 4 applies here too).

### Scoping: the CLAUDE.md model

Every kind of learned/curated state exists at **two layers**:

| layer | lives at | applies to |
|---|---|---|
| **global** | `~/.rewter/skills/global/`, global memory rows | every task |
| **project** | `~/.rewter/skills/<project-slug>/`, memory rows with `projectId` | tasks in that project |

Project entries *extend* global ones; on a name collision the project entry wins (same
precedence direction as a repo `CLAUDE.md` over `~/.claude/CLAUDE.md`). The digest
renderer takes `(global ∪ project)` and renders one block, marking provenance so the
initiator can tell a house rule from a project rule.

### How the client selects a project

- **CLI**: `rewt` run inside a directory that is a project resource auto-selects that
  project (like git finding its repo); `rewt -p clarity` overrides.
- **Endpoint**: `x-rewter-project: <slug>` header, or model suffix
  `auto/orchestrator@clarity` for clients that can only set the model string.
- **Dashboard**: a project picker on run-from-dashboard; a Projects panel for CRUD.

---

## 2. The skills loop (learning v1)

### Format: agentskills.io `SKILL.md`, verbatim

The same format Claude Code, Hermes, Codex CLI, and OpenClaw use — markdown with YAML
frontmatter (`name`, `description`, body = the procedure). Choosing the standard means:
skills the owner already has are importable by copying a directory; skills rewter distills
are usable by other tools; and there is a public ecosystem to borrow from. rewter adds
optional frontmatter of its own (`learned_from: task_…`, `uses: n`, `project: slug`) that
other tools will ignore harmlessly.

Storage is **files, not DB rows** — skills are owner-editable documents first
(Hermes's position, and the right one: a skill you can't open in an editor is a skill you
can't fix). The DB gets a small index table (`skills`: slug, scope, path, frontmatter
digest fields, status) so retrieval and the dashboard don't re-parse the tree on every
request; the file is the source of truth and the index is rebuilt from it.

### The loop: distill → stage → approve → retrieve

1. **Distill.** After a task **succeeds**, a distiller job looks at the event log (the
   same log the dashboard replays — no new instrumentation) and asks: did this involve a
   meaningful tool sequence (heuristic to start: ≥5 tool calls across the task's
   workers, or a repeated pattern the index has seen before)? If yes, a *cheap* model is
   prompted with the condensed transcript to draft a `SKILL.md`: procedure, pitfalls
   observed (denied approvals, failed attempts, retries — the event log has them all),
   verification steps. LLM output is zod-parsed defensively like every other LLM JSON.
2. **Stage.** The draft lands in `~/.rewter/skills/pending/`, an Approval-like row is
   written, and it shows up in the dashboard and the CLI as "proposed skill". **Nothing
   pending is ever retrieved.**
3. **Approve.** Owner approves (moves into the scoped directory, indexed), edits first,
   or rejects. This is decision 4: the gate ships **on**.
4. **Retrieve — progressive disclosure.** The initiator prompt gains a **skills digest**:
   one line per approved skill (name + description), stable-sorted, token-budgeted —
   built by the registry-digest renderer's pattern and living next to it in the prompt.
   The initiator (and tier-2 workers) get a `load_skill(slug)` tool that returns the full
   body. Frontmatter always in context, body on demand — Hermes's ~3K-token trick.

### Explicitly later (roadmap, not v1)

- **Stats-driven advice** — turn on the `StatsRecorder` event subscriber over the
  existing `model_stats` table; render per-(model, taskTag) success/cost/latency into the
  digest. The schema has been waiting since M1.
- **Practices memory** — small always-in-context durable facts (corrections, coding
  conventions, tool preferences), global + project scoped: a learned `CLAUDE.md` the
  system drafts and the owner approves. Same stage/approve pipeline as skills; different
  retrieval (always in context, so the budget is tight).
- **Skill refinement** — a skill that keeps getting loaded on tasks that then fail is
  evidence it's wrong; feed that back as a proposed edit (still gated).

---

## 3. The native CLI (`rewt` TUI)

### Why building it is cheap here (the harness question, answered)

The owner asked: *is it worth coding my own agent harness and CLI for the initial model,
and would this be difficult?* The answer is yes, and no — **because the harness already
exists.** The expensive parts of an agent CLI are the agent loop, tool execution,
approval gating, streaming, cost metering, and cancellation — all of which are phase-1
server code (orchestrator engine, tier-2 loop, approvals choke point, event log). What
Claude-Code-as-frontend has been standing in for is only the *terminal rendering* of a
stream the daemon already emits. So the build is a **thin client**:

```
rewt (TUI) ──── WS /internal/ws (afterSeq replay + live events)
          ├──── POST /v1/chat/completions (start a task, SSE)
          └──── POST /internal/… (approve, steer, cancel, projects)
```

No new server loop, no second protocol. The task tree the TUI renders is the same
`shared` fold the dashboard uses — written once, tested once, now with a third consumer.
Estimated at 2–3 milestones, versus the months a from-scratch harness costs — and it
removes the two structural awkwardnesses of the relay setup: paying a smart model to
forward text, and steering that depends on conversation-fingerprint matching.

### Mid-run prompting (the hard requirement)

How Claude Code does the thing other CLIs can't: **the input line is never modally bound
to the running turn.** Typing during a turn queues the message; the harness surfaces it
to the model at the next safe boundary — alongside the next tool result — as "the user
sent a message while you were working", and the model addresses it *within the running
turn*. Most CLIs instead block stdin on the in-flight request, so there is no channel
until the turn ends. It is a UI-loop property, not a model property.

rewter already has the server half: in-band steering injects `[USER STEERING]` at the
next turn boundary, `send_to_worker`/`HarnessSession.send()` reach running workers, and
pending `ask_user`s are answerable mid-flight. The TUI makes it native:

- The prompt line is **always live**. Rendering streams above it; input never blocks.
- A message typed while a task runs is `POST`ed to the task's steer endpoint immediately
  and echoed into the transcript as queued; the engine injects it at the next boundary
  (exactly the phase-1 mechanism, minus the fingerprint matching — the TUI knows the
  task id, so injection is exact, not inferred).
- Approvals are keystrokes on the live approval line (`a w1` / `d w1 reason`), not
  in-band chat text.
- The same channel must reach **tier-3 harness workers** when those land: a queued
  message routed to a worker mid-session is `HarnessSession.send()` — the seam was
  committed in phase 1 for precisely this. For harness CLIs that block stdin mid-turn
  (the ones the owner has been frustrated by), the adapter queues and delivers at the
  harness's next input opportunity; the *rewt-side* UX is uniform even when the
  underlying harness is modal.

### Rendering (decidable later, seam now)

Ink (React for CLIs) vs. hand-rolled ANSI is deliberately not decided in this doc. What
is decided: the TUI is a separate workspace package (`packages/tui` or folded into
`packages/cli` behind the default command), it consumes only public daemon surfaces, and
the fold stays in `shared`. The phase-1 progress-as-text vocabulary (`◆ plan:` /
`▶ [w1 · model · tier]` / `⏸` / `✔`) carries over as the visual language.

---

## 4. Tailscale exposure

The point: run the daemon on one machine, use `rewt`, the dashboard, and the OpenAI
endpoint from any device on the tailnet — Multica and OmniRoute both work this way.

**The blocker is real and specific: `/internal` has no auth.** `/v1` has an optional
bearer token; `/internal` — approve, deny, kill, shutdown, registry writes, budget
moves — relies entirely on the `127.0.0.1` default bind. `REWTER_HOST` already exists,
so one env var currently turns the daemon into an unauthenticated remote kill switch.

Two supported modes, both documented, one recommended:

1. **`tailscale serve` (recommended, zero code).** The daemon stays loopback-bound;
   `tailscale serve` terminates tailnet TLS and proxies to it. Identity, encryption, and
   reachability are Tailscale's problem; rewter's threat model is unchanged. The docs
   get a walkthrough (`tailscale serve --bg https / http://127.0.0.1:<port>`).
2. **Direct bind, fail-closed (small code change).** For people who bind the tailnet IP
   directly: boot **refuses** a non-loopback `host` unless an internal auth token is
   configured (`internalKey` in config / `REWTER_INTERNAL_KEY`), and with it configured,
   `/internal` requires it (same bearer/`x-api-key` check `/v1` already implements —
   shared code, not a parallel implementation). The dashboard bundle reads the token
   from a cookie set at first visit or a `?key=` bootstrap; `rewt` reads it from config.
   Refusing to boot is the design: a warning log would be the kind that is only read
   after the incident.

WS `/internal/ws` is covered by the same guard (auth at upgrade time). CORS stays
disabled for `/internal` — the dashboard is same-origin either way.

---

## Build order (phase 2 milestones)

| # | Milestone | Contents | Verified when |
|---|---|---|---|
| P2-M1 | **Projects** | schema + repos + lifecycle, project block in prompt, workspace-from-resource, policy precedence, header/model-suffix selection, dashboard panel | project-scoped task uses the project dir as workspace; cap tightening order tested; project-less tasks unchanged (full phase-1 suite still green) |
| P2-M2 | **Tailscale hardening** | fail-closed non-loopback boot, `internalKey` guard on `/internal` + WS, `tailscale serve` walkthrough in README | non-loopback boot without key refuses; with key, dashboard + endpoint work from a second tailnet device (live acceptance) |
| P2-M3 | **`rewt` TUI** | WS client + shared fold, always-live input, mid-run steer, approval keystrokes, project auto-select, cost footer | steer a running fan-out from the TUI mid-turn; approve from the TUI while the dashboard watches; kill mid-render leaves the terminal sane |
| P2-M4 | **Skills loop** | SKILL.md store + index, distiller job, pending/approve pipeline (dashboard + TUI), skills digest + `load_skill` tool | a repeated task produces a proposed skill; approved skill appears in digest; pending skill never retrieved; imported Claude-Code skill loads |
| P2-M5 | **Tier-3 harness #1** | Claude Code headless adapter on the committed `HarnessAdapter` seam, tmux attach, mid-session `send()` | a task delegates a subtask to headless Claude Code; owner sends it a mid-run message from `rewt`; `tmux attach -t rwtr_<runId>` shows it live |

Ordering logic: projects first because skills scoping, TUI project-selection, and policy
all hang off the schema; tailscale second because it is small and the TUI should be born
remote-capable; TUI before skills because the approval UX for proposed skills wants a
place to live; harness last because everything before it makes the harness worth having.

Stats-driven advice and practices memory queue behind P2-M4 as the loop's second and
third dimensions (§2, "explicitly later").

## Key risks

- **Skill quality is a prompt problem** (again). The distiller prompt is a versioned
  `.md`, snapshot-tested like the orchestrator prompts; the approval gate is the
  backstop while it's tuned.
- **Project workspaces point at real repos** — the approval boundary moving into a real
  dir means "inside the workspace" auto-approves writes to real code. Mitigation: the
  policy layer defaults new projects to gated writes until the owner loosens them.
- **Digest budget pressure** — registry digest + skills digest + project block + (later)
  stats all compete for prompt space; issue #8 (char-count budgeting) gets more wrong as
  more renderers stack. Fix #8 during P2-M4 at the latest.
- **`/internal` auth is retrofit** — every existing consumer (dashboard fetches, WS,
  tests) must pass the guard; the loopback-no-key default keeps all of phase 1 working
  unchanged, which is what makes the retrofit safe to land incrementally.
