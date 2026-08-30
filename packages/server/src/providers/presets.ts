/**
 * Known upstreams. Adding a provider is a table entry, not code: pick an
 * adapter kind, a baseUrl, an env var name, and any quirks. Anything speaking
 * the OpenAI wire format (the overwhelming majority) needs no new adapter.
 *
 * `apiKeyEnv` is the env var *name* — raw keys never enter the DB or this file.
 *
 * Much of the breadth below was sourced from OmniRoute's provider registry
 * (https://github.com/diegosouzapw/OmniRoute, MIT, © 2026 diegosouzapw), whose
 * `open-sse/config/providers/registry/` carries ~250 upstreams. Two conversions
 * were needed: their `baseUrl` ends at `/chat/completions` where rewter's stops
 * at the API root, and they key auth per entry where rewter names an env var.
 * Every row here was additionally probed live — an upstream whose host did not
 * answer at all is not in the table, and `listModels` reflects whether
 * `GET <baseUrl>/models` actually exists rather than whether it was hoped to.
 */
import { type ProviderId, ProviderIdSchema, type ProviderKind } from "@rewter/shared";
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
  {
    slug: "siliconflow",
    name: "SiliconFlow",
    kind: "openai-compat",
    baseUrl: "https://api.siliconflow.com/v1",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "nvidia",
    name: "NVIDIA NIM",
    kind: "openai-compat",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKeyEnv: "NVIDIA_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "huggingface",
    name: "Hugging Face Router",
    kind: "openai-compat",
    baseUrl: "https://router.huggingface.co/v1",
    apiKeyEnv: "HF_TOKEN",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "vercel",
    name: "Vercel AI Gateway",
    kind: "openai-compat",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    apiKeyEnv: "AI_GATEWAY_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "requesty",
    name: "Requesty",
    kind: "openai-compat",
    baseUrl: "https://router.requesty.ai/v1",
    apiKeyEnv: "REQUESTY_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "llmgateway",
    name: "LLM Gateway",
    kind: "openai-compat",
    baseUrl: "https://api.llmgateway.io/v1",
    apiKeyEnv: "LLMGATEWAY_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "nanogpt",
    name: "NanoGPT",
    kind: "openai-compat",
    baseUrl: "https://nano-gpt.com/api/v1",
    apiKeyEnv: "NANOGPT_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "zenmux",
    name: "ZenMux",
    kind: "openai-compat",
    baseUrl: "https://zenmux.ai/api/v1",
    apiKeyEnv: "ZENMUX_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "chutes",
    name: "Chutes",
    kind: "openai-compat",
    baseUrl: "https://llm.chutes.ai/v1",
    apiKeyEnv: "CHUTES_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "modelscope",
    name: "ModelScope",
    kind: "openai-compat",
    baseUrl: "https://api-inference.modelscope.cn/v1",
    apiKeyEnv: "MODELSCOPE_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "ollamacloud",
    name: "Ollama Cloud",
    kind: "openai-compat",
    baseUrl: "https://ollama.com/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "nscale",
    name: "nscale",
    kind: "openai-compat",
    baseUrl: "https://inference.api.nscale.com/v1",
    apiKeyEnv: "NSCALE_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "featherless",
    name: "Featherless AI",
    kind: "openai-compat",
    baseUrl: "https://api.featherless.ai/v1",
    apiKeyEnv: "FEATHERLESS_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "friendliai",
    name: "FriendliAI",
    kind: "openai-compat",
    baseUrl: "https://api.friendli.ai/serverless/v1",
    apiKeyEnv: "FRIENDLI_TOKEN",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "inferencenet",
    name: "Inference.net",
    kind: "openai-compat",
    baseUrl: "https://api.inference.net/v1",
    apiKeyEnv: "INFERENCE_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "scaleway",
    name: "Scaleway Generative APIs",
    kind: "openai-compat",
    baseUrl: "https://api.scaleway.ai/v1",
    apiKeyEnv: "SCALEWAY_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "digitalocean",
    name: "DigitalOcean Gradient",
    kind: "openai-compat",
    baseUrl: "https://inference.do-ai.run/v1",
    apiKeyEnv: "DIGITALOCEAN_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "heroku",
    name: "Heroku Inference",
    kind: "openai-compat",
    baseUrl: "https://us.inference.heroku.com/v1",
    apiKeyEnv: "INFERENCE_KEY",
    // `/v1/models` 404s; the catalog is a dyno-scoped add-on listing.
    listModels: false,
    aggregator: true,
  },
  {
    slug: "wandb",
    name: "W&B Inference",
    kind: "openai-compat",
    baseUrl: "https://api.inference.wandb.ai/v1",
    apiKeyEnv: "WANDB_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "venice",
    name: "Venice AI",
    kind: "openai-compat",
    baseUrl: "https://api.venice.ai/api/v1",
    apiKeyEnv: "VENICE_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "byteplus",
    name: "BytePlus ModelArk",
    kind: "openai-compat",
    baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3",
    apiKeyEnv: "BYTEPLUS_API_KEY",
    listModels: true,
    aggregator: true,
  },
  {
    slug: "qianfan",
    name: "Baidu Qianfan",
    kind: "openai-compat",
    baseUrl: "https://qianfan.baidubce.com/v2",
    apiKeyEnv: "QIANFAN_API_KEY",
    listModels: true,
    aggregator: true,
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
    slug: "ai21",
    name: "AI21 Labs",
    kind: "openai-compat",
    baseUrl: "https://api.ai21.com/studio/v1",
    apiKeyEnv: "AI21_API_KEY",
    // `/models` answers 410 Gone: the endpoint was retired, not merely gated.
    listModels: false,
  },
  {
    slug: "reka",
    name: "Reka AI",
    kind: "openai-compat",
    baseUrl: "https://api.reka.ai/v1",
    apiKeyEnv: "REKA_API_KEY",
    listModels: true,
  },
  {
    slug: "writer",
    name: "Writer Palmyra",
    kind: "openai-compat",
    baseUrl: "https://api.writer.com/v1",
    apiKeyEnv: "WRITER_API_KEY",
    listModels: true,
  },
  {
    slug: "upstage",
    name: "Upstage Solar",
    kind: "openai-compat",
    baseUrl: "https://api.upstage.ai/v1",
    apiKeyEnv: "UPSTAGE_API_KEY",
    listModels: true,
  },
  {
    slug: "liquid",
    name: "Liquid AI",
    kind: "openai-compat",
    baseUrl: "https://inference.liquid.ai/v1",
    apiKeyEnv: "LIQUID_API_KEY",
    listModels: true,
  },
  {
    slug: "inception",
    name: "Inception Mercury",
    kind: "openai-compat",
    baseUrl: "https://api.inceptionlabs.ai/v1",
    apiKeyEnv: "INCEPTION_API_KEY",
    listModels: true,
  },
  {
    slug: "nousresearch",
    name: "Nous Research",
    kind: "openai-compat",
    baseUrl: "https://inference-api.nousresearch.com/v1",
    apiKeyEnv: "NOUS_API_KEY",
    listModels: true,
  },
  {
    slug: "morph",
    name: "Morph",
    kind: "openai-compat",
    baseUrl: "https://api.morphllm.com/v1",
    apiKeyEnv: "MORPH_API_KEY",
    listModels: true,
  },
  {
    slug: "metallama",
    name: "Meta Llama API",
    kind: "openai-compat",
    baseUrl: "https://api.llama.com/compat/v1",
    apiKeyEnv: "LLAMA_API_KEY",
    listModels: true,
  },
  {
    slug: "codestral",
    name: "Mistral Codestral",
    kind: "openai-compat",
    baseUrl: "https://codestral.mistral.ai/v1",
    apiKeyEnv: "CODESTRAL_API_KEY",
    // The code endpoint serves one model family and exposes no catalog route.
    listModels: false,
  },
  {
    slug: "longcat",
    name: "LongCat (Meituan)",
    kind: "openai-compat",
    baseUrl: "https://api.longcat.chat/openai/v1",
    apiKeyEnv: "LONGCAT_API_KEY",
    listModels: true,
  },
  {
    slug: "stepfun",
    name: "StepFun",
    kind: "openai-compat",
    baseUrl: "https://api.stepfun.com/v1",
    apiKeyEnv: "STEPFUN_API_KEY",
    listModels: true,
  },
  {
    slug: "baichuan",
    name: "Baichuan",
    kind: "openai-compat",
    baseUrl: "https://api.baichuan-ai.com/v1",
    apiKeyEnv: "BAICHUAN_API_KEY",
    listModels: true,
  },
  {
    slug: "hunyuan",
    name: "Tencent Hunyuan",
    kind: "openai-compat",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    apiKeyEnv: "HUNYUAN_API_KEY",
    listModels: true,
  },
  {
    slug: "volcengine",
    name: "Volcengine Ark",
    kind: "openai-compat",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyEnv: "ARK_API_KEY",
    listModels: true,
  },
  {
    slug: "sealion",
    name: "SEA-LION",
    kind: "openai-compat",
    baseUrl: "https://api.sea-lion.ai/v1",
    apiKeyEnv: "SEALION_API_KEY",
    listModels: true,
  },
  {
    slug: "typhoon",
    name: "Typhoon (SCB 10X)",
    kind: "openai-compat",
    baseUrl: "https://api.opentyphoon.ai/v1",
    apiKeyEnv: "TYPHOON_API_KEY",
    listModels: true,
  },
  {
    slug: "sarvam",
    name: "Sarvam AI",
    kind: "openai-compat",
    baseUrl: "https://api.sarvam.ai/v1",
    apiKeyEnv: "SARVAM_API_KEY",
    listModels: true,
  },
  {
    slug: "publicai",
    name: "Public AI",
    kind: "openai-compat",
    baseUrl: "https://api.publicai.co/v1",
    apiKeyEnv: "PUBLICAI_API_KEY",
    listModels: true,
  },
  {
    slug: "mixlayer",
    name: "Mixlayer",
    kind: "openai-compat",
    baseUrl: "https://models.mixlayer.ai/v1",
    apiKeyEnv: "MIXLAYER_API_KEY",
    listModels: true,
  },
  {
    slug: "clovastudio",
    name: "Naver CLOVA Studio",
    kind: "openai-compat",
    baseUrl: "https://clovastudio.stream.ntruss.com/v1/openai",
    apiKeyEnv: "CLOVASTUDIO_API_KEY",
    listModels: true,
  },
  {
    slug: "iflytek",
    name: "iFlytek Spark",
    kind: "openai-compat",
    baseUrl: "https://spark-api-open.xf-yun.com/v1",
    apiKeyEnv: "SPARK_API_KEY",
    listModels: true,
  },
  {
    slug: "poolside",
    name: "Poolside",
    kind: "openai-compat",
    baseUrl: "https://inference.poolside.ai/v1",
    apiKeyEnv: "POOLSIDE_API_KEY",
    listModels: true,
  },
  {
    slug: "opper",
    name: "Opper",
    kind: "openai-compat",
    baseUrl: "https://api.opper.ai/v3/compat",
    apiKeyEnv: "OPPER_API_KEY",
    listModels: true,
  },

  // ── Local aggregators ──────────────────────────────────────────────────────
  // Both local and an aggregator, which no other preset is: it runs on this
  // machine and needs no key, but the models it lists belong to Anthropic,
  // Z.AI, xAI and the rest — it holds *their* credentials so rewter needn't.
  {
    slug: "9router",
    name: "9router",
    kind: "openai-compat",
    baseUrl: "http://localhost:20128/v1",
    // Binds to localhost and authenticates nothing; a bearer token would be
    // rejected as an unexpected header rather than ignored.
    apiKeyEnv: null,
    // It does report usage (verified against a live instance), so this is the
    // safety net rather than the expectation — same reasoning as the other
    // local presets, where a build that quietly stops answering must degrade to
    // an unknown cost rather than a recorded zero (#14).
    quirks: { usageOptional: true },
    listModels: true,
    local: true,
    aggregator: true,
    docsUrl: "https://github.com/9cat/9router",
  },

  // ── Local runtimes ─────────────────────────────────────────────────────────
  {
    slug: "ollama",
    name: "Ollama",
    kind: "openai-compat",
    baseUrl: "http://localhost:11434/v1",
    apiKeyEnv: null,
    // Ollama honours `stream_options.include_usage` (verified against 0.32.0),
    // so ask for it: suppressing the request made every local call record zero
    // tokens, which `usageOptional` then accepted without complaint (#14).
    // `usageOptional` stays as the safety net for older builds that ignore it.
    quirks: { usageOptional: true },
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

/**
 * Deterministic provider id from a slug, so a re-seed or a sync hits the same
 * row rather than minting a new one and orphaning its costs and events.
 *
 * The id schema wants exactly 12 chars of `[0-9a-z]`, so this is a readable
 * 6-char prefix plus 6 hash chars: `prv_anthro1f2g3h` says which provider it is
 * at a glance while keeping two long slugs sharing a prefix distinct.
 *
 * It lives here rather than with the seeder because it makes the slug the
 * provider's *identity*, which is what lets `presetSlugForProvider` invert it.
 */
export function providerIdForSlug(slug: string): ProviderId {
  const prefix = slug
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 6)
    .padEnd(6, "0");
  return ProviderIdSchema.parse(`prv_${prefix}${hash6(slug)}`);
}

/** FNV-1a → 6 chars of `[0-9a-z]`. Not security-relevant; just a spreader. */
function hash6(input: string): string {
  let h = 2_166_136_261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
}

/**
 * Recover a provider's preset slug from its row.
 *
 * The display **name** is not a reliable source: `"Google Gemini"` normalizes
 * to `googlegemini` and `"Z.AI (GLM)"` to `zaiglm`, neither of which is a
 * preset slug — a name-based lookup silently finds no preset for a third of the
 * table, which for sync means skipping those providers entirely. The **id** is
 * reliable, because `providerIdForSlug` derives it from the slug, so a reverse
 * index over the preset table is exact for anything that came from a preset.
 * The normalized name remains the fallback for a hand-rolled provider.
 */
export function presetSlugForProvider(provider: { id: string; name: string }): string {
  return byId().get(provider.id) ?? provider.name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The preset itself, or `undefined` for a provider that isn't one of ours. */
export function presetForProvider(provider: {
  id: string;
  name: string;
}): ProviderPreset | undefined {
  return getPreset(presetSlugForProvider(provider));
}

let idIndex: Map<string, string> | undefined;
function byId(): Map<string, string> {
  idIndex ??= new Map(PROVIDER_PRESETS.map((p) => [providerIdForSlug(p.slug), p.slug]));
  return idIndex;
}
