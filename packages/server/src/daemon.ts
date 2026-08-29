/**
 * Booting the daemon: config → database → registry → router → listening app.
 *
 * `startDaemon` returns the running pieces rather than owning the process, so
 * tests can boot a real daemon on port 0 and shut it down, and M8's launchd
 * wrapper can add signal handling without this module knowing about processes.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { REWTER_VERSION } from "@rewter/shared";
import type { FastifyInstance } from "fastify";
import { type Config, expandPath, loadConfig } from "./config/config.js";
import { type SeedResult, seedRegistry } from "./config/seed.js";
import { type Db, openDb } from "./db/connection.js";
import { Repos } from "./db/repos.js";
import { EventBus } from "./events/bus.js";
import { buildApp } from "./http/app.js";
import { Orchestrator } from "./orchestrator/engine.js";
import { LiveTaskIndex } from "./orchestrator/live.js";
import { type ReconcileResult, reconcileOnBoot, reconcileSummary } from "./reconcile.js";
import { Router } from "./router/router.js";
import { removePidfile, writePidfile } from "./service/pidfile.js";

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
  /** The address actually bound — resolves port 0 to the real number. */
  url: string;
  /** Close the HTTP server and the database, in that order. */
  stop(): Promise<void>;
}

export interface OpenRegistryOptions {
  configPath?: string | undefined;
  config?: Config;
  env?: NodeJS.ProcessEnv;
}

export interface OpenRegistry {
  db: Db;
  bus: EventBus;
  repos: Repos;
  config: Config;
  seeded: SeedResult;
  env: NodeJS.ProcessEnv;
  close(): void;
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
  const env = opts.env ?? process.env;
  const config =
    opts.config ??
    loadConfig({ env, ...(opts.configPath !== undefined && { path: opts.configPath }) }).config;

  const dbPath = expandPath(config.dbPath);
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
    close() {
      db.$client.close();
    },
  };
}

export async function startDaemon(opts: StartDaemonOptions = {}): Promise<RunningDaemon> {
  const { db, bus, repos, config, seeded, env } = openRegistry(opts);

  // Before anything can accept work, close out what the last process left
  // running. Doing it here rather than after `listen` means no request — and no
  // dashboard socket — ever observes a task that claims to be running with
  // nothing behind it.
  const reconciled = reconcileOnBoot(repos);

  const router = new Router({ repos, env });
  // The bearer token is read from the environment by *name*, like every other
  // secret here — the config file holds the variable name, never the value.
  const apiKey = env[config.apiKeyEnv] ?? null;

  const orchestrator = new Orchestrator({
    router,
    repos,
    bus,
    defaultInitiatorModel: config.orchestrator.initiatorModel,
    // Not created here: `openWorkspace` mkdirs the per-task directory (and its
    // parents) on the first tier-2 spawn, so a daemon that never orchestrates
    // never makes the directory.
    workspacesDir: expandPath(config.workspacesDir),
    maxTurns: config.orchestrator.maxTurns,
    maxHandoffs: config.orchestrator.maxHandoffs,
    defaultSettings: {
      maxSpendUsd: config.orchestrator.maxSpendUsd,
      concurrency: config.orchestrator.concurrency,
    },
  });
  const live = new LiveTaskIndex();
  const app = buildApp({
    router,
    repos,
    bus,
    apiKey,
    logger: config.logger,
    orchestrator,
    live,
  });

  const port = opts.port ?? config.port;
  await app.listen({ host: config.host, port });
  const address = app.server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  const url = `http://${config.host}:${boundPort}`;
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

  const reconcileNote = reconcileSummary(reconciled);
  if (reconcileNote !== "") app.log.warn({ ...reconciled }, reconcileNote);
  for (const warning of seeded.warnings) app.log.warn({ warning }, "config");
  for (const { slug, env: name } of seeded.missingKeys) {
    app.log.warn({ provider: slug, envVar: name }, "provider disabled: key env var is unset");
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
    url,
    async stop() {
      // The pidfile goes first, and unconditionally: from the moment we have
      // decided to stop, the claim it makes is no longer true, and a `status`
      // racing the drain should read "not running" rather than point at a
      // socket that is closing. A `stop` waiting on us sees the health probe
      // stop answering either way.
      if (opts.pidfilePath !== undefined) removePidfile(opts.pidfilePath);
      // Tasks next: a running orchestration holds upstream calls open, and
      // closing the socket out from under it would leave them billing with
      // nobody left to read the answer.
      live.shutdown();
      await app.close();
      db.$client.close();
    },
  };
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
 */
export function runUntilSignal(
  daemon: RunningDaemon,
  opts: SignalHandlerOptions = {},
): Promise<never> {
  const proc = opts.process ?? process;
  const onStopped = opts.onStopped ?? ((code: number) => process.exit(code));
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    proc.on(signal, () => {
      // A second Ctrl-C during shutdown must not start a second stop().
      if (stopping) return;
      stopping = true;
      log(`${signal} — shutting down`);
      daemon.stop().then(
        () => onStopped(0),
        (err: unknown) => {
          log(`shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
          onStopped(1);
        },
      );
    });
  }
  return new Promise<never>(() => {});
}
