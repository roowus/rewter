/**
 * `~/.rewter/env` — where the keys come from when nobody typed them.
 *
 * Every secret in rewter is read from the environment by variable *name*: the
 * config file records `ANTHROPIC_API_KEY`, never the key. That works beautifully
 * from a shell, where `~/.zshrc` has already exported it, and not at all under
 * launchd, which starts a process with a nearly-empty environment and no
 * profile. A daemon launched at login would come up with every provider
 * disabled and no obvious reason why — the failure mode M8 exists to remove.
 *
 * So there is one file, read at boot, holding `KEY=value` lines. It is the only
 * place in rewter where a raw key sits on disk, which is why:
 *
 * - it is **separate from `config.json`**, the file people paste into issues;
 * - the real environment **wins over it**, so `ANTHROPIC_API_KEY=sk-x rewter
 *   start` still overrides for one run, and a shell that already exports a key
 *   does not have its value silently replaced by a stale one from a file;
 * - a mode other than owner-only is **reported**, because `~/Library/LaunchAgents`
 *   is not a place people think about permissions and 0644 is the default
 *   everywhere else.
 *
 * A bad mode is a warning and not a refusal. Refusing would leave a launchd
 * daemon dead at login with its explanation in a log the user does not yet know
 * how to read; booting with a loud line in the log they *will* read when they
 * notice their providers are off is the better trade.
 */
import { readFileSync, statSync } from "node:fs";

/** Alongside the config and the database, and the only one of the three holding secrets. */
export const DEFAULT_ENV_FILE = "~/.rewter/env";

export interface EnvFile {
  /** Parsed `KEY=value` pairs, in file order. Empty when the file is absent. */
  values: Record<string, string>;
  /** The file it came from, or null when there was none — absence is normal. */
  source: string | null;
  /** Things worth printing: a loose mode, a line that is not `KEY=value`. */
  warnings: string[];
}

/**
 * Read and parse the file. A missing file is not an error: running from a shell
 * that already exports everything is the expected case, and the one this
 * exists to supplement rather than replace.
 */
export function loadEnvFile(path: string): EnvFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { values: {}, source: null, warnings: [] };
  }

  const warnings: string[] = [];
  const mode = modeOf(path);
  // 0o077 = any group or other bit. This file holds provider keys; on a shared
  // machine, world-readable means every account has them.
  if (mode !== undefined && (mode & 0o077) !== 0) {
    warnings.push(
      `${path} is mode ${mode.toString(8).padStart(4, "0")} — it holds API keys; \`chmod 600\` it`,
    );
  }

  const values: Record<string, string> = {};
  raw.split("\n").forEach((line, i) => {
    const parsed = parseLine(line);
    if (parsed === "skip") return;
    if (parsed === "malformed") {
      // Named by line number and not echoed: the thing on a malformed line in
      // this particular file is quite likely to be half of a key.
      warnings.push(`${path}:${i + 1} — not a KEY=value line, ignored`);
      return;
    }
    values[parsed.key] = parsed.value;
  });

  return { values, source: path, warnings };
}

/**
 * Overlay the file **under** the environment.
 *
 * Direction matters: an exported variable is something the user did just now,
 * and a file is something they did once. The immediate one wins. An empty
 * string counts as set — `ANTHROPIC_API_KEY= rewter start` is a legible way to
 * say "pretend I have no Anthropic key", and a file that overrode it would make
 * that impossible to express.
 */
export function mergeEnv(env: NodeJS.ProcessEnv, file: Record<string, string>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...file };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

type ParsedLine = { key: string; value: string } | "skip" | "malformed";

/**
 * One line of a dotenv-ish file. `export ` prefixes are tolerated because the
 * natural way to produce this file is to copy the lines out of `~/.zshrc`.
 */
function parseLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return "skip";

  const body = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
  const eq = body.indexOf("=");
  if (eq <= 0) return "malformed";

  const key = body.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return "malformed";

  return { key, value: unquote(body.slice(eq + 1).trim()) };
}

/**
 * Strip one layer of matched quotes.
 *
 * Double quotes expand `\n` and `\t`, single quotes are literal — the shell
 * convention, since these lines are usually copied from a shell profile. An
 * unquoted value keeps a trailing `# comment` as part of the value only if it
 * has no preceding space, which is the rule that lets a key containing `#`
 * survive.
 */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if (first === "'" && last === "'") return value.slice(1, -1);
    if (first === '"' && last === '"') {
      return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
    }
  }
  const comment = value.search(/\s#/);
  return comment === -1 ? value : value.slice(0, comment).trimEnd();
}

function modeOf(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}
