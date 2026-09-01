# rewter

**An AI model router where the AI runs the routing.**

rewter is an OpenAI-compatible, multi-provider AI model router (in the family of
OpenRouter / 9router) with one defining twist: alongside plain model routing, it exposes an
**orchestrator pseudo-model**. Send a task to `auto/orchestrator` like any other model, and
an *initiator AI* decomposes it, delegates subtasks to the best/cheapest-fit models **in
parallel**, collects their reports, and hands itself off to a stronger model if it decides
it's not fit to lead. You watch and control everything from a live dashboard.

```
your client (Claude Code, curl, any OpenAI or Anthropic client)
  │  POST /v1/chat/completions  ·  POST /v1/messages
  │  model: "auto/orchestrator" (or any concrete model)
  ▼
┌────────────────── rewter daemon ──────────────────┐
│ plain routing (any concrete model) ──────────────▶│──▶ Anthropic / OpenAI / Z.AI / xAI /
│ or:                                               │    Google / OpenRouter / Ollama / …
│  initiator AI plans, then fans out:               │
│    ├─▶ cheap model   · tier 1: bare call          │
│    ├─▶ agent worker  · tier 2: files/shell/web    │
│    └─▶ harness       · tier 3: headless Claude Code│ (aider, codex: later)
│  approval gates ⏸ · live task tree · cost tracking│
└───────────────────────────────────────────────────┘
         ▲ web dashboard: watch, approve, steer, kill
```

## Why

- **Speed** — independent subtasks run on parallel workers.
- **Cost** — cheap models execute, smart models plan and review; every token is metered.
- **Specialization** — OCR, vision, and coding-specialized models get used where they fit,
  chosen via machine-readable **capability cards** in a model registry.

## Providers

Breadth is a design goal — **75 upstreams ship as built-in presets**, and adding another is
a table row (slug, base URL, env var name, quirks), not new code:

| | |
|---|---|
| **First-party SDKs** | Anthropic, Google Gemini, OpenAI |
| **Aggregators** | OpenRouter, Together, Fireworks, Groq, DeepInfra, Hyperbolic, Nebius, Novita, SambaNova, Cerebras, Perplexity, SiliconFlow, NVIDIA NIM, Hugging Face, Vercel AI Gateway, Requesty, LLM Gateway, NanoGPT, ZenMux, Chutes, ModelScope, Ollama Cloud, nscale, Featherless, FriendliAI, Inference.net, Scaleway, DigitalOcean, Heroku, W&B, Venice, BytePlus, Qianfan, GitHub Models |
| **Direct vendors** | xAI, Z.AI/GLM, Moonshot, DeepSeek, Mistral, Cohere, Qwen, MiniMax, Baseten, AI21, Reka, Writer, Upstage, Liquid, Inception, Nous Research, Morph, Meta Llama, Codestral, LongCat, StepFun, Baichuan, Hunyuan, Volcengine, SEA-LION, Typhoon, Sarvam, Public AI, Mixlayer, CLOVA Studio, iFlytek, Poolside, Opper |
| **Local aggregators** | 9router |
| **Local runtimes** | Ollama, LM Studio, llama.cpp, vLLM |

**9router** is its own category because it is the only preset that is both local and an
aggregator: it runs on your machine and needs no key from rewter, but the models it lists
belong to Anthropic, Google, OpenAI, Z.AI and the rest — it holds *their* credentials, so
rewter does not have to. Pointing rewter at a running 9router turns one preset into a
hundred-plus models, which is the fastest way to get a capable orchestrator initiator
without configuring a single API key.

Three adapter classes cover all of them (`anthropic`, `openai-compat`, `google`), and one
shared contract test suite holds every adapter to an identical normalized stream shape. API
keys are referenced by **environment variable name** — raw keys are never stored in the
database.

Much of that breadth was sourced from [OmniRoute](https://github.com/diegosouzapw/OmniRoute)'s
provider registry (MIT, © 2026 diegosouzapw), converted to rewter's shape — its base URLs
include the chat path, rewter's stop at the API root — and then probed live, so a listed
upstream is one that answered and `listModels` reflects a catalog route that actually exists.
See [ARCHITECTURE.md](docs/ARCHITECTURE.md#provider-presets) for what was deliberately left
out and why.

## Status

**Phase 1 (MVP) is complete — M0 through M8, every acceptance run live** (including the ones a
test suite cannot stand in for: Claude Code driving it as a plain router, a shell command
approved from the browser mid-stream, `kill -9` mid-task, and a real reboot with the daemon
brought back by launchd at login). See [docs/progress.md](docs/progress.md) for the milestone
board and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

**Phase 2 is decided and underway** — see the
[direction doc](docs/design/phase2-direction.md): **projects** as the top-level unit
(pinned repos/dirs/docs, per-project policy and model prefs, learned state scoped global
vs. project like `CLAUDE.md`) — *shipped: `auto@<slug>` or an `x-rewter-project` header
runs a task under a project today, and the dashboard has a projects panel (create, edit
policy, archive) plus a project picker on the run box* — a **skills learning loop** (agentskills.io `SKILL.md`
distilled from what the system actually did, gated behind your approval) — *shipped: every
qualifying success drafts a pending skill that retrieval never reads; you review it with
`rewter skills` or the dashboard's skills panel, and once approved it appears in the
orchestrator's prompt digest, where the initiator or a tier-2 worker loads the full
procedure with `load_skill`* — a **native
`rewt` terminal client** where you can keep typing while a task runs — *shipped:
`rewter chat` runs a task with an always-live prompt; mid-run lines steer the initiator
or resolve approvals through the daemon's steering grammar (see
[Chatting from the terminal](#chatting-from-the-terminal))* — **Tailscale**
support — *shipped: `tailscale serve` works against the loopback daemon as-is, and a
direct non-loopback bind fails closed until `REWTER_INTERNAL_KEY` is set, which then
gates `/internal` and the dashboard (see
[Reaching it from another device](#reaching-it-from-another-device-tailscale))* — and
the first **tier-3 harness** (headless Claude Code) on the seam built in phase 1 —
*shipped: `spawn_worker` takes `tier: 3`, one approval gates the spawn ("run Claude Code
in <dir>"), `send_to_worker` reaches the running session mid-turn, and its self-reported
cost is metered under `harness/claude-code`; opt-in via `"harnesses": { "claudeCode":
{ "enabled": true } }` in the config. tmux attach and restart re-adoption come in later
slices.*

Working today (M0–M3d): the **plain routing** path end to end — a bootable daemon
(`rewter start`), both client dialects (`POST /v1/chat/completions` for OpenAI clients and
`POST /v1/messages` for Anthropic ones, streaming and not), `GET /v1/models`, model
resolution across every upstream, retry, SSE, and per-request cost metering. **Claude Code
runs on it** — verified live end to end, tool calls included, against two upstreams.

Done (M4): the **model registry** the orchestrator chooses from — capability-card storage, where
a hand correction survives card regeneration and cannot rewrite the card's provenance; the digest
renderer that turns the registry into one compact, byte-stable line per model;
**`rewter sync-models`**, which fills the registry from the providers' own catalogs; and
**`rewter card`**, where one model writes the capability card for another.

Done (M5a): the **orchestrator engine** — the loop that *is* `auto/orchestrator`. Parallel
tier-1 fan-out onto a concurrency limiter, `wait` in `all`/`any` modes, summaries by default
with full text on request, progress narrated as ordinary text down the same stream, handoff to
a stronger model, an AbortController tree for cancellation, and a spending cap read back from
the cost ledger rather than counted in memory. It returns the *same* stream type a plain model
call does, so the HTTP layer needs no special case for it.

Done (M5b): `auto/orchestrator` is **live on both dialects**, streaming and not. Ask any
OpenAI or Anthropic client for it and you get a real orchestration — narrated progress down
the response, the same wire format as any other model. Every response carries
`x-rewter-task-id`, set before the first byte because that is the only moment a header can be
set. Re-POSTing a conversation that is still running is **steering**, not a second task: the
new message reaches the initiator at the next turn boundary and the follow-up request attaches
to the stream already in flight. A client that drops and comes back **adopts** its task,
replaying everything it missed; one that stays gone has 30 seconds before the task is
cancelled, so a Ctrl-C does not leave workers billing to nobody.

Also working (M6): the **safety layer** tier-2 workers run inside, and the tools they run
with. The sandbox answers one question, *is this path inside the auto-approve zone*, on
symlink-resolved paths, and refuses nothing: pointing a task at a real project directory is
meant to put every write outside the zone, because that is exactly when you want to be
asked. The gate is one function, and there being exactly one is the point — a second path to
the disk is a second place to forget it. Auto-approvals are logged rather than skipped, so
"nothing needed asking" and "the gate was off" stay distinguishable; a denial comes back as a
*result* carrying your note, so a worker told "use the test fixture instead" adapts rather
than dying; and the read-only allowlist forfeits on any shell metacharacter, since
`ls; rm -rf ~` does begin with `ls`.

The ten tools themselves (M6c) are declared twice — JSON Schema for the model, zod for us,
with a parity test so the halves cannot drift — and implemented in exactly one file, so there
is one list to audit rather than one per caller. Classify, then ask, then act, in that order:
a tool that acts and reports afterwards has already done the damage, so every denial test
also asserts the disk was untouched. Nothing throws — a missing file, a refused approval, an
`old_text` that matches twice, a command that exits 1 all come back as text the model can
respond to. Output is capped *and says it was cut*, since a model reasons confidently about a
file it only half received; files keep the head, `shell` keeps the tail. Reads are gated too
when they leave the zone, `edit_file` refuses an ambiguous anchor rather than editing
somewhere the model never looked, the recursive walk won't follow a symlink out of the tree,
and `web_fetch` takes http(s) only — `file:` would be a way around the path gate entirely.

The loop that drives them (M6d) is the same `WorkerRunner` shape as a tier-1 worker, so the
engine needs no case analysis — but a loop has a model as an unreliable participant, and that
is where its rules come from. It ends on `finish_report` and nothing else; a model that writes
prose instead gets one nudge, and if it does it twice that prose *becomes* the report, because
the work may well be done and refusing to read it would bill you for nothing. A denied call is
remembered by fingerprint and a repeat is answered from memory, so a model that ignores the
prompt and retries does not put the same card in front of you again — you are asked once per
*distinct* request, and a retry with different arguments is a different request. Nothing
throws: bad arguments, an invented tool name, a refusal, even a malformed report all come back
as a turn the model can answer, since being told is the only way it fixes anything. Every exit
is walked against a real database, because the lifecycle has no shortcut edge and a forgotten
transition would surface as a crashed task rather than a failed test.

And as of M6e the initiator can actually **ask** for one. `spawn_worker` takes `tier: 2`, and
the engine picks the runner by tier (as of P2-M5 that includes `tier: 3` — a headless Claude
Code session, on a daemon that has one configured; without one the refusal points at tier 2
rather than saying "not yet"). The workspace and approval gate open on the first tier-2 spawn
(most tasks are pure tier-1 fan-outs and would otherwise each leave an empty directory behind)
and are shared by every tier-2 worker on the task, because two of them write to the same place
and a denial one collected should not be put in front of you twice. Workers narrate into the
same feed you are already reading: `· [w2] read src/foo.ts, found the off-by-one`, and
`⏸ approval needed` carrying the full approval id — the id the route, the in-band reply and
the audit row all use. Their scratch space is `workspacesDir` (default `~/.rewter/workspaces`),
which is deliberately not under the database file. One meaning shifted with the tier:
`concurrency` now bounds four simultaneous *agent loops*, each with a shell, rather than four
one-shot completions — which is why the default stayed at 4.

Answering a card works three ways, all of them one code path: `POST /internal/approvals/:id`
with `{"approved": true}` (the dashboard's buttons, and `curl`), or `approve <id>` / `deny <id>:
why not` typed as the next user turn in whatever client you are already in. An in-band reply
can be both — `approve apr_x` on one line and an instruction on the next does both things, and
only the instruction reaches the initiator. Denials carry your note down to the model as a tool
result (`command not run: denied by the user: use the fixture instead`), because a worker told
why can pick something else and a worker handed a crash cannot.

A tier-2 worker can also be corrected while it runs. `send_to_worker` hands it a message it
reads at its next step — a constraint you left out, an answer it needed, or an instruction to
drop what it is doing — and the feed shows `⇄ [w2] told: …` so a worker changing course mid-run
is explicable. The message does not interrupt work in flight: the initiator sends and then
`wait`s as usual. Tier-1 workers cannot be messaged, and the refusal says so and names tier 2,
because a single model call has no point at which it could read anything.

All three ran live on 2026-08-28, which is what closes M6. A `uname -a` parked, was approved by
`curl` while the stream stayed open, and the same stream finished with the kernel string; a
`curl` to the network was denied with a note and the worker switched to `web_fetch` rather than
retrying or dying; and an in-band `approve apr_…` re-POSTed with `x-rewter-task-id` both resolved
the card and adopted the task, so the second stream replayed the feed and carried on while the
original one also finished with the answer.

M7 is the **dashboard**. The first piece is the fold — `EventEnvelope[]` → task
tree, in `@rewter/shared` so the daemon and the browser run one implementation and cannot
disagree about what a task is doing. It folds one event at a time, because a dashboard replays
history once and then lives on single events forever, and it drops anything at or below the
`seq` it has already seen: replay and the live subscription overlap by design, and a
re-delivered cost record must not bill you twice on screen. What it cannot reconstruct it says
so about rather than inventing — worker labels are re-derived from creation order, results and
errors are not in the stream at all, and an event for something it never saw created is counted
in `orphanedEvents` instead of quietly dropped, so a fold that joined a task late cannot be
mistaken for a complete one.

The second piece feeds it: `WS /internal/ws`. A client subscribes with the highest `seq` it
has folded; the server replays everything after that, sends a `ready` frame, and *then*
attaches the live listener. That order is the whole design. Attaching first would let an event
appended mid-replay arrive ahead of the rows that precede it, and nothing downstream can
repair a reordering — replay-first turns the same race into a duplicate, which the fold's
`seq` guard already drops. Polling was the alternative, and it is why a polled task tree jumps
instead of moving.

The third piece is the app itself: a React SPA the daemon serves as static files, with **no
fetching layer at all**. The daemon's answer to "what is happening" is the event stream, the
fold that reads it already lives in `shared`, and a REST layer beside it would be a second
answer to the same question — the one on screen would be the one nobody tested. So the whole
dashboard is one store holding one socket and one `FoldState`, and a page that ticks a single
clock rather than reading one inside each row. A dropped socket leaves the tree on screen and
says the feed is stale, instead of blanking the page as though the daemon had no tasks. And an
approval card does **not** hide itself when you click it — it disables its buttons, posts, and
tells you what the daemon said; the card leaves when the resolution folds. Hiding on click
would leave the UI claiming an approval that a failed POST never recorded.

The kill button follows the same rule, and it is worth saying what it does *not* do: it does
not write the cancelled row. A live task's own stream already ends by writing that row and
saying what it spent, so a second writer would race it — and since `cancelled` is terminal,
the loser throws at the state machine. The route just aborts the task's controller and lets
the stream finish its own sentence. When there is no live session — a task from before a
restart, whose `running` is a lie left on disk — the route settles the row itself and says so,
because "I cut off your workers" and "I tidied up a stale row" are different things to have
done. Clicking a task that already finished gets a 409 rather than a fake success.

The fourth piece breaks the rule on purpose: the spend panel **fetches**
(`GET /internal/costs`). Two reasons the fold structurally cannot answer "what has this
daemon cost": a pass-through request has no task, so its cost event is orphaned and
dropped — while pass-through is most of a router's traffic — and a fold holds only what
the socket replayed, so a browser opened today would report a week-old daemon's spend as
this morning's. What stays shared is the aggregation: `summarizeCosts` lives in
`@rewter/shared`, and the endpoint and the panel compute their answers through the same
code so they cannot disagree. Every number in it carries the split the router exists to
expose — what the initiator spent *planning* versus what its workers spent *working* —
because an orchestrator that out-thinks its own budget reads as a perfectly healthy
total. Group it by model, by day (in the zone the response names), or by task, over a
rolling `1D / 7D / 30D / All` window — defaulting to 7D, because a lifetime total only ever
goes up and so can never tell you that something got more expensive lately. Four cards sit
above the breakdown (cost per request, tokens in→out, cache reads and writes, the top bucket
of whatever grouping is showing), and every one of them is a field the summary actually
carries: zero calls prints `—`, not a `$0` average nobody measured.

The fifth piece closes M7: the **registry editor**, which fetches for the same reason — a
registry is not a stream of things that happened, it is a table of what is true now. It
exists so one rule is visible instead of buried. A row whose facts came from a provider's
catalog is `synced`, and the next `rewter sync-models` refreshes it wholesale, so a
hand-corrected price on such a row is not an edit — it is a countdown, and the only symptom
when it runs out is a cost report that stops matching the invoice. So editing a *fact*
promotes the row to `manual`, which sync then leaves alone, and the form says so **before**
the save rather than after: the warning names the model while the change is still on screen
and still attributable to the field you just typed in.

`enabled` is the exception and gets its own button for exactly that reason. Sync never flips
it — it is your switch, not a claim about the model — so it is sent on its own, never bundled
with the facts. Bundled, turning a model off would take its prices off the sync path forever.
The daemon compares patches by value, so a Save that follows a glance rather than an edit
answers `changed: false`, and the panel reports that as "no change" instead of "saved": the
usual way to see it is a form showing values someone else already saved, and a user told
"saved" walks away believing a price is fixed. Prices with no value read as `unpriced`, never
`$0` — a local Ollama model is free, one whose price we never learned is a different fact.
The editor also carries the capability card beside the price, because what a model is *for*
is the half that steers the orchestrator; its overrides save separately, since `rewter card
<model>` regenerates the card underneath and the override is what survives that.

A filter row above the table — query, provider, on/off — keeps that editable once the registry
is large. Pointing rewter at a running 9router takes it from a dozen rows to over a hundred, and
the search matches the **full** model id rather than the shortened one on screen, because
`zai/glm-5.3` and `9router/glm/glm-5.3` both display as something ending `glm-5.3` and the
provider prefix is the only thing that separates them. It matches capability-card tags too, so
"which of my models is good at OCR" is a question you can type. While narrowed the header says
`10 of 109 models`, because a bare small number on a large registry reads as a sync that went
wrong.

M7 closed live on 2026-08-29: a `uname -a` parked mid-orchestration, the card was answered in
the browser, and the same still-open stream carried on and finished with the kernel string.
The distinction from M6's run is which path resolved it — `resolvedBy: "dashboard"` — and the
daemon serving the page it was clicked on, which it had never actually done until
[#16](https://github.com/roowus/rewter/issues/16).

M8 is **daemonization**, and its first piece is **boot reconciliation**. A daemon killed by
`kill -9`, a reboot or an OOM leaves rows saying `running`, because the code that would have
written a terminal status died with the process. Every boot now closes them out — before the
socket opens, so nothing ever observes a task claiming to run with nothing behind it. They
are marked **`interrupted`**, deliberately not `failed`: a failure is a judgement that
something tried and did not work, and nothing judged these. Writing `failed` would tell you
six weeks later that a model got it wrong when the machine simply went away, and it would
teach the phase-2 learned stats the same untruth. The sweep goes through the ordinary
lifecycle guards, so the interruption is an event like any other and the dashboard replays
it rather than showing a task that just stops updating. Verified the blunt way on
2026-08-29: a tier-2 task in flight, `kill -9` on the listening process, and the restart
logged `interrupted by a previous shutdown: 1 task(s)` before the socket opened — with the
events from before the kill still sitting intact ahead of the new one.

Its second piece is **`rewter status` and `rewter stop`** — talking to a daemon this shell
did not start. `start` records where it bound in `~/.rewter/rewter.pid`, and neither of the
other two trusts the pid in it: a pidfile survives `kill -9` and reboots, and pids get
reused, so signalling one because a file mentions it is how a stop command kills an
unrelated process. Liveness is a **health probe against the URL the file records**. If the
port answers as something that isn't rewter, `stop` says so and refuses to signal; if
nothing answers, the file was stale and gets removed with a note that the last shutdown
wasn't graceful. When it *is* rewter, `stop` sends SIGTERM and waits for the port to go
quiet — never SIGKILL, because shutdown drains in-flight SSE streams and killing harder
mid-drain just hands the client a truncated event.

Its third piece is **living under launchd**, and every part of it follows from one fact:
launchd starts a process with a nearly-empty environment, so no `~/.zshrc` has run, no
`ANTHROPIC_API_KEY` is exported, and `PATH` is not something to rely on. Keys therefore come
from `~/.rewter/env`, read at boot and merged **under** the real environment so a variable
you exported just now still wins over a file you wrote once. It is separate from
`config.json` — that is the file people paste into issues — and being the only place a raw
key sits on disk, a loose mode is reported at boot. Reported, not refused: refusing would
leave a login daemon dead with its explanation in a log you don't yet know how to read.

`install-cli` is the same shape, one layer down: it symlinks the built entry point into
`~/.local/bin` so `rewter` is a word you can type anywhere. It links rather than copies, so
a rebuild needs no reinstall; it sets the execute bit `tsc` does not; and when the directory
is off `PATH` it prints the `export` line instead of editing your rc, for the same reason
`install-service` prints `launchctl` lines instead of running them. It also refuses to
overwrite a `rewter` it did not create without `--force`, in either direction — the checkout
is not the only thing that might own a four-letter name on your `PATH`.

`install-service` writes the plist with an absolute node and an absolute CLI path, and it
carries **no environment block at all** — `launchctl print` reads a plist back to anyone who
asks, which is exactly why the keys live somewhere whose permissions can be checked.
`KeepAlive` is conditional on failure, so a crash restarts and `rewter stop` isn't undone a
second later. Then it stops and prints the two `launchctl` lines rather than running them: a
tool holding your API keys shouldn't shell out on your behalf, and `bootstrap` is the part
that fails in ways worth reading.

Loaded here on 2026-08-29, and the daemon it starts is a real one: `/v1/models` answers, `/`
serves the dashboard, and folding the event log gives all three tasks of the previous session —
including the `interrupted` one — under a process that never ran any of them. One trap worth
naming: the plist records `process.execPath`, whichever node ran the install, so check it before
loading. The first node on this machine's `PATH` belongs to an unrelated project, and a
LaunchAgent that outlives reboots should not depend on one.

`rewter logs` reads the files rather than the daemon, because the case it exists for is a
daemon that is *not* running. Both streams are merged by timestamp with a stable sort, so a
stack trace stays under the error it followed — "it warned and then died" is only legible
merged, and launchd will only ever give you two separate files. Fields longer than 80
characters are dropped: a log reader is not the place to discover a leaked key.

`rewter gc` drops old finished tasks and their workspaces, and refuses two things. It never
collects a **cost record** — dropping a transcript is a storage decision, dropping its price
destroys the answer to "what did I spend in March" — and it never collects an **unfinished
task**, whatever its age.

## Quickstart

```sh
pnpm install && pnpm build
```

Write `~/.rewter/config.json` — name providers by preset slug, and export the keys
separately. **The config file never holds a key**: `apiKeyEnv` is the *name* of an
environment variable. Comments are fine (`//` and `/* … */`), so the annotations below can
stay in the file you paste this into.

```jsonc
{
  "providers": [
    { "preset": "anthropic" },              // reads $ANTHROPIC_API_KEY
    { "preset": "zai" }                     // reads $ZAI_API_KEY
  ],
  "models": [
    { "id": "anthropic/claude-sonnet-5", "provider": "anthropic", "contextWindow": 200000,
      "pricing": { "inputPerMTok": 3, "outputPerMTok": 15 } },
    { "id": "zai/glm-5.3", "provider": "zai", "contextWindow": 1000000,
      "pricing": { "inputPerMTok": 0.6, "outputPerMTok": 2.2 } }
  ]
}
```

Put the command on your `PATH` once, and it works from any directory:

```sh
pnpm build
node packages/cli/dist/index.js install-cli
# linked: ~/.local/bin/rewter
#   → ~/projects/rewter/packages/cli/dist/index.js
#
# `rewter` now works from anywhere. Try: rewter status
```

That is a **symlink into this checkout**, not a copy — `pnpm build` and the command is
already the new one, with no reinstall to forget. The flip side is that moving or deleting
the checkout breaks `rewter`, which is the honest outcome; a copy would keep answering with
a stale version instead. If the chosen directory is not on your `PATH`, the command says so
and prints the `export` line to add — it will not edit your shell rc. Use `--dir <path>` to
choose somewhere else, `--force` to replace a different `rewter` already sitting there, and
`rewter uninstall-cli` to remove it again (never a file that is not ours).

If `rewter` ever answers `permission denied`, re-run `rewter install-cli` — it re-arms the
execute bit `tsc` does not emit. `pnpm build` sets it too, so you should not need to.

Every command below assumes that. Without it, they are all
`node packages/cli/dist/index.js <verb>`.

```sh
export ANTHROPIC_API_KEY=… ZAI_API_KEY=…
rewter start
# rewter listening on http://127.0.0.1:20130 — 2 provider(s), 2 model(s)
```

Port **20130** is deliberately not 9router's 20128, so both can run side by side while you
switch. A provider whose key variable is unset still appears — seeded *disabled*, so asking
for its model gives a 503 that names it rather than a confusing "unknown model".

Open that URL in a browser and you get the dashboard — the same daemon serves the API and the
UI, so there is no second thing to start. The strip at the top is the daemon's own health:
uptime, version, how much of the registry is actually enabled, the database's footprint on
disk, and whether anything is parked on an approval gate — facts the process already had and
previously displayed nowhere. Below the task tree's controls sits the event log (expand
"events"): every event the daemon has written, newest first, filterable by type and task,
page back through history with "load older".

Expand "providers" and each one gets a **Test** button. It reads that provider's catalog with
the key it names — the same request `sync-models` makes, so it answers for the path that
matters, and it costs nothing to press. The answer says *where* the problem is, which is what
decides what you do about it: `no key` (the env var is unset, nothing left your machine),
`unreachable` (nothing came back), `refused` (the upstream answered and said no — your key is
wrong or not entitled), or `ok` with the number of models it listed. A few upstreams publish
no catalog and honestly report `untestable` rather than a guess. Nothing is ever echoed back
that could contain your key.

Before any task has run, the empty state says whether one *would* run: enabled providers,
enabled models, capability cards, and — if something is missing — the command that fixes it.
It distinguishes "a task would fail right now" (nothing to route to) from "this works but
picks badly" (no capability cards, so the orchestrator chooses on price alone). It disappears
once you have run anything.

Expand "translate" for the answer to "the model got something I didn't send". Paste a request
in either dialect and three panes show it becoming what the provider is actually handed:
what you sent, the normalized form both dialects converge on, and the exact upstream body and
URL — `max_tokens` turning into `max_completion_tokens`, a system prompt hoisted out of the
messages, a model id moving into the path. It re-renders as you type and sends nothing,
because it runs the same request builders the real route runs through an adapter whose
transport throws. A model that doesn't resolve still fills the first two panes and says why
the third is empty. Below them, one button does the opposite: **Test** sends a single real
completion to the model named in the box, because a perfectly-shaped request still can't tell
you whether the key works. It reports the answer, the tokens, and what it billed — and shows
up in the spend panel, because it was spend.

Each running task shows what it has spent against its ceiling, and lets you move the ceiling
while it runs — the whole point being that the moment you want a cap raised is the moment a
task is walking up to one, which used to mean editing the config file and restarting. Leaving
the field empty removes the cap; zero is refused, because "may not spend a cent" is not what
anyone meant. The reply says which of two things happened: a *running* task took the new cap,
or the row was saved with nothing executing under it. The number on screen doesn't move until
the daemon says it did.

Expand "run" to start an orchestration from the page rather than from a client. Type the
task, optionally pin who leads and what it may spend, press Run — and the panel tells you one
thing, which model ended up leading, because the task tree below is already showing you
everything else. It answers as soon as the task has an id rather than waiting for the answer,
so the run is not tied to the tab: close the browser and it keeps going, and the progress,
approvals, spend and final answer all arrive in the tree the same way they do for a task
started from Claude Code. Leaving the budget blank inherits whatever the daemon is configured
with; the word `uncapped` removes the cap. Asking it for a plain model gets you pointed at
the Test button above, which is the thing that wants one.

Expand "registry" and, beside the editor, two buttons move the whole thing to another machine.
A synced registry is hundreds of rows, and the capability cards over it cost real money to
generate; reproducing that on a laptop or after a reinstall should not mean re-running every
sync and re-billing every card. **Export** downloads models, cards and the corrections typed
over them as one JSON file — and no keys, structurally rather than by filtering: the file
format has four fields for a provider (id, name, kind, base URL) and nowhere to put a secret,
so a column added to the database tomorrow cannot leak into an old export. **Import bundle…**
goes the other way in three steps: pick the file and you get a preview of exactly what would
change, per model and per card, before anything is written. Change your mind about overwriting
and it re-previews rather than applying, so the counts always describe the button under them.
Nothing already here is ever deleted, and models whose provider this machine has never heard of
are reported by name with a count — an import never invents a provider, because the file
carries no credentials and a made-up upstream would only fail later, from inside a task.

The same thing without a browser, and without a running daemon:

```sh
rewter export-registry ~/rewter-registry.json --note 'before reinstall'
# wrote /Users/you/rewter-registry.json — 109 models, 12 cards, no keys

rewter import-registry ~/rewter-registry.json --dry-run
# models: 109 added
# cards: 12 added
# (dry run — nothing written)
```

`--overwrite` replaces rows that are already there (the default leaves anything local alone),
and an import that could not place some models because their provider is not configured here
exits non-zero, so a scripted one goes red instead of quietly landing half a registry.

At the foot of the page: a standing reminder that this is your machine — tasks, events, costs
and the registry live in a SQLite file here, and API keys are read from your environment by
name, never saved — and a **Shut down** button, since the daemon is otherwise stopped from a
terminal you may not have open. It asks first, and afterwards it tells you the truth about
what happens next: nothing on this machine restarts rewter by itself, so the message names the
exact command that does (`launchctl kickstart …` if you installed the service, `rewter start`
if you didn't). There is no Restart button on purpose — the LaunchAgent is configured so that
a clean stop *stays* stopped, which is what makes `rewter stop` reliable, and a Restart button
would be waiting on something deliberately not coming. If rewter can't tell what started it,
it says so rather than guessing. Watch the dot next to the title go dark for confirmation.

(If you are working on the dashboard itself, run `pnpm --filter @rewter/dashboard dev`
instead and use :5273, which proxies back here rather than rebuilding the bundle on every
keystroke.)

Point any OpenAI client at it:

```sh
curl localhost:20130/v1/models
curl localhost:20130/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"zai/glm-5.3","messages":[{"role":"user","content":"say hi"}],"stream":true}'
```

…or any Anthropic client, including **Claude Code**, at the same daemon — `/v1/messages`
speaks Anthropic's dialect over the same router, so every model above is reachable from it:

```sh
ANTHROPIC_BASE_URL=http://localhost:20130 ANTHROPIC_MODEL=zai/glm-5.3 claude
# ⚠ an `env` block in ~/.claude/settings.json *overrides* these — if you have one,
#   put the same values there, or pass `--settings <file>`. Otherwise the session
#   silently goes to whatever that file points at, and looks like it worked.

curl localhost:20130/v1/messages -H 'content-type: application/json' \
  -d '{"model":"zai/glm-5.3","max_tokens":64,"messages":[{"role":"user","content":"say hi"}]}'
```

Set `apiKeyEnv` in the config (default `REWTER_API_KEY`) and export that variable to require
a token on `/v1`. Both header conventions work against it — `Authorization: Bearer …` (what
OpenAI clients send) and `x-api-key` (what Anthropic clients send) — so one value covers
both surfaces. Leave it unset and the local daemon is open.

Other knobs: `--config <path>` / `REWTER_CONFIG`, `REWTER_PORT`, `REWTER_HOST`, `REWTER_DB`,
`--pidfile <path>` / `REWTER_PIDFILE`, `REWTER_ENV_FILE` (default `~/.rewter/env` — see
[Running it at login](#running-it-at-login-macos)).

### Reaching it from another device (Tailscale)

The easy way needs no rewter configuration at all. Leave the daemon on loopback and let
Tailscale carry it:

```sh
tailscale serve --bg https / http://127.0.0.1:20130
```

Dashboard, `/v1`, and `/internal` are now at `https://<machine>.<tailnet>.ts.net/` from
every device on your tailnet — TLS and identity are Tailscale's problem, and the port never
leaves the machine.

The direct way is binding the tailnet address yourself — and it **fails closed**. `/internal`
is approve/deny/kill/shutdown, so a non-loopback `host` refuses to boot until the internal
key is set:

```sh
echo 'REWTER_INTERNAL_KEY=<something long and random>' >> ~/.rewter/env
REWTER_HOST=100.x.y.z rewter start
```

Ops clients send it as `Authorization: Bearer …` or `x-api-key`. For the dashboard, visit
once with `?key=`:

```
http://100.x.y.z:20130/?key=<the key>
```

The page moves the key into a session cookie (which also rides the live-updates WebSocket)
and scrubs it from the URL. `GET /internal/health` stays open so `rewter status`/`stop`
keep working without the key. The internal key and `REWTER_API_KEY` gate different doors —
on a shared bind you likely want both set, or `/v1` is open to the same network.

From another terminal — or a script — ask whether one is up, and ask it to stop:

```sh
rewter status
# rewter 0.1.0 running on http://127.0.0.1:20130, pid 51234, up 3h — 2 provider(s), 2 model(s)

rewter stop
# stopped (pid 51234)
```

`status` exits 0 only when a daemon is really there, so `rewter status && …` behaves. It
answers by *asking the port*, not by reading a pid — so a leftover pidfile reports as stale
(and `stop` removes it) instead of sending a signal to whatever now owns that number.

### Running it at login (macOS)

Put the keys where a process with no shell can find them, then write the plist:

```sh
umask 077 && cat > ~/.rewter/env <<'EOF'
ANTHROPIC_API_KEY=sk-ant-…
ZAI_API_KEY=…
EOF
chmod 600 ~/.rewter/env

rewter install-service
# written: ~/Library/LaunchAgents/com.roowus.rewter.plist
#
# put your keys in ~/.rewter/env (chmod 600), then:
#   launchctl bootout gui/$(id -u)/com.roowus.rewter 2>/dev/null || true
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.roowus.rewter.plist
```

It prints those two lines instead of running them on purpose — a tool holding your API keys
shouldn't shell out on your behalf, and `bootstrap` fails in ways worth reading yourself
(`bootout` goes first because `bootstrap` on an already-loaded label fails with a bare code).
Run them and rewter comes up at every login. `--dry-run` prints the plist without writing;
an existing plist that differs is never clobbered, so a key you added by hand survives until
you pass `--force`. `uninstall-service` removes it again.

The plist contains **no environment block** — anything in it is readable by `launchctl
print`, whereas `~/.rewter/env`'s mode is something rewter can check and complain about. A
variable exported in your shell still overrides the file for that run.

When it's launchd starting the daemon, there's no terminal to watch:

```sh
rewter logs -n 50            # both streams, merged by time
rewter logs --level warn     # the "why didn't it start" filter
```

### Housekeeping

Every orchestration appends events, work items and worker runs, plus a workspace directory
per tier-2 task. `gc` collects the finished ones:

```sh
rewter gc --older-than 30 --dry-run
# would remove 12 task(s) finished before 2026-07-30:
#   4831 event(s), 39 work item(s), 44 worker run(s), 7 approval(s)
#   12 workspace director(ies)
#   cost records kept — spend history outlives task detail
#   (dry run — nothing was deleted)
```

**Cost records are never collected** — they carry a nullable task id and no foreign key
precisely so that "what did I spend in March" keeps working after March's transcripts are
gone. Unfinished tasks are never collected either, whatever their age. Add `--vacuum` to
actually give the pages back to the filesystem; it's opt-in because `VACUUM` needs room for
a second copy of the database and locks the whole of it while it runs.

### Filling the registry automatically

Hand-writing the `models` array gets old fast. `sync-models` reads each provider's own catalog
instead — it opens the same database the daemon uses, so it works whether or not the daemon is
running:

```sh
rewter sync-models
# openai: 84 added, 0 updated
# openrouter: 319 added, 0 updated
# New models arrive disabled; enable the ones you want in the config or dashboard.
```

New models arrive **disabled** — a catalog is hundreds of rows, and enabling all of them would
bill against models you never chose. Most upstreams publish an id list and nothing else, so
OpenRouter's prices fill the gaps in the others by default (`--no-enrich` opts out). Sync never
overwrites a model you wrote by hand — it only fills the fields you left blank — and never
deletes: a model that disappears upstream is disabled, so the cost records pointing at it keep
their referent.

`--dry-run` reports without writing; `--provider <slug>` scopes to one.

### Capability cards

A card is what the orchestrator will read to decide which model gets which subtask. One model
writes them for the others:

```sh
rewter card zai/glm-5.3 --using anthropic/claude-sonnet-5
# zai/glm-5.3
#   summary:    Cheap 1M-context workhorse; strong at code, weak at hard math.
#   best at:    coding, long_context
#   strengths:  coding, long_context, fast_cheap
#   weaknesses: math
#   written by: anthropic/claude-sonnet-5
```

`--using` is required and has no default: the model that writes the cards is billed, and its
judgement is what the router acts on for the life of the card. A bare `card` is not "do them
all" either — a synced registry is hundreds of rows, so pass `--all` (all *enabled* models) if
that is what you want. A model that already has a card is skipped unless `--regenerate`.

Regenerating is always safe: generation writes only the generated half of a card, so a hand
correction you made in the dashboard survives it. `--show` prints stored cards without calling
anything; `--dry-run` prints what it would store.

Generators are unreliable narrators, so the parser is forgiving in one direction only: invented
tags are dropped, a fenced or prose-wrapped reply is dug out, an over-long summary is trimmed,
and a tag claimed as both a strength and a weakness is kept as the **weakness** — a false
strength gets a model picked for work it bills for and fails at, while a false weakness only
costs an option. Everything it discarded is printed, not swallowed.

The prompt also forbids stating any specification it was not given — parameter counts, cutoffs,
benchmark numbers. A bad tag gets dropped; invented prose gets stored and quoted back as fact,
and the router cannot check it. Judgement about what a model is good at is the job; the specs we
already have are handed to the generator rather than asked for.

### Orchestrating

Ask for the model `auto/orchestrator` and you get an orchestration instead of a model call —
same endpoint, same wire format, any client:

```sh
curl -N localhost:20130/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"auto/orchestrator","stream":true,
       "messages":[{"role":"user","content":"summarize these 3 URLs and compare them"}]}'
# ◆ plan: fetch each page, then compare
# ▶ [w1 · zai/glm-5.3 · tier1] summarize URL 1 — started
# ▶ [w2 · zai/glm-5.3 · tier1] summarize URL 2 — started
# ✔ [w1] done ($0.0021, 3.4s)
# …then the synthesized answer
```

Progress arrives as ordinary assistant text, so a client needs no rewter awareness to show it.
`auto/orchestrator:<model-id>` pins the initiator; otherwise the selected project's pin (below),
then the configured default, falling back to the most expensive enabled model not *known* to
lack tools — a model a catalog reported tool-capable outranks one nobody vouched for, and only
a reported denial disqualifies.

`auto@<project-slug>` (or the `x-rewter-project` header — they must agree if both are sent)
runs the task **under a project**: the initiator sees the project's pinned repos/dirs/URLs and
model preferences, the task's workspace defaults to the project's primary directory, and the
project's policy folds in tighten-only — a project can force approval gates on or lower the
spending cap, never the reverse. `auto@myproj:zai/glm-5.3` combines both. Unknown slugs 404,
archived projects refuse with a 400 that says so.

That output is real, not illustrative: an `orchestrator` block in the config sets who leads and
what a task may spend, and a request that says nothing about settings inherits both.

```jsonc
"orchestrator": {
  "initiatorModel": "anthropic/claude-sonnet-5",  // else: priciest tools-capable model
  "maxSpendUsd": 1,          // per task; the initiator is refused a spawn past it,
                             // and the dashboard can move it mid-run
  "concurrency": 4,          // parallel workers per task
  "maxTurns": 24, "maxHandoffs": 2   // runaway guards, not targets
}
```

Left to itself the initiator tends to keep the money where it belongs — asked for three facts
in parallel, a Sonnet-class leader put all three workers on a flash-class model and spent
$0.005 total.

Every orchestration response carries an **`x-rewter-task-id`** header. Re-POST the same
conversation with one more user turn while it is still running and that turn is delivered to
the initiator as steering — the task carries on, and the new request attaches to the stream
already in flight rather than starting a second, separately-billed orchestration. Echoing the
header back does the same thing without relying on the conversation matching. Disconnect and
reconnect within 30 seconds and you adopt your task, replaying whatever you missed; stay gone
and it is cancelled, so an interrupted client does not leave workers billing to nobody.

### Chatting from the terminal

`rewter chat` is the native client for exactly that steering loop — and the prompt **stays
live while the task runs**. The feed renders above it; anything you type mid-run is delivered
immediately, without waiting for the turn to end:

```sh
rewter chat summarize these 3 URLs and compare them
# · task task_k3j9x2mwpq4a
# ◆ plan: fetch each page, then compare
# ▶ [w1 · zai/glm-5.3 · tier1] summarize URL 1 — started
› also note which one is the most recent        ← typed while w1 is still running
# · queued for the initiator: also note which one is the most recent
# ⏸ approval needed (apr_x9…) — shell: curl …
› approve apr_x9
# · 1 approval command(s) applied
```

Typed lines go through the daemon's one steering grammar: `approve`/`deny` resolve pending
approvals on the spot, everything else queues for the initiator at the next turn boundary —
and the echo tells you which happened. `--model` picks something other than
`auto/orchestrator`, `--project <slug>` runs under a project, and `--url http://…` targets a
daemon on another machine (a tailnet, say) instead of the local pidfile. Ctrl-C cancels the
task on the daemon — settling it and stopping the spend — not just your socket.

## Development

```sh
pnpm install
pnpm check     # build → typecheck → lint → test; the gate CI runs, and the one to run locally
pnpm build     # build all packages
pnpm test      # run all tests
pnpm lint      # biome
```

Run `pnpm check` before committing rather than `pnpm test`: vitest transpiles with esbuild and
never invokes `tsc`, so a green test run does not mean the code compiles. CI runs the same
single command, so local green and CI green mean the same thing.

Requires Node ≥ 22 and pnpm 10.

## License

[MIT](LICENSE)
