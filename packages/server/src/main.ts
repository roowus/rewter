#!/usr/bin/env node
/**
 * Process entrypoint. Separate from `index.ts` (the library barrel) so that
 * importing `@rewter/server` never starts a server as a side effect.
 *
 * This is the bare `node dist/main.js` path; the `rewter start` CLI is the same
 * boot with argument parsing and help text around it.
 */
import { bootSummary, runUntilSignal, startDaemon } from "./daemon.js";

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const flag = argv.indexOf("--config");
  const configPath = flag === -1 ? undefined : argv[flag + 1];
  if (flag !== -1 && configPath === undefined) throw new Error("--config needs a path");

  const daemon = await startDaemon({ ...(configPath !== undefined && { configPath }) });
  process.stdout.write(`${bootSummary(daemon)}\n`);
  await runUntilSignal(daemon);
}

// Run only when executed directly, never when imported.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
