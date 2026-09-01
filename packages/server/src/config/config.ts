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

/**
 * Skills knobs (phase-2 M4). Same contract as the orchestrator block: every
 * field has a default, so a config that predates skills still boots a daemon
 * that learns.
 */
export const SkillsConfigSchema = z
  .object({
    /**
     * Draft a pending skill after each qualifying successful task. On by
     * default because the output is inert until approved — nothing in
     * `pending/` is ever retrieved — and off is one line for anyone who would
     * rather not spend the (cheap-model) tokens.
     */
    distill: z.boolean().default(true),
    /**
     * Who drafts. Left null, the daemon picks the cheapest enabled model with
     * a known price — the initiator heuristic inverted, because distillation
     * is summarization and the expensive judgement already happened.
     */
    distillModel: z.string().min(1).nullable().default(null),
    /**
     * Distill floor: worker LLM turns a task must have burned before its log
     * is considered worth learning from. The spec's "≥5 tool calls" measured
     * in the signal the event log actually carries (see skills/distill.ts).
     */
    minWorkerTurns: z.number().int().positive().max(1_000).default(6),
  })
  .default({});
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;

/**
 * Tier-3 harness knobs (phase-2 M5). Off by default: a harness is another
 * program with the owner's login and its own spend, and enabling it should be
 * a decision someone made in a file, not a default they discover on the bill.
 * With everything disabled the engine receives an empty adapter list and
 * `spawn_worker(tier: 3)` stays the same tool-result refusal it was before the
 * feature existed.
 */
export const HarnessesConfigSchema = z
  .object({
    claudeCode: z
      .object({
        enabled: z.boolean().default(false),
        /** Binary name or absolute path; resolved through PATH like any spawn. */
        binary: z.string().min(1).default("claude"),
        /**
         * Claude Code's own `--permission-mode`. Headless has no human to
         * prompt, so "default" would park forever on the first gated tool;
         * "acceptEdits" lets it edit inside its cwd while shell commands still
         * refuse-and-adapt. The spawn itself is what rewter gates.
         */
        permissionMode: z.string().min(1).default("acceptEdits"),
        /**
         * Passed as `--model` when set. The env-strip in the adapter cannot
         * stop the child re-applying a router URL + model alias from its own
         * `~/.claude/settings.json` env block, and an alias the router has
         * broken means a silent, empty session. The flag beats the child's
         * settings, so this is the one reliable lever. Unset = the child's own
         * default.
         */
        model: z.string().min(1).optional(),
      })
      .default({}),
  })
  .default({});
export type HarnessesConfig = z.infer<typeof HarnessesConfigSchema>;

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
  /**
   * The SKILL.md tree (phase-2 M4): `global/`, `<project-slug>/`, `pending/`
   * under here. Files are the source of truth; the DB only indexes them.
   */
  skillsDir: z.string().min(1).default("~/.rewter/skills"),
  /** Env var NAME holding the bearer token clients must send to `/v1`. */
  apiKeyEnv: z.string().min(1).default("REWTER_API_KEY"),
  /**
   * Env var NAME holding the token `/internal` requires. Unset on loopback =
   * open, which is phase 1 unchanged; unset on any other host = the daemon
   * refuses to boot, because `/internal` is approve/deny/kill/shutdown and an
   * unauthenticated bind would hand the network a kill switch.
   */
  internalKeyEnv: z.string().min(1).default("REWTER_INTERNAL_KEY"),
  logger: z.boolean().default(true),
  providers: z.array(ProviderConfigSchema).default([]),
  models: z.array(ModelConfigSchema).default([]),
  orchestrator: OrchestratorConfigSchema,
  skills: SkillsConfigSchema,
  harnesses: HarnessesConfigSchema,
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

/**
 * Is this bind host reachable only from this machine?
 *
 * The answer gates the fail-closed boot check: loopback needs no `/internal`
 * auth because the kernel already restricts callers; anything else — a tailnet
 * IP, `0.0.0.0`, a LAN address — makes approve/deny/kill/shutdown reachable
 * from other machines and must not boot without a key. Unrecognized strings
 * are non-loopback by construction: a typo'd host that skipped the check would
 * be exactly the incident the check exists to prevent.
 */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/** Expand a leading `~` and make the result absolute. */
export function expandPath(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  const expanded = path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}
