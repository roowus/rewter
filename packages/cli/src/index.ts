#!/usr/bin/env node
/**
 * rewter CLI.
 *
 * `start` runs the daemon in the foreground — the shape launchd wants, and the
 * shape you want anyway when you are watching logs. It records where it bound
 * in a pidfile, which is the only thing `status` and `stop` in another terminal
 * have to go on.
 *
 * Neither of those trusts the pid in it. A pidfile survives `kill -9` and
 * reboots, and pids get reused, so liveness is decided by probing the URL the
 * file records — see `service/control.ts`. `logs` and `install-service` still
 * need the launchd side and say so rather than pretending.
 *
 * `sync-models` is a one-shot: it opens the same database the daemon uses and
 * writes to it directly rather than going through a running server, so it works
 * whether or not the daemon is up. SQLite in WAL mode makes that safe.
 */
import { homedir } from "node:os";
import {
  Router,
  bootSummary,
  daemonStatus,
  formatCard,
  formatCardReport,
  formatStatus,
  formatSyncReport,
  generateCards,
  openRegistry,
  pidfilePath,
  presetSlugForProvider,
  runUntilSignal,
  startDaemon,
  stopDaemon,
  syncModels,
} from "@rewter/server";

const USAGE = `rewter — an AI model router where the AI runs the routing

Usage:
  rewter start [--config <path>] [--port <n>] [--pidfile <path>]
                                                run the daemon in the foreground
  rewter status [--pidfile <path>]              is one running, and where
  rewter stop [--pidfile <path>]                ask it to drain and exit
  rewter sync-models [--dry-run] [--no-enrich] [--provider <slug>]
                                                refresh the model registry from
                                                the providers' own catalogs
  rewter card [<model>...] --using <model> [--all] [--regenerate] [--show]
              [--dry-run]                       write capability cards — what the
                                                orchestrator reads to pick a model
  rewter version                                print the version
  rewter help                                   this message

Configuration:
  ~/.rewter/config.json          providers, models, port, db path
  REWTER_CONFIG                  override the config path
  REWTER_PORT / REWTER_HOST      override the listen address
  REWTER_DB                      override the database path
  REWTER_PIDFILE                 override ~/.rewter/rewter.pid

API keys are read from the environment by variable *name* — the config file
records which variable holds a key, never the key itself.
`;

export interface RunOptions {
  /** Injectable so tests can point the CLI at a scratch config and database. */
  env?: NodeJS.ProcessEnv;
  /** Injectable so tests can sync against fixtures instead of the live web. */
  fetch?: typeof globalThis.fetch;
}

export async function run(argv: string[], opts: RunOptions = {}): Promise<number> {
  const command = argv[0] ?? "help";

  switch (command) {
    case "start":
      return await start(argv.slice(1), opts);

    case "sync-models":
      return await syncCommand(argv.slice(1), opts);

    case "card":
      return await cardCommand(argv.slice(1), opts);

    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`rewter ${VERSION}\n`);
      return 0;

    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;

    case "status":
      return await statusCommand(argv.slice(1), opts);

    case "stop":
      return await stopCommand(argv.slice(1), opts);

    case "logs":
    case "install-service":
    case "gc":
      process.stderr.write(`${command}: lands in M8 (daemonization)\n`);
      return 1;

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

const VERSION = "0.1.0";

async function start(args: string[], opts: RunOptions = {}): Promise<number> {
  const configPath = flagValue(args, "--config");
  const portRaw = flagValue(args, "--port");
  const port = portRaw === undefined ? undefined : Number.parseInt(portRaw, 10);
  if (port !== undefined && Number.isNaN(port)) {
    process.stderr.write(`--port is not a number: ${portRaw}\n`);
    return 1;
  }

  const pid = pidfileFor(args, opts);
  // Refuse rather than race. Two daemons on one database is not obviously fatal
  // — SQLite in WAL mode would cope — but they would both reconcile on boot,
  // both hold the same task ids live, and only one could own the port. The
  // second one's failure would surface as EADDRINUSE, which reads as a port
  // problem rather than "rewter is already running".
  const existing = await daemonStatus(pid, pickFetch(opts));
  if (existing.state === "running") {
    process.stderr.write(`${formatStatus(existing)}\nalready running — nothing to do\n`);
    return 1;
  }

  const daemon = await startDaemon({
    ...(configPath !== undefined && { configPath }),
    ...(port !== undefined && { port }),
    pidfilePath: pid,
  });
  process.stdout.write(`${bootSummary(daemon)}\n`);
  // Never resolves: the process ends on SIGINT/SIGTERM, after a graceful drain.
  return await runUntilSignal(daemon);
}

/**
 * `rewter status` — is one running, and where.
 *
 * Exit code follows the shell convention that 0 means "the thing you asked
 * about is true": a stopped daemon is a successful *report* but a false
 * *claim*, so it exits 1 and `rewter status && open $(…)` behaves.
 */
async function statusCommand(args: string[], opts: RunOptions): Promise<number> {
  const status = await daemonStatus(pidfileFor(args, opts), pickFetch(opts));
  const line = `${formatStatus(status)}\n`;
  if (status.state === "running") {
    process.stdout.write(line);
    return 0;
  }
  process.stderr.write(line);
  return 1;
}

/** `rewter stop` — SIGTERM the daemon named by the pidfile, then wait for the port to go quiet. */
async function stopCommand(args: string[], opts: RunOptions): Promise<number> {
  const outcome = await stopDaemon(pidfileFor(args, opts), pickFetch(opts));
  process[outcome.ok ? "stdout" : "stderr"].write(`${outcome.note}\n`);
  return outcome.ok ? 0 : 1;
}

/**
 * Where the pidfile lives: `--pidfile`, then `REWTER_PIDFILE`, then
 * `~/.rewter/rewter.pid`. Overridable at all because tests, and because a
 * second daemon on a scratch config needs somewhere else to make its claim.
 */
function pidfileFor(args: string[], opts: RunOptions): string {
  const env = opts.env ?? process.env;
  const override = flagValue(args, "--pidfile") ?? env.REWTER_PIDFILE;
  return pidfilePath(env.HOME ?? homedir(), override);
}

function pickFetch(opts: RunOptions): { fetch?: typeof globalThis.fetch } {
  return opts.fetch !== undefined ? { fetch: opts.fetch } : {};
}

/**
 * Refresh the registry from the providers' catalogs.
 *
 * Enrichment (borrowing OpenRouter's prices for thin catalogs) is **on by
 * default**: most upstreams publish an id list and nothing else, so an
 * unenriched sync leaves the registry priceless and the orchestrator with no
 * basis for choosing a cheap model. `--no-enrich` opts out.
 */
async function syncCommand(args: string[], opts: RunOptions): Promise<number> {
  const configPath = flagValue(args, "--config");
  const only = flagValue(args, "--provider");
  const enrich = !args.includes("--no-enrich");
  const registry = openRegistry({
    ...(configPath !== undefined && { configPath }),
    ...(opts.env !== undefined && { env: opts.env }),
  });

  try {
    const all = registry.repos.listProviders();
    const providers = only === undefined ? all : all.filter((p) => slugOf(p) === only);
    if (only !== undefined && providers.length === 0) {
      process.stderr.write(`no provider named "${only}" in the config\n`);
      return 1;
    }
    // Enrichment reads OpenRouter's catalog out of the same list, so filtering
    // it away turns the flag into a silent no-op. Say so rather than leaving the
    // user wondering why the prices are still null.
    if (enrich && !providers.some((p) => slugOf(p) === "openrouter")) {
      process.stderr.write("note: no OpenRouter provider in scope — prices will not be filled\n");
    }

    const report = await syncModels(registry.repos, providers, {
      env: registry.env,
      enrich,
      dryRun: args.includes("--dry-run"),
      ...(opts.fetch !== undefined && { fetch: opts.fetch }),
    });
    process.stdout.write(`${formatSyncReport(report)}\n`);
    // A provider that failed is reported, not fatal — but the exit code says so,
    // because a cron'd sync that silently half-works is worse than a red one.
    return report.providers.some((p) => p.error !== undefined) ? 1 : 0;
  } finally {
    registry.close();
  }
}

/**
 * Write (or show) capability cards.
 *
 * `--using` is required and has no default. The generator is billed and its
 * judgement is what the orchestrator will act on for the life of the card, so
 * picking it silently — cheapest, first-enabled, whatever — would be the wrong
 * kind of convenience.
 *
 * Naming no model is not "do them all": a synced registry is hundreds of rows,
 * and a card apiece is hundreds of billed calls. `--all` means all *enabled*
 * models, which is the set the orchestrator can actually choose from.
 */
async function cardCommand(args: string[], opts: RunOptions): Promise<number> {
  const configPath = flagValue(args, "--config");
  const using = flagValue(args, "--using");
  const show = args.includes("--show");
  const names = args.filter((a) => !a.startsWith("--") && a !== using && a !== configPath);

  const registry = openRegistry({
    ...(configPath !== undefined && { configPath }),
    ...(opts.env !== undefined && { env: opts.env }),
  });

  try {
    const enabled = registry.repos.listModels({ enabledOnly: true });
    const models = args.includes("--all")
      ? enabled
      : names.map((n) => registry.repos.getModel(n)).filter((m) => m !== undefined);

    const unknown = args.includes("--all")
      ? []
      : names.filter((n) => registry.repos.getModel(n) === undefined);
    if (unknown.length > 0) {
      process.stderr.write(`unknown model(s): ${unknown.join(", ")}\n`);
      return 1;
    }
    if (models.length === 0) {
      process.stderr.write("name a model, or pass --all for every enabled model\n");
      return 1;
    }

    // `--show` reads what is already stored; it neither calls a model nor needs
    // one named, so it is checked before `--using` is required.
    if (show) {
      const cards = models.map((m) => registry.repos.getCard(m.id));
      const found = cards.filter((c) => c !== undefined);
      if (found.length === 0) {
        process.stdout.write("no cards yet — run `rewter card <model> --using <model>`\n");
        return 1;
      }
      process.stdout.write(`${found.map(formatCard).join("\n\n")}\n`);
      return 0;
    }

    if (using === undefined) {
      process.stderr.write("--using <model> is required: name the model that writes the cards\n");
      return 1;
    }

    const router = new Router({
      repos: registry.repos,
      env: registry.env,
      ...(opts.fetch !== undefined && { fetch: opts.fetch }),
    });
    try {
      router.resolve(using);
    } catch (err) {
      // Fail before spending anything on the models we were asked to describe.
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }

    const report = await generateCards(router, registry.repos, models, {
      using,
      dryRun: args.includes("--dry-run"),
      regenerate: args.includes("--regenerate"),
    });
    process.stdout.write(`${formatCardReport(report)}\n`);
    return report.results.some((r) => r.error !== undefined) ? 1 : 0;
  } finally {
    registry.close();
  }
}

/** Matches how sync names a provider, so `--provider` filters on what gets printed. */
function slugOf(provider: { id: string; name: string }): string {
  return presetSlugForProvider(provider);
}

/** `--flag value`; returns undefined when absent, and throws nothing on a trailing flag. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
