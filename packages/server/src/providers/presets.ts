/**
 * Known upstreams. Adding a provider is a table entry, not code: pick an
 * adapter kind, a baseUrl, an env var name, and any quirks. Anything speaking
 * the OpenAI wire format (the overwhelming majority) needs no new adapter.
 *
 * `apiKeyEnv` is the env var *name* — raw keys never enter the DB or this file.
 */
import type { ProviderKind } from "@rewter/shared";
import type { Quirks } from "./types.js";

export interface ProviderPreset {
  /** Stable slug; also the namespace of model ids (`<slug>/<model>`). */
  slug: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
  apiKeyEnv: string | null;
  quirks?: Quirks;
  /** OpenAI-style `GET /models` works — the registry sync can enumerate it. */
  listModels: boolean;
  /** No key needed: a local runtime on the user's machine. */
  local?: boolean;
  /** Aggregators expose other vendors' models under their own namespace. */
  aggregator?: boolean;
  docsUrl?: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  // ── First-party SDK adapters ───────────────────────────────────────────────
  {
    slug: "anthropic",
    name: "Anthropic",
    kind: "anthropic",
    baseUrl: null,
    apiKeyEnv: "ANTHROPIC_API_KEY",
    listModels: true,
    docsUrl: "https://docs.anthropic.com",
  },
  {
    slug: "google",
    name: "Google Gemini",
    kind: "google",
    baseUrl: null,
    apiKeyEnv: "GEMINI_API_KEY",
    listModels: true,
    docsUrl: "https://ai.google.dev",
  },
  {
    slug: "openai",
    name: "OpenAI",
    kind: "openai-compat",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    // Reasoning models reject max_tokens.
    quirks: { maxCompletionTokens: true },
    listModels: true,
    docsUrl: "https://platform.openai.com/docs",
  },

  // ── Aggregators ────────────────────────────────────────────────────────────
  {
    slug: "openrouter",
    name: "OpenRouter",
    kind: "openai-compat",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    listModels: true,
    aggregator: true,
    docsUrl: "https://openrouter.ai/docs",
  },
  {
    slug: "together",
    name: "Together AI",
    kind: "openai-compat",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyEnv: "TOGETHER_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "fireworks",
    name: "Fireworks AI",
    kind: "openai-compat",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyEnv: "FIREWORKS_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "groq",
    name: "Groq",
    kind: "openai-compat",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "deepinfra",
    name: "DeepInfra",
    kind: "openai-compat",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    apiKeyEnv: "DEEPINFRA_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "hyperbolic",
    name: "Hyperbolic",
    kind: "openai-compat",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    apiKeyEnv: "HYPERBOLIC_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "nebius",
    name: "Nebius AI Studio",
    kind: "openai-compat",
    baseUrl: "https://api.studio.nebius.ai/v1",
    apiKeyEnv: "NEBIUS_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "novita",
    name: "Novita AI",
    kind: "openai-compat",
    baseUrl: "https://api.novita.ai/v3/openai",
    apiKeyEnv: "NOVITA_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "sambanova",
    name: "SambaNova",
    kind: "openai-compat",
    baseUrl: "https://api.sambanova.ai/v1",
    apiKeyEnv: "SAMBANOVA_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "cerebras",
    name: "Cerebras",
    kind: "openai-compat",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnv: "CEREBRAS_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "perplexity",
    name: "Perplexity",
    kind: "openai-compat",
    baseUrl: "https://api.perplexity.ai",
    apiKeyEnv: "PERPLEXITY_API_KEY",
    // Sonar rejects stream_options.
    quirks: { noStreamOptions: true },
    listModels: false,
  },

  // ── Direct vendors ─────────────────────────────────────────────────────────
  {
    slug: "xai",
    name: "xAI",
    kind: "openai-compat",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    listModels: true,
  },
  {
    slug: "zai",
    name: "Z.AI (GLM)",
    kind: "openai-compat",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    listModels: false,
  },
  {
    slug: "moonshot",
    name: "Moonshot (Kimi)",
    kind: "openai-compat",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    listModels: true,
  },
  {
    slug: "deepseek",
    name: "DeepSeek",
    kind: "openai-compat",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    listModels: true,
  },
  {
    slug: "mistral",
    name: "Mistral",
    kind: "openai-compat",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    listModels: true,
  },
  {
    slug: "cohere",
    name: "Cohere",
    kind: "openai-compat",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    apiKeyEnv: "COHERE_API_KEY",
    listModels: true,
  },
  {
    slug: "qwen",
    name: "Qwen (DashScope)",
    kind: "openai-compat",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    listModels: true,
  },
  {
    slug: "minimax",
    name: "MiniMax",
    kind: "openai-compat",
    baseUrl: "https://api.minimax.io/v1",
    apiKeyEnv: "MINIMAX_API_KEY",
    listModels: false,
  },
  {
    slug: "baseten",
    name: "Baseten",
    kind: "openai-compat",
    baseUrl: "https://inference.baseten.co/v1",
    apiKeyEnv: "BASETEN_API_KEY",
    listModels: true,
  },
  {
    slug: "githubmodels",
    name: "GitHub Models",
    kind: "openai-compat",
    baseUrl: "https://models.github.ai/inference",
    apiKeyEnv: "GITHUB_TOKEN",
    listModels: true,
    aggregator: true,
  },

  // ── Local runtimes ─────────────────────────────────────────────────────────
  {
    slug: "ollama",
    name: "Ollama",
    kind: "openai-compat",
    baseUrl: "http://localhost:11434/v1",
    apiKeyEnv: null,
    quirks: { usageOptional: true, noStreamOptions: true },
    listModels: true,
    local: true,
  },
  {
    slug: "lmstudio",
    name: "LM Studio",
    kind: "openai-compat",
    baseUrl: "http://localhost:1234/v1",
    apiKeyEnv: null,
    quirks: { usageOptional: true },
    listModels: true,
    local: true,
  },
  {
    slug: "llamacpp",
    name: "llama.cpp server",
    kind: "openai-compat",
    baseUrl: "http://localhost:8080/v1",
    apiKeyEnv: null,
    quirks: { usageOptional: true },
    listModels: true,
    local: true,
  },
  {
    slug: "vllm",
    name: "vLLM",
    kind: "openai-compat",
    baseUrl: "http://localhost:8000/v1",
    apiKeyEnv: null,
    quirks: { usageOptional: true },
    listModels: true,
    local: true,
  },
];

const BY_SLUG = new Map(PROVIDER_PRESETS.map((p) => [p.slug, p]));

export function getPreset(slug: string): ProviderPreset | undefined {
  return BY_SLUG.get(slug);
}
