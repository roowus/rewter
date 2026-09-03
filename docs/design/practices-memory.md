# Practices memory — the learning loop's third dimension

Shipped 2026-09-03. The phase-2 direction doc listed this as "explicitly later": *small
always-in-context durable facts (corrections, coding conventions, tool preferences), global +
project scoped: a learned `CLAUDE.md` the system drafts and the owner approves. Same
stage/approve pipeline as skills; different retrieval (always in context, so the budget is
tight).* This note records what was built and the decisions the one-line brief left open.

## The gap

Skills and stats teach the system *how* and *who*. Neither teaches it *what the owner keeps
saying*. When a task is steered with "use pnpm, not npm" or an approval is denied with "never
force-push here", the correction lives in that task's event log and nowhere else. The next
task makes the same mistake, and the owner types the same sentence. A skill is the wrong
container: it is a procedure loaded on demand, and the model would have to guess to load it
before it has erred. A rule the model must already know when it plans has to be in the prompt
before the first turn.

## Decision

A **practice** is one short standing fact, in a file, under the same three-directory tree the
skills store uses, drafted by the same kind of distiller, approved by the same kind of gate,
and rendered into the initiator prompt on every task it is visible to.

What is the same as skills, on purpose:

- **Files are truth, the DB indexes them.** `~/.rewter/practices/{global,<project>,pending}/
  <slug>/PRACTICE.md`. Same reserved slugs, same "the directory *is* the scope for approved
  files, the frontmatter `project:` is the *target* for pending ones" rule, same
  `replace*Index` single-transaction rebuild, same boot reindex.
- **Nothing pending is ever retrieved.** `visiblePractices` in `shared` is the one door.
- **Stage/approve** is a move; reject is a delete; the routes are thin over both plus a
  reindex; the CLI and dashboard sit on the routes.
- **The drafter never throws, never blocks, queues on a promise chain**, skips an
  already-pending twin, is on by default because its output is inert until a human moves it.

What is deliberately different:

| | Skill | Practice |
|---|---|---|
| Body | procedure, up to a page | **the fact itself**, ≤ 400 chars, whitespace-collapsed |
| Frontmatter | passthrough (imports carry foreign keys) | **strict**: `name`, `learned_from?`, `project?` — nothing else is a practice's business |
| Trigger | ≥ 6 worker turns on `succeeded` | **≥ 1 correction** on *any* terminal state |
| Transcript | the whole condensed log | **only the corrections**, with the plan and worker briefs they corrected |
| Retrieval | digest line + `load_skill` on demand | **always in context**, no tool |
| Budget | 1000 tokens | **400 tokens** |
| Drafts per task | 1 | ≤ 3 |

### Why corrections are the trigger

A skill is worth writing when a task did a lot of work. A practice is worth writing when the
*owner* did work: steered, or denied. `shouldDraftPractices` counts `steering.received` events
and `approval.resolved` events with `status: "denied"` — the two places the log carries the
owner's own words against the system's plan. Approved approvals, plan notes and worker turns
are not corrections. A task with zero corrections costs nothing: the check runs synchronously
in the bus subscriber before anything is queued, so the common case is not even a chain link.

It fires on `failed` and `cancelled` too. A correction is a correction regardless of how the
task ended; if anything a task the owner cancelled after steering it is the strongest signal.

### Why the transcript is only the corrections

The drafter is asked "what did the owner say they always want?" Feeding it the whole log
invites it to write procedures — that is the skills distiller's job. `condenseCorrections`
renders the plan notes and worker briefs (what was about to happen), the approval requests
(what was asked), and the owner's steering and denial text verbatim, marked `USER STEERED:` /
`USER DENIED:`, plus worker failures (what the correction cost). Budget 3000 tokens, middle
elided.

### Why the body is the fact and the cap is hard

Every approved practice is paid for on every task's prompt, forever, until the owner removes
it. A 2000-character "practice" is a skill wearing the wrong hat. `PRACTICE_MAX_CHARS = 400`
(~100 tokens) is enforced by the parser, so the scanner refuses an over-long file and the
drafter clamps to it. The clamp leaves one character for its `…`, because a draft the composer
writes must survive the composer's own round-trip through the parser — a lesson the test caught
before the daemon did.

### Why the frontmatter is strict

Skills are imported from other tools and must tolerate their keys. Practices are never
imported: they are drafted here or written by the owner in a text editor, and a stray key in
one is a typo, not a foreign convention. `.strict()` turns the typo into a named scan problem.
`learned_from` is validated as a `TaskId` for the same reason.

### Why the digest is a quarter of the skills budget

The skills digest is an index the model reads once to decide what to load. The practices
digest is the content, read on every task. `DEFAULT_PRACTICES_MAX_TOKENS = 400` is deliberately
uncomfortable: a library that blows it gets an honest `(N further practice(s) omitted for space
— the library is over budget.)` line, which is the curation prompt. Order is stable slug order,
not priority — there is no signal to rank on yet, and a deterministic order keeps per-project
prompt caching intact.

### Where it renders

In the per-task region of the initiator prompt, after the project block and the skills digest,
under `Practices for this task (standing facts — follow them):`. Visibility is
project-dependent, so it cannot live in the cacheable core. The core prompt
(`ORCHESTRATOR_PROMPT_VERSION 9`) gains a `# Practices` section telling the initiator these
are already in front of it, apply without being asked, and must be restated in a worker's
`instructions` when they bear on that worker's part — **workers do not see the list**. That
last point is a scope decision: injecting practices into every tier-2 and tier-3 prompt would
multiply the always-in-context cost by the fan-out. The initiator is the one place that sees
every task, so it is the one place the standing rules live; it is told to relay what matters.

## Configuration

```jsonc
"practicesDir": "~/.rewter/practices",   // the PRACTICE.md tree; files are truth
"practices": {
  "distill": true,                       // draft pending practices from corrections
  "distillModel": null                   // null → cheapest known-priced enabled model
}
```

Every field defaults; a config that predates practices boots unchanged.

## Surfaces

- `GET /internal/practices[?status=pending|approved]`, `POST /internal/practices/:slug/approve`
  (strict body, optional `{overwrite: true}`; `404`/`422`/`409` as for skills),
  `POST /internal/practices/:slug/reject`. 501 without a configured tree.
- `rewter practices [list [--pending|--approved] | show <slug> | approve <slug> [--overwrite] |
  reject <slug>]`. `list` prints the fact itself under each slug, because a practice is short
  enough to review in the listing, and marks pending ones `?` with their target scope.
- Dashboard `PracticesPanel`, next to the skills panel: fact inline, approve / reject (armed),
  409 → explicit overwrite.

## Later

- **Worker-visible practices.** Today the initiator relays. If observation shows it fails to,
  a worker-side digest with its own smaller budget is the next step, not a bigger initiator
  one.
- **Use counting / decay.** Nothing records whether a practice was ever relevant. A practice
  that is never relevant is pure cost; a `uses` or `last_relevant` signal would let the digest
  rank or the owner prune. Retrieval writes nothing today, as with skills.
- **Contradiction detection.** Two approved practices can disagree. The drafter sees the
  existing library and is told not to re-draft, but nothing checks an approved pair against
  each other.
