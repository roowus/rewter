/**
 * Daemon configuration: what to listen on, where the database lives, and which
 * providers/models the registry starts with.
 *
 * Config is a plain JSON file (default `~/.rewter/config.json`) plus a handful
 * of environment overrides. It names providers by **preset slug**, so a working
 * config is three lines rather than a copy of the upstream's base URL and
 * quirks — and, like everywhere else in rewter, it references API keys by
 * environment variable *name*. A raw key never belongs in a file that people
 * paste into issues.
 *
 * Until M4 the `models` array is hand-authored; the registry sync will fill the
 * same rows automatically and by the same idempotent upsert path.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { ModelIdSchema, ModelPricingSchema, ProviderKindSchema } from "@rewter/shared";
import { z } from "zod";

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly path: string | null = null,
  ) {
    super(path === null ? message : `${path}: ${message}`);
    this.name = "ConfigError";
  }
}

export const ProviderConfigSchema = z
  .object({
    /** A slug from the built-in preset table — supplies kind, baseUrl, quirks. */
    preset: z.string().optional(),
    /** Namespace for this provider's model ids. Defaults to `preset`. */
    slug: z
      .string()
      .regex(/^[a-z0-9-]+$/, "must be lowercase alphanumeric with dashes")
      .optional(),
    name: z.string().min(1).optional(),
    kind: ProviderKindSchema.optional(),
    /** Overrides the preset's base URL (a self-hosted vLLM, a proxy, …). */
    baseUrl: z.string().url().nullable().optional(),
    /** Env var NAME holding the key. Overrides the preset's. */
    apiKeyEnv: z.string().min(1).nullable().optional(),
    enabled: z.boolean().default(true),
  })
  .refine((p) => p.preset !== undefined || (p.slug !== undefined && p.kind !== undefined), {
    message: "needs either `preset`, or both `slug` and `kind`",
  });
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ModelConfigSchema = z.object({
  /** Fully-qualified id, conventionally `<provider-slug>/<name>`. */
  id: ModelIdSchema,
  /** Provider slug this model is served by. */
  provider: z.string().min(1),
  /** What goes on the wire, if it differs from the last segment of `id`. */
  upstreamId: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().nullable().default(null),
  maxOutputTokens: z.number().int().positive().nullable().default(null),
  /** Per-million-token prices. Omitted components are unknown, not free. */
  pricing: ModelPricingSchema.partial().default({}),
  modalities: z.array(z.enum(["text", "image", "audio", "video"])).default(["text"]),
  /**
   * Omitted fields are unknown, not denied — same rule as `pricing` above. A
   * hand-written model block is usually someone naming a local model in a
   * hurry, and reading that as "declared to have no vision" would take the only
   * model that can read a scan out of the running for the subtask that needs it.
   */
  supports: z
    .object({
      tools: z.boolean().nullable().default(null),
      streaming: z.boolean().nullable().default(true),
      vision: z.boolean().nullable().default(null),
      caching: z.boolean().nullable().default(null),
    })
    .default({}),
  enabled: z.boolean().default(true),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/** Not 20128 — that is 9router's, and both should be able to run at once. */
export const DEFAULT_PORT = 20130;

/**
 * Orchestrator knobs. All optional: the engine has defaults for every one, and
 * a config file that has never heard of orchestration must still boot a daemon
 * that can orchestrate.
 */
export const OrchestratorConfigSchema = z
  .object({
    /**
     * Who leads when the request pins nobody. Left null, the engine falls back
     * to "priciest enabled model that supports tools" — a defensible guess, but
     * a guess, and it changes the day a new model syncs into the registry.
     */
    initiatorModel: z.string().min(1).nullable().default(null),
    /** Default `concurrency` for tasks that do not ask for one. */
    concurrency: z.number().int().positive().max(16).default(4),
    /** Default spending cap per task, in USD. Null = uncapped. */
    maxSpendUsd: z.number().positive().nullable().default(null),
    /** Runaway guards, not targets. */
    maxTurns: z.number().int().positive().max(200).default(24),
    maxHandoffs: z.number().int().min(0).max(10).default(2),
  })
  .default({});
export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

export const ConfigSchema = z.object({
  /** Loopback by default: the daemon holds provider keys and gates nothing else. */
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(0).max(65_535).default(DEFAULT_PORT),
  dbPath: z.string().min(1).default("~/.rewter/rewter.db"),
  /**
   * Where tier-2 workers get their per-task workspace. One directory per task
   * under here, and — unless a task points itself at a real project — the only
   * place a worker may write without asking. Deliberately *not* under `dbPath`:
   * a worker that gets creative with a relative path should not be able to walk
   * into the database file.
   */
  workspacesDir: z.string().min(1).default("~/.rewter/workspaces"),
  /** Env var NAME holding the bearer token clients must send to `/v1`. */
  apiKeyEnv: z.string().min(1).default("REWTER_API_KEY"),
  logger: z.boolean().default(true),
  providers: z.array(ProviderConfigSchema).default([]),
  models: z.array(ModelConfigSchema).default([]),
  orchestrator: OrchestratorConfigSchema,
});
export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG_PATH = "~/.rewter/config.json";

export interface LoadConfigOptions {
  /** Explicit path (`--config`). Missing file is an error, unlike the default. */
  path?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

export interface LoadedConfig {
  config: Config;
  /** The file it came from, or null when nothing existed and defaults applied. */
  source: string | null;
}

/**
 * Load and validate config. Precedence: environment > file > defaults.
 *
 * An explicitly requested file that does not exist is an error — silently
 * falling back to defaults there would start a daemon with an empty registry
 * and no hint as to why.
 */
export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const env = opts.env ?? process.env;
  const explicit = opts.path ?? env.REWTER_CONFIG;
  // Expand against the *passed* HOME, not the process's. Anything else reads a
  // different operator's config than the one the caller named — which under
  // launchd, or a test, or `sudo -u`, is a file that has nothing to do with this
  // run. It failed silently for as long as no real ~/.rewter/config.json existed.
  const home = env.HOME ?? homedir();
  const path =
    explicit === undefined ? expandPath(DEFAULT_CONFIG_PATH, home) : expandPath(explicit, home);

  let raw: unknown = {};
  let source: string | null = null;
  if (existsSync(path)) {
    source = path;
    raw = parseJsonFile(path);
  } else if (explicit !== undefined) {
    throw new ConfigError("config file not found", path);
  }

  const parsed = ConfigSchema.safeParse(applyEnvOverrides(raw, env, source));
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`).join("; "),
      source,
    );
  }
  return { config: parsed.data, source };
}

function parseJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read config: ${(err as Error).message}`, path);
  }
  try {
    return JSON.parse(stripComments(text));
  } catch (err) {
    throw new ConfigError(`invalid JSON: ${(err as Error).message}`, path);
  }
}

/**
 * Strip `//` and slash-star comments so a hand-edited config can carry the notes
 * its author left themselves.
 *
 * This file is the one people are told to open in an editor, and `// this one is
 * my cheap provider` is exactly what they write in it. JSON has nowhere to put
 * that, so the loader tolerates it rather than failing on the first line of the
 * quickstart.
 *
 * String-aware, because it has to be: `"baseUrl": "https://…"` contains `//`
 * inside a string, and a naive strip would truncate every base URL in the file
 * into a parse error pointing at the wrong place. Tracks whether it is inside a
 * string and honours backslash escapes; comment bodies are replaced by spaces
 * rather than removed so byte offsets — and therefore the positions in
 * `JSON.parse`'s error messages — still line up with the file on disk.
 */
function stripComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
      // Keep the newline itself: line numbers in errors stay honest.
      if (i < text.length) out += "\n";
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      // An unterminated block comment eats the rest of the file; JSON.parse then
      // fails on the truncation, which is the right complaint to make.
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) out += text[i] === "\n" ? "\n" : " ";
      i--;
      continue;
    }

    out += ch;
  }
  return out;
}

function applyEnvOverrides(
  raw: unknown,
  env: NodeJS.ProcessEnv,
  source: string | null,
): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("config must be a JSON object", source);
  }
  const out = { ...(raw as Record<string, unknown>) };
  if (env.REWTER_HOST !== undefined && env.REWTER_HOST !== "") out.host = env.REWTER_HOST;
  if (env.REWTER_DB !== undefined && env.REWTER_DB !== "") out.dbPath = env.REWTER_DB;
  if (env.REWTER_PORT !== undefined && env.REWTER_PORT !== "") {
    const port = Number.parseInt(env.REWTER_PORT, 10);
    // A typo'd port that silently falls back to the default is a daemon nobody
    // can find; refuse instead.
    if (Number.isNaN(port))
      throw new ConfigError(`REWTER_PORT is not a number: ${env.REWTER_PORT}`);
    out.port = port;
  }
  return out;
}

/** Expand a leading `~` and make the result absolute. */
export function expandPath(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  const expanded = path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}
