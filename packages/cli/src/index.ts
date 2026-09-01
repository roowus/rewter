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
 * file records — see `service/control.ts`.
 *
 * `install-service` writes the launchd plist and then stops, printing the two
 * `launchctl` lines rather than running them: see `service/launchd.ts` for why a
 * tool holding your API keys should not shell out on your behalf.
 *
 * `sync-models`, `card` and `gc` are one-shots: they open the same database the
 * daemon uses and write to it directly rather than going through a running
 * server, so they work whether or not the daemon is up. SQLite in WAL mode makes
 * that safe.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOG_DIR,
  type LogLevel,
  Router,
  SERVICE_LABEL,
  applyImport,
  bootSummary,
  collectGarbage,
  daemonStatus,
  expandPath,
  formatCard,
  formatCardReport,
  formatGcResult,
  formatImportReport,
  formatLogs,
  formatStatus,
  formatSyncReport,
  generateCards,
  installCli,
  installService,
  logPaths,
  openRegistry,
  pidfilePath,
  presetSlugForProvider,
  readLogs,
  runUntilSignal,
  stableNodePath,
  startDaemon,
  stopDaemon,
  syncModels,
  uninstallCli,
  uninstallService,
  vacuum,
} from "@rewter/server";
import { REGISTRY_BUNDLE_VERSION, RegistryBundleSchema, buildBundle } from "@rewter/shared";
import { type ChatIo, chatCommand } from "./chat/chat.js";

const USAGE = `rewter — an AI model router where the AI runs the routing

Usage:
  rewter chat [<instruction>...] [--model <m>] [-p <project>] [--url <daemon>]
                                                talk to the orchestrator from the
                                                terminal — the prompt stays live
                                                while the task runs, so you can
                                                steer it mid-flight
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
  rewter export-registry [<file>] [--note <text>]
                                                write models + cards to a file
                                                (or stdout) — never any keys
  rewter import-registry <file> [--overwrite] [--dry-run]
                                                merge such a file back in
  rewter logs [-n <lines>] [--level <level>] [--log-dir <path>]
                                                what the daemon wrote when
                                                nobody was watching
  rewter install-cli [--dir <path>] [--force] [--dry-run]
                                                symlink this build onto your PATH
                                                so \`rewter\` works anywhere
  rewter uninstall-cli [--dir <path>]           remove that symlink
  rewter install-service [--force] [--dry-run] [--config <path>]
                                                write the launchd plist so it
                                                starts at login
  rewter uninstall-service                      remove it again
  rewter gc [--older-than <days>] [--dry-run] [--vacuum]
                                                drop old finished tasks; spend
                                                history is always kept
  rewter version                                print the version
  rewter help                                   this message

Configuration:
  ~/.rewter/config.json          providers, models, port, db path
  ~/.rewter/env                  KEY=value lines — where launchd gets your keys
  REWTER_CONFIG                  override the config path
  REWTER_ENV_FILE                override ~/.rewter/env
  REWTER_PORT / REWTER_HOST      override the listen address
  REWTER_DB                      override the database path
  REWTER_PIDFILE                 override ~/.rewter/rewter.pid

API keys are read from the environment by variable *name* — the config file
records which variable holds a key, never the key itself. Under launchd there is
no shell to have exported them, so put them in ~/.rewter/env (chmod 600).
`;

export interface RunOptions {
  /** Injectable so tests can point the CLI at a scratch config and database. */
  env?: NodeJS.ProcessEnv;
  /** Injectable so tests can sync against fixtures instead of the live web. */
  fetch?: typeof globalThis.fetch;
  /**
   * The file `install-cli` links to. Defaults to this module, which is the
   * right answer for a real invocation and the wrong one under vitest, where
   * `import.meta.url` is the TypeScript source — `install-cli` would then
   * chmod a checked-in file, so the tests point this at a scratch copy.
   */
  entryPoint?: string;
  /** Injectable terminal streams, so `chat` is testable without a TTY. */
  io?: ChatIo;
}

export async function run(argv: string[], opts: RunOptions = {}): Promise<number> {
  const command = argv[0] ?? "help";

  switch (command) {
    case "chat":
      return await chatEntry(argv.slice(1), opts);

    case "start":
      return await start(argv.slice(1), opts);

    case "sync-models":
      return await syncCommand(argv.slice(1), opts);

    case "card":
      return await cardCommand(argv.slice(1), opts);

    case "export-registry":
      return exportRegistryCommand(argv.slice(1), opts);

    case "import-registry":
      return importRegistryCommand(argv.slice(1), opts);

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
      return logsCommand(argv.slice(1), opts);

    case "install-cli":
      return installCliCommand(argv.slice(1), opts);

    case "uninstall-cli":
      return uninstallCliCommand(argv.slice(1), opts);

    case "install-service":
      return installCommand(argv.slice(1), opts);

    case "uninstall-service":
      return uninstallCommand(argv.slice(1), opts);

    case "gc":
      return gcCommand(argv.slice(1), opts);

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

const VERSION = "0.1.0";

/** `rewter chat` — see `chat/chat.ts`. This shim only resolves the injectables. */
async function chatEntry(args: string[], opts: RunOptions): Promise<number> {
  return await chatCommand(args, {
    env: opts.env ?? process.env,
    fetch: opts.fetch ?? globalThis.fetch,
    pidfilePath: pidfileFor(args, opts),
    io: opts.io ?? { input: process.stdin, output: process.stdout },
  });
}

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

/**
 * The registry, as a file.
 *
 * The counterpart to the dashboard's download button, and the same
 * `buildBundle` behind both, so the two produce byte-identical files. Named a
 * file, it writes one; named nothing, it writes to stdout — because
 * `rewter export-registry | jq '.models | length'` is a reasonable thing to
 * want, and a tool that insists on a path to answer a question is a tool you
 * end up writing to `/tmp` around.
 *
 * It carries no credentials, structurally: provider entries hold identity only,
 * and `apiKeyRef` — an env-var *name*, not a key — is not among the fields the
 * bundle schema has. See `shared/transfer.ts`.
 */
function exportRegistryCommand(args: string[], opts: RunOptions): number {
  const configPath = flagValue(args, "--config");
  const note = flagValue(args, "--note");
  const out = positional(args, ["--config", "--note"])[0];

  const registry = openRegistry({
    ...(configPath !== undefined && { configPath }),
    ...(opts.env !== undefined && { env: opts.env }),
  });

  try {
    const bundle = buildBundle(
      {
        providers: registry.repos.listProviders(),
        models: registry.repos.listModels(),
        // Raw, not merged: the overrides are the part a person typed, and
        // flattening them into the generated text means the next `rewter card`
        // on the far machine silently discards them.
        cards: registry.repos.listRawCards(),
      },
      { now: Date.now(), note: note ?? null },
    );
    // Pretty-printed for the same reason the dashboard's download is: a bundle
    // is a file someone opens in a year to see what a price used to be.
    const json = `${JSON.stringify(bundle, null, 2)}\n`;

    if (out === undefined) {
      process.stdout.write(json);
      return 0;
    }
    writeFileSync(out, json, "utf8");
    process.stdout.write(
      `wrote ${out} — ${bundle.models.length} models, ${bundle.cards.length} cards, no keys\n`,
    );
    return 0;
  } finally {
    registry.close();
  }
}

/**
 * Merge such a file back in.
 *
 * `--dry-run` runs the identical planner and writes nothing, so what it prints
 * is what a real run would do rather than an estimate of it — the CLI's version
 * of the dashboard's preview step.
 *
 * The file is parsed here, with the version checked by hand before zod gets a
 * look, because "made by a newer rewter" is a useful thing to say about a file
 * the user believes is an export and `Invalid literal value, expected 1` is
 * not.
 */
function importRegistryCommand(args: string[], opts: RunOptions): number {
  const configPath = flagValue(args, "--config");
  const file = positional(args, ["--config"])[0];
  if (file === undefined) {
    process.stderr.write("name a bundle file: rewter import-registry <file>\n");
    return 1;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    process.stderr.write(
      `${file}: ${err instanceof SyntaxError ? "not JSON" : "could not be read"}\n`,
    );
    return 1;
  }

  const version = (raw as { version?: unknown } | null)?.version;
  if (typeof version === "number" && version !== REGISTRY_BUNDLE_VERSION) {
    process.stderr.write(
      version > REGISTRY_BUNDLE_VERSION
        ? `${file} was made by a newer rewter (bundle v${version}, this one reads v${REGISTRY_BUNDLE_VERSION})\n`
        : `${file} is a v${version} bundle; this rewter reads v${REGISTRY_BUNDLE_VERSION}\n`,
    );
    return 1;
  }

  const parsed = RegistryBundleSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined ? "" : ` (${first.path.join(".")}: ${first.message})`;
    process.stderr.write(`${file} is not a rewter registry bundle${where}\n`);
    return 1;
  }

  const registry = openRegistry({
    ...(configPath !== undefined && { configPath }),
    ...(opts.env !== undefined && { env: opts.env }),
  });

  try {
    const report = applyImport(registry.repos, parsed.data, {
      onConflict: args.includes("--overwrite") ? "overwrite" : "skip",
      dryRun: args.includes("--dry-run"),
      now: Date.now(),
    });
    process.stdout.write(`${formatImportReport(report)}\n`);
    // A missing provider is not a crash, but it is not a success either: the
    // models it names did not land, and a scripted import needs to know that.
    return report.missingProviders.length > 0 ? 1 : 0;
  } finally {
    registry.close();
  }
}

const LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

/**
 * `rewter logs` — what the daemon wrote when nobody was watching.
 *
 * Reads the files launchd writes rather than talking to the daemon, so it
 * answers the case it exists for: the daemon is *not* running and you want to
 * know why. Both streams are merged; see `service/logs.ts`.
 */
function logsCommand(args: string[], opts: RunOptions): number {
  const env = opts.env ?? process.env;
  const linesRaw = flagValue(args, "-n") ?? flagValue(args, "--lines");
  const lines = linesRaw === undefined ? undefined : Number.parseInt(linesRaw, 10);
  if (lines !== undefined && (Number.isNaN(lines) || lines <= 0)) {
    process.stderr.write(`-n is not a positive number: ${linesRaw}\n`);
    return 1;
  }

  const level = flagValue(args, "--level");
  if (level !== undefined && !LEVELS.includes(level as LogLevel)) {
    process.stderr.write(`--level must be one of: ${LEVELS.join(", ")}\n`);
    return 1;
  }

  const logDir = expandPath(flagValue(args, "--log-dir") ?? LOG_DIR, env.HOME ?? homedir());
  const read = readLogs(logPaths(logDir), {
    ...(lines !== undefined && { lines }),
    ...(level !== undefined && { minLevel: level as LogLevel }),
  });

  if (read.length === 0) {
    // Not an error: before the first launchd boot neither file exists.
    process.stdout.write(`no logs yet in ${logDir}\n`);
    return 0;
  }
  process.stdout.write(formatLogs(read));
  return 0;
}

/**
 * `rewter install-cli` — make the word work from any directory.
 *
 * The target is whatever file is running right now, which is the built entry
 * point in this checkout. So the link always points at the build you invoked it
 * from, and there is no path to configure or get wrong.
 */
function installCliCommand(args: string[], opts: RunOptions): number {
  const env = opts.env ?? process.env;
  const home = env.HOME ?? homedir();
  const dir = flagValue(args, "--dir");

  const result = installCli({
    target: entryPoint(opts),
    home,
    pathEnv: env.PATH ?? "",
    ...(dir !== undefined && { dir }),
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
  });

  if (result.action === "exists") {
    process.stderr.write(
      `${result.linkPath} already exists and is not ours — inspect it, then re-run with --force\n`,
    );
    return 1;
  }

  const verb =
    result.action === "dry-run"
      ? `would link ${result.linkPath}`
      : result.action === "unchanged"
        ? `already current: ${result.linkPath}`
        : `${result.action}: ${result.linkPath}`;
  const tail =
    result.next.length === 0
      ? result.onPath
        ? "\n`rewter` now works from anywhere. Try: rewter status\n"
        : "\n"
      : `\n${result.linkPath.replace(/\/[^/]+$/, "")} is not on your PATH yet:\n${result.next
          .map((line) => `  ${line}`)
          .join("\n")}\n`;
  process.stdout.write(`${verb}\n  → ${result.target}\n${tail}`);
  return 0;
}

/** This module's own path, unless a caller (a test) named a different one. */
function entryPoint(opts: RunOptions): string {
  return opts.entryPoint ?? fileURLToPath(import.meta.url);
}

/** `rewter uninstall-cli` — remove the symlink, if it is one of ours. */
function uninstallCliCommand(args: string[], opts: RunOptions): number {
  const env = opts.env ?? process.env;
  const dir = flagValue(args, "--dir");
  const result = uninstallCli({
    target: entryPoint(opts),
    home: env.HOME ?? homedir(),
    pathEnv: env.PATH ?? "",
    ...(dir !== undefined && { dir }),
  });

  if (!result.removed) {
    const why = result.reason === undefined ? "" : ` — ${result.reason}`;
    process.stdout.write(`nothing removed at ${result.linkPath}${why}\n`);
    return 0;
  }
  process.stdout.write(`removed ${result.linkPath}\n`);
  return 0;
}

/**
 * `rewter install-service` — write the plist, print the two `launchctl` lines.
 *
 * It stops short of loading the job on purpose: `bootstrap` needs the right
 * domain target and fails in ways worth reading, and a tool holding your API
 * keys should not shell out on your behalf. See `service/launchd.ts`.
 */
function installCommand(args: string[], opts: RunOptions): number {
  const env = opts.env ?? process.env;
  const home = env.HOME ?? homedir();
  const configPath = flagValue(args, "--config");

  const result = installService({
    // Absolute, because launchd starts us with no PATH to search — and stable,
    // because `process.execPath` resolves to a versioned Cellar path that the
    // next `brew upgrade node` deletes. See `service/launchd.ts`.
    nodePath: stableNodePath(process.execPath, home),
    cliPath: entryPoint(opts),
    logDir: expandPath(LOG_DIR, home),
    plistPath: plistPathFor(args, env),
    ...(configPath !== undefined && { configPath }),
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
  });

  if (result.action === "dry-run") {
    process.stdout.write(`${result.contents}\nwould write ${result.plistPath}\n`);
    return 0;
  }
  if (result.action === "exists") {
    process.stderr.write(
      `${result.plistPath} already exists and differs — inspect it, then re-run with --force\n`,
    );
    return 1;
  }

  const verb = result.action === "unchanged" ? "already current" : result.action;
  process.stdout.write(
    `${verb}: ${result.plistPath}\n\nput your keys in ~/.rewter/env (chmod 600), then:\n${result.next
      .map((line) => `  ${line}`)
      .join("\n")}\n`,
  );
  return 0;
}

/** `rewter uninstall-service` — remove the plist; unloading stays the user's call. */
function uninstallCommand(args: string[], opts: RunOptions): number {
  const path = plistPathFor(args, opts.env ?? process.env);
  const result = uninstallService(path);
  if (!result.removed) {
    process.stdout.write(`nothing installed at ${path}\n`);
    return 0;
  }
  process.stdout.write(
    `removed ${path}\n\nif it is still loaded:\n${result.next.map((l) => `  ${l}`).join("\n")}\n`,
  );
  return 0;
}

function plistPathFor(args: string[], env: NodeJS.ProcessEnv): string {
  const override = flagValue(args, "--plist");
  if (override !== undefined) return expandPath(override, env.HOME ?? homedir());
  return join(env.HOME ?? homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

/**
 * `rewter gc` — drop old finished tasks.
 *
 * Writes to the database directly rather than through the daemon, which is safe
 * (WAL) and means it works whether or not one is running. Spend history is never
 * collected: see `service/gc.ts`.
 */
function gcCommand(args: string[], opts: RunOptions): number {
  const configPath = flagValue(args, "--config");
  const daysRaw = flagValue(args, "--older-than");
  const olderThanDays = daysRaw === undefined ? undefined : Number.parseInt(daysRaw, 10);
  if (olderThanDays !== undefined && (Number.isNaN(olderThanDays) || olderThanDays < 0)) {
    process.stderr.write(`--older-than is not a number of days: ${daysRaw}\n`);
    return 1;
  }

  const env = opts.env ?? process.env;
  const registry = openRegistry({
    ...(configPath !== undefined && { configPath }),
    ...(opts.env !== undefined && { env: opts.env }),
  });

  try {
    const dryRun = args.includes("--dry-run");
    const result = collectGarbage(registry.db, {
      ...(olderThanDays !== undefined && { olderThanDays }),
      dryRun,
      // Expanded against the same home the config was read with — this argument
      // decides which directories get removed.
      workspacesDir: expandPath(registry.config.workspacesDir, env.HOME ?? homedir()),
    });
    process.stdout.write(`${formatGcResult(result)}\n`);

    // Separate and opt-in: VACUUM needs room for a second copy of the database
    // and holds a write lock on the whole of it, which is not something to do to
    // a running daemon by default.
    if (args.includes("--vacuum") && !dryRun) {
      vacuum(registry.db);
      process.stdout.write("vacuumed\n");
    }
    return 0;
  } finally {
    registry.close();
  }
}

/** Matches how sync names a provider, so `--provider` filters on what gets printed. */
function slugOf(provider: { id: string; name: string }): string {
  return presetSlugForProvider(provider);
}

/**
 * Bare arguments — everything that is neither a `--flag` nor the value of one.
 *
 * `valued` names the flags that take a value, so `--note "before reinstall"`
 * does not leave the note looking like a filename.
 */
function positional(args: string[], valued: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      if (valued.includes(arg)) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** `--flag value`; returns undefined when absent, and throws nothing on a trailing flag. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

/**
 * Run only when invoked as the program, not when imported by a test.
 *
 * Compared as resolved real paths, because `install-cli` puts a symlink on
 * `PATH`: through it, `process.argv[1]` is the link (`~/.local/bin/rewter`)
 * while `import.meta.url` is the file behind it, and a naive comparison is
 * false — so the CLI would exit 0 having printed nothing, which looks exactly
 * like a command that ran and had nothing to say. Real paths also avoid
 * hand-building a `file://` URL, which mangles spaces in a checkout path.
 */
function invokedDirectly(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
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
