/**
 * Booting the daemon: config → database → registry → router → listening app.
 *
 * `startDaemon` returns the running pieces rather than owning the process, so
 * tests can boot a real daemon on port 0 and shut it down, and M8's launchd
 * wrapper can add signal handling without this module knowing about processes.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { REWTER_VERSION } from "@rewter/shared";
import type { FastifyInstance } from "fastify";
import {
  type Config,
  ConfigError,
  expandPath,
  isLoopbackHost,
  loadConfig,
} from "./config/config.js";
import { DEFAULT_ENV_FILE, loadEnvFile, mergeEnv } from "./config/envfile.js";
import { type SeedResult, seedRegistry } from "./config/seed.js";
import { type Db, openDb } from "./db/connection.js";
import { Repos } from "./db/repos.js";
import { EventBus } from "./events/bus.js";
import { createClaudeCodeAdapter } from "./harness/claude-code.js";
import { buildApp } from "./http/app.js";
import { Orchestrator } from "./orchestrator/engine.js";
import { LiveTaskIndex } from "./orchestrator/live.js";
import { type ReconcileResult, reconcileOnBoot, reconcileSummary } from "./reconcile.js";
import { Router } from "./router/router.js";
import { removePidfile, writePidfile } from "./service/pidfile.js";
import { reindexSkills } from "./skills/reindex.js";
import { wireDistiller } from "./skills/watch.js";

export interface StartDaemonOptions {
  /** Explicit config path (`--config`); otherwise `~/.rewter/config.json`. */
  configPath?: string | undefined;
  /** Pre-loaded config, skipping the file entirely — used by tests. */
  config?: Config;
  env?: NodeJS.ProcessEnv;
  /** Overrides `config.port`; 0 asks the OS for a free one. */
  port?: number;
  /**
   * Where to record "a daemon is here" for `rewter stop`/`status`. Omitted —
   * as every test and every library embedding does — no file is written at all:
   * a pidfile is a claim about *the* daemon on this machine, and a test booting
   * three on port 0 must not leave three of them contradicting each other.
   */
  pidfilePath?: string | undefined;
  /** See `OpenRegistryOptions.envFile`. `null` skips `~/.rewter/env`. */
  envFile?: string | null;
  /**
   * The dashboard bundle to serve at `/`. Defaults to locating
   * `apps/dashboard/dist` from this module; `null` serves no UI at all, which
   * is what every test wants.
   */
  dashboardDir?: string | null;
}

export interface RunningDaemon {
  app: FastifyInstance;
  db: Db;
  repos: Repos;
  bus: EventBus;
  router: Router;
  orchestrator: Orchestrator;
  /** Tasks still running, so a shutdown can collapse them. */
  live: LiveTaskIndex;
  config: Config;
  /** What this boot closed out from a previous unclean shutdown. */
  reconciled: ReconcileResult;
  /** Complaints about `~/.rewter/env`, already logged; kept for the boot summary. */
  envWarnings: string[];
  /** The address actually bound — resolves port 0 to the real number. */
  url: string;
  /**
   * Close the HTTP server and the database, in that order. Idempotent: a second
   * call joins the first rather than closing a closed database.
   */
  stop(): Promise<void>;
  /**
   * Stop, and then end the process — the route-reachable equivalent of SIGTERM,
   * which is what `POST /internal/shutdown` needs.
   *
   * `stop()` alone is not enough for a daemon someone is running: the signal
   * handlers `runUntilSignal` installs are libuv handles, so draining the server
   * leaves a process with no port, no database and nothing to do, still alive.
   * Whoever owns the process lifetime installs the second half through `onExit`.
   * Nobody having installed one is a legitimate state — an embedded daemon in a
   * test owns no process — and then this is exactly `stop()`.
   */
  requestStop(): Promise<void>;
  /** Install the process-ending half of `requestStop`. `runUntilSignal` does this. */
  onExit(fn: (code: number) => void): void;
}

export interface OpenRegistryOptions {
  configPath?: string | undefined;
  config?: Config;
  env?: NodeJS.ProcessEnv;
  /**
   * Where to read `KEY=value` lines from, layered *under* `env`. Defaults to
   * `~/.rewter/env`; pass `null` to skip the file entirely, which tests do so
   * that a developer's real keys can never leak into one.
   */
  envFile?: string | null;
}

export interface OpenRegistry {
  db: Db;
  bus: EventBus;
  repos: Repos;
  config: Config;
  seeded: SeedResult;
  /** The real environment with `~/.rewter/env` layered underneath. */
  env: NodeJS.ProcessEnv;
  /**
   * The home the env file, config and database were all resolved against —
   * returned rather than recomputed so anything expanding a later `~` path
   * (workspaces) lands in the same operator's directory as the rest.
   */
  home: string;
  /** The database file actually opened, `~` already expanded. */
  dbPath: string;
  /** What the env file had to say for itself — a loose mode, a bad line. */
  envWarnings: string[];
  close(): void;
}

/**
 * Facts `/internal/health` reports that the app cannot work out for itself.
 *
 * A mutable object rather than constructor arguments because one of them is not
 * knowable yet: the bound URL exists only after `listen()` resolves port 0, and
 * the app has to be built before it can listen. Handing the route a reference it
 * reads per request closes that circle without a second `buildApp` call.
 */
export interface RuntimeFacts {
  startedAt: number;
  dbPath: string;
  url: string | null;
}

/**
 * Everything below the HTTP layer: config → database → seeded registry.
 *
 * One-shot CLI commands (`sync-models`, `card`) need the registry but not a
 * listening socket, and booting a server to read a table would fight the
 * running daemon for the port. They share the seed step with `startDaemon` so a
 * CLI invocation sees exactly the rows the daemon would.
 */
export function openRegistry(opts: OpenRegistryOptions = {}): OpenRegistry {
  // Keys first: everything downstream reads them from `env` by name, and under
  // launchd the real environment is nearly empty. `null` skips the file — the
  // default in tests, so a developer's own keys cannot wander into one.
  const realEnv = opts.env ?? process.env;
  const file =
    opts.envFile === null
      ? { values: {}, warnings: [] }
      : loadEnvFile(expandPath(opts.envFile ?? DEFAULT_ENV_FILE, realEnv.HOME ?? homedir()));
  const env = mergeEnv(realEnv, file.values);

  const config =
    opts.config ??
    loadConfig({ env, ...(opts.configPath !== undefined && { path: opts.configPath }) }).config;

  // Same home as the env file and the config were resolved with — a daemon that
  // reads one operator's config and opens another's database is not a
  // combination worth making possible.
  const home = realEnv.HOME ?? homedir();

  const dbPath = expandPath(config.dbPath, home);
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  const bus = new EventBus(db);
  const repos = new Repos(db, bus);

  const seeded = seedRegistry(repos, {
    providers: config.providers,
    models: config.models,
    env,
  });

  return {
    db,
    bus,
    repos,
    config,
    seeded,
    env,
    home,
    dbPath,
    envWarnings: file.warnings,
    close() {
      db.$client.close();
    },
  };
}

export async function startDaemon(opts: StartDaemonOptions = {}): Promise<RunningDaemon> {
  const { db, bus, repos, config, seeded, env, home, dbPath, envWarnings } = openRegistry(opts);

  // Before anything can accept work, close out what the last process left
  // running. Doing it here rather than after `listen` means no request — and no
  // dashboard socket — ever observes a task that claims to be running with
  // nothing behind it.
  const reconciled = reconcileOnBoot(repos);

  // The skills index is a cache of the SKILL.md tree; every boot rebuilds it,
  // so files added/edited/removed while the daemon was down are simply picked
  // up. Problems (malformed imports, name/dir mismatches) are logged per file
  // after `listen`, never fatal — one bad import must not stop the daemon.
  const skillsDir = expandPath(config.skillsDir, home);
  const skillsIndex = reindexSkills(skillsDir, repos);

  const router = new Router({ repos, env });
  // The bearer token is read from the environment by *name*, like every other
  // secret here — the config file holds the variable name, never the value.
  const apiKey = env[config.apiKeyEnv] ?? null;
  const internalKey = env[config.internalKeyEnv] ?? null;

  // Fail closed, before the port opens: a non-loopback bind exposes
  // `/internal` — approve, deny, kill, shutdown, registry writes — to whatever
  // network that host is on, and without a key that is a remote kill switch.
  // Refusing to boot is the design; a warning log is the kind of line that is
  // only read after the incident. (`tailscale serve` needs none of this: the
  // daemon stays on loopback and Tailscale carries identity and TLS.)
  if (!isLoopbackHost(config.host) && (internalKey === null || internalKey === "")) {
    db.$client.close();
    throw new ConfigError(
      `host ${config.host} is not loopback and ${config.internalKeyEnv} is not set — refusing to expose /internal unauthenticated. Set ${config.internalKeyEnv} (in ~/.rewter/env or the environment), or keep host 127.0.0.1 and use \`tailscale serve\` to share the daemon.`,
    );
  }

  const orchestrator = new Orchestrator({
    router,
    repos,
    bus,
    defaultInitiatorModel: config.orchestrator.initiatorModel,
    // Not created here: `openWorkspace` mkdirs the per-task directory (and its
    // parents) on the first tier-2 spawn, so a daemon that never orchestrates
    // never makes the directory.
    workspacesDir: expandPath(config.workspacesDir, home),
    // Empty unless the config opts in — tier 3 stays a tool-result refusal on
    // a daemon whose owner never enabled a harness.
    harnesses: config.harnesses.claudeCode.enabled
      ? [
          createClaudeCodeAdapter({
            binary: config.harnesses.claudeCode.binary,
            permissionMode: config.harnesses.claudeCode.permissionMode,
          }),
        ]
      : [],
    maxTurns: config.orchestrator.maxTurns,
    maxHandoffs: config.orchestrator.maxHandoffs,
    defaultSettings: {
      maxSpendUsd: config.orchestrator.maxSpendUsd,
      concurrency: config.orchestrator.concurrency,
    },
  });
  const live = new LiveTaskIndex();

  // The learning loop's front half (phase-2 M4): every task that succeeds is
  // offered to the distiller, which may land a draft in `pending/` — inert
  // until a human approves it, which is why this needs no gate of its own.
  const distiller = wireDistiller({
    bus,
    generator: router,
    // The job's reads span both stores: the log lives on the bus, everything
    // else on the repos. Composed here so neither grows a method it doesn't own.
    source: {
      eventsAfter: (afterSeq, taskId) => bus.eventsAfter(afterSeq, taskId),
      listWorkItems: (taskId) => repos.listWorkItems(taskId),
      getProject: (id) => repos.getProject(id),
      listSkills: () => repos.listSkills(),
      getTask: (id) => repos.getTask(id),
    },
    repos,
    listModels: () => repos.listModels({ enabledOnly: true }),
    skillsRoot: skillsDir,
    config: config.skills,
    // `app` doesn't exist yet; defer each call so the logger is the real one.
    log: {
      info: (obj, msg) => app.log.info(obj, msg),
      warn: (obj, msg) => app.log.warn(obj, msg),
    },
  });

  // ── The stop sequence, defined before the app so the app can call it ───────
  //
  // `POST /internal/shutdown` needs a handle on this, and the app is built
  // before the object holding it exists — so the functions live here and the
  // returned object hands them out.
  //
  // Memoised on the promise rather than guarded by a boolean: two callers (a
  // SIGTERM racing the dashboard button) must both wait for the *same* drain,
  // and a boolean would let the second return while the first was still closing.
  let stopping: Promise<void> | null = null;
  /** Installed by whoever owns the process lifetime. See `RunningDaemon.onExit`. */
  let exit: ((code: number) => void) | null = null;

  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      // The pidfile goes first, and unconditionally: from the moment we have
      // decided to stop, the claim it makes is no longer true, and a `status`
      // racing the drain should read "not running" rather than point at a
      // socket that is closing. A `stop` waiting on us sees the health probe
      // stop answering either way.
      if (opts.pidfilePath !== undefined) removePidfile(opts.pidfilePath);
      // No new distillations once we've decided to stop. One already in
      // flight isn't waited for — its draft file still lands, and if the
      // reindex then finds the DB closed, that's a caught warn and the next
      // boot's reindex picks the file up anyway.
      distiller.unsubscribe();
      // Tasks next: a running orchestration holds upstream calls open, and
      // closing the socket out from under it would leave them billing with
      // nobody left to read the answer.
      live.shutdown();
      await app.close();
      db.$client.close();
    })();
    return stopping;
  };

  const requestStop = async (): Promise<void> => {
    try {
      await stop();
    } catch (err) {
      // The process still has to go — a drain that failed halfway is a worse
      // thing to leave running than one that finished. Exit code says which.
      exit?.(1);
      throw err;
    }
    exit?.(0);
  };

  const dashboardDir = opts.dashboardDir === undefined ? findDashboardDir() : opts.dashboardDir;
  // `url` is filled in below, once `listen` has resolved port 0 into a number.
  // The health route reads this object per request rather than closing over a
  // value, which is what lets it be built before the socket exists.
  const runtime: RuntimeFacts = { startedAt: Date.now(), dbPath, url: null };
  const app = buildApp({
    router,
    repos,
    bus,
    apiKey,
    internalKey,
    logger: config.logger,
    orchestrator,
    live,
    dashboardDir,
    runtime,
    // The tree the approve/reject routes move files in — same one the boot
    // reindex and the distiller write to.
    skillsRoot: skillsDir,
    // The same environment the registry was seeded against — so "test this
    // provider" answers for the process that would serve the request.
    env,
    // The dashboard's Shutdown button. `requestStop`, not `stop`: a route that
    // drained the server and left the process alive would look like a hang.
    shutdown: requestStop,
  });

  const port = opts.port ?? config.port;
  await app.listen({ host: config.host, port });
  const address = app.server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  const url = `http://${config.host}:${boundPort}`;
  runtime.url = url;
  orchestrator.setDashboardUrl(url);

  // Written after `listen`, never before: the file's whole purpose is to tell
  // another process where to reach this one, and until the port is bound (port
  // 0 especially) there is no true address to record.
  if (opts.pidfilePath !== undefined) {
    writePidfile(opts.pidfilePath, {
      pid: process.pid,
      url,
      startedAt: Date.now(),
      version: REWTER_VERSION,
    });
  }

  // Said out loud, because the alternative is a 404 at the URL we just printed
  // and no clue anywhere as to why. #16 was exactly this, minus the log line.
  if (dashboardDir === null) {
    app.log.warn(
      "dashboard bundle not found — API is up, UI is not; run `pnpm build` in the checkout",
    );
  }

  const reconcileNote = reconcileSummary(reconciled);
  if (reconcileNote !== "") app.log.warn({ ...reconciled }, reconcileNote);
  for (const warning of envWarnings) app.log.warn({ warning }, "env file");
  for (const warning of seeded.warnings) app.log.warn({ warning }, "config");
  for (const { slug, env: name } of seeded.missingKeys) {
    app.log.warn({ provider: slug, envVar: name }, "provider disabled: key env var is unset");
  }
  for (const { path, reason } of skillsIndex.problems) {
    app.log.warn({ path, reason }, "skill not indexed");
  }

  return {
    app,
    db,
    repos,
    bus,
    router,
    orchestrator,
    live,
    config,
    reconciled,
    envWarnings,
    url,
    stop,
    requestStop,
    onExit(fn) {
      exit = fn;
    },
  };
}

/**
 * Locate the dashboard's built bundle, or `null` if it has not been built.
 *
 * Resolved from this module's own location rather than `process.cwd()`: the
 * daemon is started by launchd from `/`, by the CLI from wherever the operator
 * happens to be standing, and by tests from the package root — a relative path
 * would find the UI in exactly one of those. The two candidates are the
 * workspace layout (`packages/server/dist/` → `apps/dashboard/dist`) and an
 * installed one, where the bundle ships inside the server package.
 */
function findDashboardDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    `${here}/../../../apps/dashboard/dist`,
    `${here}/../dashboard`,
    `${here}/../../dashboard`,
  ];
  return candidates.find((dir) => existsSync(`${dir}/index.html`)) ?? null;
}

/** A one-line boot summary — what the operator needs to see and nothing secret. */
export function bootSummary(daemon: RunningDaemon): string {
  const models = daemon.repos.listModels({ enabledOnly: true }).length;
  const providers = daemon.repos.listProviders({ enabledOnly: true }).length;
  return `rewter listening on ${daemon.url} — ${providers} provider(s), ${models} model(s)`;
}

export interface SignalHandlerOptions {
  /** Injectable so tests can drive shutdown without signalling the runner. */
  process?: Pick<NodeJS.Process, "on">;
  onStopped?: (code: number) => void;
  log?: (line: string) => void;
}

/**
 * Wire SIGINT/SIGTERM to a graceful stop. Returns a promise that never settles
 * — the process ends via `onStopped`, so the caller's `await` is the "stay
 * running" state rather than a busy loop.
 *
 * Draining matters more here than in a typical server: an SSE stream severed
 * mid-frame leaves the client parsing a truncated event rather than seeing a
 * clean end.
 *
 * It also registers `onStopped` as the daemon's exit hook, which is what makes
 * the dashboard's Shutdown button end the process rather than merely close the
 * port: this function is the only place that knows the process is meant to run
 * until told otherwise, so it is the only place that can say what "otherwise"
 * does. A daemon nobody called this on — an embedded one in a test — has no
 * hook and its `requestStop` is just a drain, correctly.
 */
export function runUntilSignal(
  daemon: RunningDaemon,
  opts: SignalHandlerOptions = {},
): Promise<never> {
  const proc = opts.process ?? process;
  const onStopped = opts.onStopped ?? ((code: number) => process.exit(code));
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  daemon.onExit(onStopped);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    proc.on(signal, () => {
      log(`${signal} — shutting down`);
      // A second Ctrl-C — or a Ctrl-C racing the dashboard button — joins the
      // drain already in flight rather than starting a second one: `stop()` is
      // memoised on its own promise, so the guard lives there and not here.
      daemon.requestStop().catch((err: unknown) => {
        log(`shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }
  return new Promise<never>(() => {});
}
