/**
 * Adapter construction. The only place that reads secrets out of the
 * environment: a Provider row names an env var, this resolves it. If the
 * variable is unset the failure is loud and immediate rather than a 401 later.
 */
import type { Provider } from "@rewter/shared";
import { AnthropicAdapter } from "./anthropic.js";
import { GoogleAdapter } from "./google.js";
import { OpenAICompatAdapter } from "./openai-compat.js";
import { getPreset } from "./presets.js";
import type { AdapterConfig, ProviderAdapter } from "./types.js";

export class MissingApiKeyError extends Error {
  constructor(
    readonly providerName: string,
    readonly envVar: string,
  ) {
    super(`provider "${providerName}" needs env var ${envVar}, which is unset`);
    this.name = "MissingApiKeyError";
  }
}

export interface FactoryOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
}

export function createAdapter(provider: Provider, opts: FactoryOptions = {}): ProviderAdapter {
  const env = opts.env ?? process.env;
  const preset = getPreset(provider.name.toLowerCase()) ?? getPreset(providerSlug(provider));

  let apiKey: string | null = null;
  if (provider.apiKeyRef !== null) {
    const value = env[provider.apiKeyRef];
    if (value === undefined || value === "") {
      throw new MissingApiKeyError(provider.name, provider.apiKeyRef);
    }
    apiKey = value;
  }

  const config: AdapterConfig = {
    apiKey,
    baseUrl: provider.baseUrl ?? preset?.baseUrl ?? null,
    ...(preset?.quirks !== undefined && { quirks: preset.quirks }),
    ...(opts.fetch !== undefined && { fetch: opts.fetch }),
  };

  switch (provider.kind) {
    case "anthropic":
      return new AnthropicAdapter(config);
    case "google":
      return new GoogleAdapter(config);
    case "openai-compat":
      return new OpenAICompatAdapter(config);
  }
}

/** Providers are usually seeded from a preset, so the name matches the slug. */
function providerSlug(provider: Provider): string {
  return provider.name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
