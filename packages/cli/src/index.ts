#!/usr/bin/env node
/**
 * rewter CLI.
 *
 * `start` runs the daemon in the foreground — the shape M8 will wrap in a
 * launchd plist, and the shape you want anyway when you are watching logs.
 * Background management (`stop`, `logs`, `install-service`) needs a pidfile and
 * a service definition, which is M8's job; those commands say so rather than
 * pretending.
 */
import { bootSummary, runUntilSignal, startDaemon } from "@rewter/server";

const USAGE = `rewter — an AI model router where the AI runs the routing

Usage:
  rewter start [--config <path>] [--port <n>]   run the daemon in the foreground
  rewter version                                print the version
  rewter help                                   this message

Configuration:
  ~/.rewter/config.json          providers, models, port, db path
  REWTER_CONFIG                  override the config path
  REWTER_PORT / REWTER_HOST      override the listen address
  REWTER_DB                      override the database path

API keys are read from the environment by variable *name* — the config file
records which variable holds a key, never the key itself.
`;

export async function run(argv: string[]): Promise<number> {
  const command = argv[0] ?? "help";

  switch (command) {
    case "start":
      return await start(argv.slice(1));

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

    case "stop":
    case "status":
    case "logs":
    case "install-service":
    case "gc":
      process.stderr.write(`${command}: lands in M8 (daemonization)\n`);
      return 1;

    case "sync-models":
    case "card":
      process.stderr.write(`${command}: lands in M4 (registry + capability cards)\n`);
      return 1;

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

const VERSION = "0.1.0";

async function start(args: string[]): Promise<number> {
  const configPath = flagValue(args, "--config");
  const portRaw = flagValue(args, "--port");
  const port = portRaw === undefined ? undefined : Number.parseInt(portRaw, 10);
  if (port !== undefined && Number.isNaN(port)) {
    process.stderr.write(`--port is not a number: ${portRaw}\n`);
    return 1;
  }

  const daemon = await startDaemon({
    ...(configPath !== undefined && { configPath }),
    ...(port !== undefined && { port }),
  });
  process.stdout.write(`${bootSummary(daemon)}\n`);
  // Never resolves: the process ends on SIGINT/SIGTERM, after a graceful drain.
  return await runUntilSignal(daemon);
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
