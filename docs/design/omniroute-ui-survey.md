# OmniRoute UI/UX survey — what a 118-route router dashboard actually contains

> **Status:** survey only. Nothing in this document has been implemented in rewter, and
> **no code was copied from OmniRoute for any of it.** This is a written record of another
> product's interface, made so we can decide which parts are worth building ourselves.
>
> **Subject:** [`diegosouzapw/OmniRoute`](https://github.com/diegosouzapw/OmniRoute) — MIT,
> ~58k stars, v3.8.51, surveyed at commit `38e2baa` (2026-08-29). Next.js App Router +
> pnpm workspace + Electron shell + Docker. Self-described as "one endpoint, 350 providers
> (90+ free), 1200+ models".
>
> Sources read: `src/shared/constants/sidebarVisibility/sections.ts` (the authoritative
> nav), `sidebarVisibility.ts` (presets/ordering), `DashboardLayout.tsx`, `Sidebar.tsx`,
> `Header.tsx`, `Breadcrumbs.tsx`, `CommandPalette.tsx`, `FilterBar.tsx`, `ColumnToggle.tsx`,
> the activity-feed components, and the nine shipped screenshots under `docs/screenshots/`.
>
> Related: rewter's own dashboard is described in
> [ARCHITECTURE.md → the dashboard app](../ARCHITECTURE.md#the-dashboard-app-one-store-one-clock-m7c).

## Why this document exists

rewter's dashboard is one page: a task tree, approval cards, a costs panel, a registry
editor. No router, no query layer, no tabs. That is a deliberate consequence of the
architecture — the daemon's answer to "what is happening" *is* the event stream, and the
fold that turns it into a tree lives in `shared`. It is also, as observed in use, **thin**.

OmniRoute is the opposite extreme and a useful one to measure against: 118 dashboard routes
under `src/app/(dashboard)/`, ten sidebar sections, a command palette, and per-user
customisation of the navigation itself. Most of it is scale rewter does not have and should
not fake. A minority of it is genuinely missing capability. This document separates those
two, per surface, so the implementation conversation starts from evidence rather than from
"the dashboard is lacking".

Verdicts used throughout:

- **ADOPT** — rewter has the data and lacks the surface. Worth building.
- **ADAPT** — the idea transfers, the form does not; rewter's version looks different.
- **SKIP** — belongs to a product of a different scale or a different feature set.

---

## 1. The structural idea worth stealing: navigation as data

This is the single most transferable thing in the codebase, and it is a *shape*, not a
component.

OmniRoute's entire navigation is one exported constant — `SIDEBAR_SECTIONS`, an array of
sections, each with `id`, `titleKey`, `titleFallback`, `children`, and optional
`visibility: "debug"`. A child is either an item or a group (`type: "group"`, itself holding
items). An item is:

```ts
{ id: "combos-live",
  href: "/dashboard/combos/live",
  i18nKey: "combosLive",
  labelFallback: "Combo Studio",
  subtitleKey: "combosLiveSubtitle",
  subtitleFallback: "Live routing cascade",
  icon: "account_tree" }
```

Optional per item: `featureFlagKey` (e.g. `RADAR_ENABLED`), `external`, `exact`.

Everything else is *derived* from that array:

- the sidebar renders it;
- the command palette flattens it into a searchable list, keeping section and group labels
  as match keys and as result headers;
- `Breadcrumbs` maps URL segments back to labels;
- `Header` derives the page title and icon from the current path by looking the item up;
- the "hide items" setting stores a list of item ids;
- the five sidebar **presets** (`all`, `essentials`, `minimal`, `developer`, `admin`) are
  defined as *shown* sets and inverted into hidden-lists by `buildHiddenList()`, so adding a
  new nav item defaults to hidden-in-preset rather than silently appearing everywhere;
- user reordering is `applySectionOrder` / `applyItemOrder` — an id list, with unknown ids
  filtered and unlisted ids appended in their original order, so a stale saved order never
  drops an item.

Two details worth keeping if we ever build this:

- **Feature flags fail open.** The source comment is explicit: *"Fails open (see
  `isSidebarItemVisibleForFlags`) so a missing key never hides an unrelated item."* A flag
  system that hides things on a lookup miss makes every deploy a game of "where did that
  page go".
- **Labels have inline fallbacks.** `labelFallback` sits beside `i18nKey`, and the palette's
  `safeTranslate` returns the fallback when the key is absent. A missing translation degrades
  to English, not to a raw key on screen.

**Verdict: ADAPT (later, and only if the page count justifies it).** rewter has one page.
A declarative nav array for four panels would be ceremony. But *if* the panels below get
built and the page splits into views, the nav should be data from the first one, not a
hand-written list that the palette and breadcrumbs then duplicate — the duplication is the
thing that rots.

---

## 2. The shell

`DashboardLayout.tsx` composes: `NavigationProgress` (a route-transition bar, in Suspense),
a desktop sidebar plus a mobile drawer with a `bg-black/20` overlay, `Header`,
`MaintenanceBanner`, a scrolling content column with `Breadcrumbs` above `{children}`,
`NotificationToast`, and `CommandPalette`.

| Element | What it does | Verdict for rewter |
|---|---|---|
| **Cmd/Ctrl+K command palette** | Layout-level keydown toggle; fuzzy-ish substring match over label, subtitle, section and group name; ↑/↓ to move, Enter to navigate, Esc to close; results grouped by section then subgroup; external items open in a new tab | **SKIP for now** — a palette over four panels is a worse tab bar. Revisit if the nav ever exceeds ~15 destinations |
| **Breadcrumbs** | Derived from `usePathname()` via a segment→label map, no props | **SKIP** — one page has no hierarchy |
| **Page title + icon in the header**, looked up from the nav definition | Title/subtitle never drift from the sidebar label | **ADAPT** if views land |
| **Sidebar collapse**, persisted to `localStorage["sidebar-collapsed"]`; tooltips on hover when collapsed (`HoveredItem {id,label,x,y}`) | | SKIP |
| **Content width `max-w-[3840px] mx-auto`** | Fluid up to a 4K cap. Their commit note: the prior 1280px cap "left big empty margins on wide screens" | **ADOPT (trivial)** — rewter's panels are tables and a task tree; both benefit from width, and this is one CSS line |
| **Sticky Restart / Shutdown at the sidebar foot**, each behind a confirm modal | Operating the daemon from its own UI | **ADOPT** — see §6 |
| **Header cluster**: theme toggle, health dot, language picker, logout | The health dot is the useful one: a persistent, always-visible liveness indicator | **ADOPT the health dot** (rewter has a socket-status concept already — it just isn't prominent); SKIP the rest |
| **Toasts** (`NotificationToast`) | | ADAPT — rewter currently reports action outcomes inline on the card that caused them, which is *better* for approvals (see ARCHITECTURE) and worse for everything else |

---

## 3. The ten sections, in full

Recorded verbatim from `sections.ts` because the labels and subtitles are the survey — a
route list without them tells you nothing about what a page is *for*.

### 3.1 Home
Single item `/home` (section title hidden). The page (`HomePageClient.tsx`) is a
first-run/quick-start surface: a "Quick Start" numbered card grid, a provider-topology
section, a tier-coverage widget, a first-run readiness card, an update/version banner with an
in-app updater (progress modal with per-step status: spinner / check / error), plus several
sponsor and news banners.

**Verdict: ADOPT a much smaller version.** rewter has no landing state at all — an operator
who starts the daemon and opens the dashboard sees an empty task tree and no indication of
whether anything is configured. A readiness card ("N providers configured, M models enabled,
API listening on :20130, daemon up 4m") is a real gap. The banners and the updater are SKIP.

### 3.2 OmniProxy — the routing surface
Root items: **Endpoints**, **API Key Manager**, **Providers**, **Embedded Services**,
**Combos**, **Combo Studio** (`combos/live`, "Live routing cascade"), **Provider Quota**,
**Costs Quota Share**. Then three groups and a trailing item:

- **Compression Context** (14 items) — Compression Settings ("Global defaults"), Combos,
  Caveman, RTK, Headroom ("Tabular compaction"), Session Dedup ("Cross-turn dedup"), CCR
  ("Retrieve markers"), LLMLingua ("Semantic pruning"), Lite ("Fast whitespace cleanup"),
  Aggressive ("Summary + aging"), Ultra ("Heuristic pruning"), OmniGlyph
  ("Context-as-image"), Compression Studio ("Live engine cascade"), Exclusions
  ("Per-model/endpoint bypass").
- **Tools** — CLI Code, CLI Agents, ACP Agents, Cloud Agents, Conductor ("CLI-agent fleet"),
  Agent Bridge, Traffic Inspector, Discovery.
- **Integrations** — API Endpoints, Webhooks.
- **Proxy** (`system/proxy`).

**Providers** (screenshot `01`/`MainOmniRoute`) is the densest page in the product and the
most instructive:

- search box, a "Configured only" toggle, a "Test All" action;
- a **chip row of counts**, each `configured/total`: `Total 32/151`, `Free 11/27`,
  `OAuth 5/10`, `API Key 25/132`, `IDE 0/3`, `Compatible 3/3`, `Web Cookie 0/10`,
  `Search 5/11`, `Audio 4/7`, `Local 0/11`, `Cloud Agent 0/3`;
- provider **cards grouped by category** (API Key Compatible / Free Tier / OAuth), each with
  a logo, a status dot, an "N Connected" badge, and an enable toggle;
- per-group "Test All" and "+ Add Anthropic/OpenAI Compatible" buttons;
- an **"Import providers from file"** wizard — CSV or JSON, `provider,name,apiKey,baseUrl?,priority?`,
  with per-row errors and a skipped count.

**Combos** (screenshot `02`) is one card per combo: name, a **strategy badge**
(ROUND-ROBIN / PRIORITY / WEIGHTED / COST-OPTIMIZED / LEAST-USED / RANDOM), and member-model
chips with a "+3 more" overflow.

**Verdicts:**

- **Provider category counts as chips — ADOPT.** rewter has 28 provider presets and a
  registry where ~100 of 109 synced models arrive `enabled: false` by design. "9 of 109
  enabled" is exactly the fact an operator needs on arrival and currently has to count by
  scrolling.
- **Per-provider "Test" / "Test All" — ADOPT.** rewter can construct an adapter and send a
  one-token request; there is no button for it, so the only way to find out a key is wrong is
  to run a task and read the failure.
- **Grouping provider cards by auth category — ADAPT.** rewter's equivalent axis is
  local-vs-hosted and free-vs-paid, which is what the initiator's cost discipline turns on.
- **Combos — SKIP as a feature, but note the overlap.** A combo is a static routing cascade
  the *user* configures. rewter's whole thesis is that the *initiator* makes that choice per
  subtask from capability cards. Building combos would be building the thing rewter exists to
  replace. The **strategy badge as a visual vocabulary** is worth borrowing for how we display
  a chosen route.
- **Compression (14 pages) — SKIP.** A different product feature. Worth noting that
  OmniRoute treats prompt compression as a first-class routing-time concern with per-engine
  pages and an exclusions list; if rewter ever compresses the registry digest (issue #8 is
  adjacent — digest budget is chars, not tokens), the "exclusions / per-model bypass" idea is
  the part to remember.
- **Import providers from file — ADAPT, and this is the shape of the user's asked-for
  "import credentials n data" feature.** Note what OmniRoute does *not* do: it does not read
  another tool's credential store off disk. The user hands it a file. The parser is
  deliberately dependency-free and does **not** validate provider ids client-side — catalog
  validation is server-side. If rewter builds an import, an explicit user-provided file is the
  design to copy, and it keeps us clear of the standing rule that credential stores are not
  scanned unless the user names the path.

### 3.3 Analytics
**Usage**, **Combo Health**, **Utilization**, **Cache**, **Compression**, **Search**,
**Evals**, **Provider Stats**.

Screenshot `03` shows: sub-tabs "Overview | Evals", a **time-range segmented control**
(1D / 7D / 30D / 90D / YTD / All), fourteen stat cards (Total Tokens, Input, Output, Est.
Cost, Accounts, API Keys, Models, Avg Tokens/Req, Cost/Request, I/O Ratio, Top Model, Top
Provider, Busiest Day, Providers), a **GitHub-style contribution heatmap**, "Most Active Day"
and "Weekly" panels, and "Token & Cost Trend" / "Cost by Provider" charts.

**Verdict: ADOPT the time-range control and three or four of the cards; SKIP the rest.**
rewter's costs panel already aggregates `CostRecord` rows and already has a `groupBy`. It has
no time window at all, which means it answers "what has this cost since the beginning of
time" — a number that stops being interesting on day three. `1D/7D/30D/All` over the existing
aggregation is a small, high-value change. Of the fourteen cards, the ones rewter can honestly
compute today are Total Tokens (in/out), Est. Cost, Top Model, Cost/Request. **Do not** add a
card the data cannot fill: an "Accounts" tile that always says 1 is furniture.

### 3.4 Costs
**Overview**, **Pricing**, **Budget**, **Free Tiers**, **Free Provider Rankings**, **Radar**
(gated on `RADAR_ENABLED`).

**Verdict: ADOPT "Budget"; ADAPT "Pricing".** rewter *has* a budget concept —
`Task.settings.maxSpendUsd`, a soft threshold that injects a note and a hard cap that forces
`ask_user` — and it is invisible and unsettable in the UI. That is a feature already built
and unreachable. "Pricing" maps onto rewter's per-model pricing, which is editable in the
registry editor already; a dedicated page is not needed. Free-tier rankings: SKIP (it is a
catalog-scale feature).

### 3.5 Monitoring
**Activity**; then groups: **Logs** (Logs, Proxy, Console, Timeline, Conversations),
**Audit** (Audit Log, MCP, A2A), **System** (Health, Runtime, Resilience Connections).

The **Activity feed** is a chronological audit stream grouped by day (`groupByDay`, a
`DayHeader` per group, an `EventTypeFilter`), with a proper empty state — icon, title,
description, `role="status" aria-live="polite"`.

**Request Logs** (screenshot `08`) is the richest table in the app and its controls are worth
listing precisely, because rewter's event log is *more* structured than this and has none of
them:

- **Logger | Proxy** sub-tabs;
- a **Recording** toggle (live tail on/off);
- a search box ("Search model, provider, account, API key, combo");
- four dropdowns: All Providers, All Models, All Accounts, All API Keys;
- an inline **count summary**: `300 total · 269 OK · 31 ERR · 1 keys · 300 shown`;
- a sort control (Newest) and a manual refresh;
- a **quick-filter chip row**: All / Errors / Success / Combo, then one chip per provider,
  toggled on click;
- a **COLUMNS** row of toggles (Status, Model, Provider, Protocol, Account, API Key, Combo,
  Tokens, Duration, Time) — backed by the shared `ColumnToggle` primitive;
- the table itself: colour-coded status badges (401 amber, 200 green), provider badges in
  brand colours, per-row `I: n O: n` token counts, duration in ms, time.

**Health** (screenshot `04`) is a status page: a green "All systems operational" banner, an
"Updated HH:MM:SS" timestamp with a refresh button, four hero cards (Uptime, Version + Node
version, Memory RSS + heap, Providers + healthy count), then Latency (p50/p95/p99 + total
requests), Prompt Cache (entries `0/200`, hit rate, hits/misses), Signature Cache, and a
Provider Health panel showing **circuit-breaker** state with an honest empty state: *"No
circuit breaker data available. Make some requests first."*

**Verdicts:**

- **Health page — ADOPT, and this is the biggest single gap.** rewter's daemon already
  knows uptime (pidfile + health probe, M8), version, its own listening port, provider count,
  enabled-model count, and DB path/size. It exposes `GET /internal/health` and shows none of
  it. Latency percentiles are computable from `CostRecord`/run timings. Circuit-breaker state
  is not yet a rewter concept (retry lives in the router layer); that row would be a lie and
  should be left out until it isn't.
- **Filtered, column-toggled request log — ADAPT, high value.** rewter's `/internal/events`
  is an ordered durable log with typed payloads, and the dashboard currently only folds it
  into a tree. There is no way to *look at the log*. A filterable event table (by task, by
  payload type, by time) is the missing debugging surface, and the M8 live-run note about
  polling a point-in-time route versus reading the ordered log is exactly the lesson that
  surface would teach an operator.
- **Recording toggle — SKIP.** rewter's log is durable by construction; there is nothing to
  turn off.
- **Day-grouped activity feed with a real empty state — ADOPT the empty-state discipline
  at minimum.** rewter's panels mostly render nothing when empty.
- **Audit / MCP / A2A / Conversations — SKIP** (not rewter features).

### 3.6 Dev Tools (`visibility: "debug"`)
**Translator**, **Playground**, **Search Tools**.

The **Translator** (screenshot `05`) is a format converter with four sub-tabs — Playground,
Chat Tester, Test Bench, Live Monitor — a source/target format pair (Claude ↔ OpenAI ↔ Gemini
↔ Responses API) with a swap button, and side-by-side Monaco input/output panes with
copy/clear.

**Verdict: ADOPT a narrow version — and this one is unusually well-matched to rewter.**
rewter serves *two* dialects over one router (`/v1/chat/completions` and `/v1/messages`) and
normalises both into a single internal `StreamChunk` union enforced by
`describeAdapterContract()`. A panel that takes a request in either dialect, shows the
normalized form, and shows what would be sent upstream is a debugging tool that falls almost
directly out of code that already exists. The "Chat Tester" tab — send a prompt to one chosen
model and watch it stream — is the second-most-useful thing here and is how you'd verify a
provider without leaving the UI.

Note the `visibility: "debug"` mechanism itself: a whole section that only appears in debug
mode. Cheap way to ship an operator tool without cluttering the default view.

### 3.7 Agentic Features
**Memory**, **Agent Skills**, **Chaos Mode** ("Multi-model parallel execution"), **Omni
Skills**, **MCP**, **A2A**, **Plugins**.

**Chaos Mode** is the closest thing OmniRoute has to rewter's orchestrator — fan a prompt to
several models in parallel. Its page is built from a config client plus hooks for data,
persistence, and a test run (`useChaosConfigData`, `useChaosConfigPersistence`,
`useChaosTestRun`).

**Verdict: SKIP the section, but note the framing.** Chaos Mode is fan-out *without*
synthesis — the user compares outputs. rewter's fan-out is a means to an end and the
initiator does the comparing. The transferable piece is that they gave parallel execution its
own configurable page with a **test-run** affordance: "run this configuration once, now, and
show me". rewter has no way to try an orchestration from the dashboard at all — every task
must originate from a client. That is worth having.

### 3.8 Other Features
**Gamification** group (Leaderboard, Profile, Tokens), **Media**, **Batch** group (Batch,
Batch Files).

**Verdict: SKIP entirely.** Gamification is a community-product feature for a 450-contributor
project. Batch is a provider API rewter does not expose.

### 3.9 Configuration
Twelve settings pages: **General, Appearance, AI, Modality Bridge, Global Routing,
Resilience, Advanced, Security, Access Tokens, Feature Flags, Cache, Sidebar**.

Screenshot `06` shows Settings rendered as a **tab strip** (General / AI / Security /
Routing / Resilience / Advanced) over cards. The General tab contains:

- **System & Storage** — a `sqlite` badge, the database path (`~/.omniroute/storage.sqlite`)
  and size (9.9 MB) shown as read-only fields, **Export Database** / **Import Database**
  buttons;
- **Backup & Restore** — "Last Backup 17/02/2026, 23:40:22 (2m ago)", a **Backup Now**
  button, a **View Backups** button, and a plain-language retention policy: *"Database
  snapshots are created automatically before restore and every 15 minutes when data changes.
  Retention: 24 hourly + 30 daily backups with smart rotation."*
- **Appearance** — a dark-mode switch plus a Light / Dark / System segmented control;
- a footer: version and "Local Mode — All data stored on your machine".

**Verdicts:**

- **Settings as a tabbed page — ADAPT.** rewter's config lives in a file
  (`~/.rewter/config.*`) plus `~/.rewter/env`, and the dashboard cannot change any of it.
  The subset worth making editable is small and specific: concurrency, budget defaults, the
  auto-approve toggle, the read-only command allowlist.
- **Export / Import Database — ADAPT, carefully.** This is the second face of the user's
  "import credentials n data" ask, and OmniRoute's version is a whole-DB export/import. For
  rewter the honest version exports the registry (models + capability cards + overrides) and
  not the event log, and it must respect the standing rule: **`apiKeyRef` is an env-var name;
  raw keys are never in the DB and must never be in an export.**
- **"Local Mode — all data stored on your machine" as a persistent footer — ADOPT.** rewter
  is a localhost daemon and says so nowhere in its UI.
- **Backup with a stated retention policy — SKIP for now** (SQLite + WAL, and the user's data
  here is a log they can re-derive), but the *pattern of stating the policy in the UI in
  plain language* is good and cheap.
- **Feature Flags page — SKIP.** rewter has no flags.

### 3.10 Help
**Docs** (external), **Issues** (external, straight to the GitHub issue tracker),
**Changelog**.

**Verdict: ADOPT the Issues link (one line, and rewter's tracker is where five parked issues
live); SKIP the rest.**

---

## 4. Per-user navigation customisation

A whole settings page (`settings/sidebar`) exists to reshape the nav: hide individual items,
hide group labels, reorder sections and items by drag, pin sections open, recolour item
icons, set a custom app name and logo, and apply one of five **presets**.

**Verdict: SKIP, and worth saying why.** This is what a 118-route nav costs — the product
needs a feature to hide its own features, and the presets exist because no single default
serves everyone. It is a symptom, not an aspiration. rewter's answer to nav complexity should
be to not have any.

---

## 5. Shared in-page primitives

Small, reusable, and the reason 118 pages feel like one product:

| Primitive | Shape | rewter |
|---|---|---|
| `FilterBar` | search input + declarative `filters: [{key, label, options}]` + `activeFilters` + a Clear that resets search *and* every filter | **ADAPT** — rewter's registry filter is bespoke; a second table (an event log) would duplicate it |
| `ColumnToggle` | `columns`/`visible`/`onToggle` dropdown, closes on outside mousedown | ADOPT if the event table lands |
| Count summaries beside filters (`300 total · 269 OK · 31 ERR · 300 shown`) | Tells you what the filter *did* | **ADOPT** — cheap, and it is the fix for "I filtered and now I don't know if it's empty or broken" |
| Quick-filter chip rows | Toggleable chips for the highest-cardinality facet | ADAPT |
| Status badges with semantic colour (401 amber, 200 green) and brand-coloured provider badges | Scannable tables | ADOPT |
| Skeleton loaders (`CardSkeleton`; screenshot `07` is a page mid-load) | Layout-stable loading | ADAPT |
| Empty states with icon + title + description + `aria-live` | | **ADOPT** |
| Segmented controls (time range, theme) | | ADOPT |
| Confirm modals on destructive actions | | ADOPT — see §6 |

---

## 6. Daemon control from the UI

Sticky **Restart** and **Shutdown** buttons at the foot of the sidebar, each behind a confirm
modal, plus a header health dot and a "disconnected" detection path in the sidebar.

**Verdict: ADOPT Shutdown; think hard about Restart.** rewter's CLI already has
`rewter stop` and a health-probe `status`, and M8 established that the daemon under launchd
is restarted by launchd. A dashboard Shutdown button is `POST /internal/shutdown` over a
localhost-bound API and is genuinely useful. Restart is subtler: under launchd, "shutdown"
*is* "restart", and a button that says Restart while relying on launchd to do half the work
is the kind of thing that behaves differently when someone ran `--foreground`. If it ships, it
must report which happened — the same honesty the kill button's `aborted: true|false` already
gives (see [ARCHITECTURE → Kill: who writes the row](../ARCHITECTURE.md#kill-who-writes-the-row-m7d)).

---

## 7. Shortlist

If we implement from this survey, roughly in value order:

1. **Health / status panel** — uptime, version, port, DB path + size, provider and
   enabled-model counts, latency percentiles. Everything but the percentiles is already known
   to the daemon and shown nowhere. **DONE 2026-08-29** — `DaemonHealthSchema` +
   `HealthPanel`, percentiles deliberately omitted (nothing is instrumented; see
   ARCHITECTURE.md → Health).
2. **Event-log table** — filter by task / payload type / time, toggleable columns, count
   summary. rewter's log is its best asset and is currently only readable as a tree.
   **DONE 2026-08-29** — server-side `?latest=&before=&type=` window on `/internal/events`
   + `EventsPanel` (type/task filters, load-older paging; column toggles dropped as
   chrome — four columns fit; time filter is the paging itself). See ARCHITECTURE.md →
   "The event log, as a table".
3. **Time-range control on costs** (1D/7D/30D/All) + three or four honest stat cards.
   **DONE 2026-08-30** — rolling windows through the endpoint's existing `since`, defaulting
   to 7D; "All" omits the param rather than sending `0`, so the empty state can tell a quiet
   window from an unused daemon. Four cards, each a field of the summary (cost/request,
   tokens, cache, top bucket) — no card the data cannot fill, same rule that kept latency off
   the health strip. See ARCHITECTURE.md → Costs.
4. **Provider/registry readiness** — category count chips, a per-provider Test button, a
   landing "readiness" card. **DONE 2026-08-30** — all three, at three different reaches:
   `POST /internal/providers/:id/test` probes the real upstream with a *catalog* read (bills
   nothing) and returns one of five verdicts separated by where the failure is, always as a
   200 — an upstream refusing is a successful test. Chips count `local/free/paid/unpriced`,
   with `local` derived from a null `apiKeyRef` and `unpriced` kept distinct from `free`
   (opposite facts, same `$0`). The landing card is a judgement, not more counts: it splits
   *blocked* (nothing to route to) from *degraded* (no cards — starts fine, picks on price
   alone), and vanishes once any task exists. See ARCHITECTURE.md → Readiness.
5. **Dialect/translation debug panel** — request in either dialect → normalized form →
   upstream form; plus a one-model chat tester. **DONE 2026-08-30** — `POST
   /internal/translate` answers all three stages by running the *same* builders the real
   route runs (`describeRequest` on the adapter, pinned to `stream()` by per-adapter
   equivalence tests), through a describe-only adapter whose transport throws — so the
   panel cannot describe a request nobody would send, and cannot accidentally send one.
   The chat tester is deliberately the opposite bargain and is drawn that way: `POST
   /internal/chat-test` is the only `/internal` route that spends, so it goes through
   `router.complete()` (real resolution, real quirks, real cost recording — a test drive
   shows up in the spend panel because it was spend), caps `maxTokens` at 1000 with a
   default of 256, and reports `usage` plus a `costUsd` that is `null` rather than `$0`
   when the model is unpriced. Upstream refusals come back at the upstream's own status in
   the upstream's own words. See ARCHITECTURE.md → "What the model actually receives".
6. **Budget UI** — expose `maxSpendUsd`, which exists and is unreachable.
7. **Run-a-task-from-the-dashboard** — the "test run" affordance; today every task must come
   from a client.
8. **Shutdown button** behind a confirm modal; a header liveness dot; a "Local Mode" footer.
9. **Registry export/import** — models + cards + overrides only, never `apiKeyRef` values.

Deliberately excluded: combos, compression, gamification, batch, MCP/A2A, sidebar
customisation, presets, the command palette, and breadcrumbs — each either duplicates what the
orchestrator is for, or is scaffolding for a scale rewter does not have.

## Attribution

OmniRoute is MIT-licensed, © 2026 diegosouzapw. This document describes its interface; no
OmniRoute source was copied into rewter for anything in it. Where rewter later ports actual
code from OmniRoute (a separate piece of work, permitted by the MIT licence), that will be
attributed at the point of use.
