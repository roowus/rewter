/**
 * Adapter construction. The only place that reads secrets out of the
 * environment: a Provider row names an env var, this resolves it. If the
 * variable is unset the failure is loud and immediate rather than a 401 later.
 */
import type { Provider } from "@rewter/shared";
import { AnthropicAdapter } from "./anthropic.js";
import { GoogleAdapter } from "./google.js";
import { OpenAICompatAdapter } from "./openai-compat.js";
import { presetForProvider } from "./presets.js";
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

/**
 * An adapter built only to be *asked* what it would send.
 *
 * Deliberately not the same door as `createAdapter`. It skips the env lookup —
 * describing a request must work on a machine that has never held that
 * provider's key, and the alternative (a 500 from the debug panel because
 * `XAI_API_KEY` is unset) makes the tool useless exactly where it is most
 * needed. Nothing here can reach an upstream anyway: keys live in headers the
 * SDK attaches at call time, and the transport throws rather than dials.
 */
export function createDescribeOnlyAdapter(provider: Provider): ProviderAdapter {
  const preset = presetForProvider(provider);
  const config: AdapterConfig = {
    apiKey: null,
    baseUrl: provider.baseUrl ?? preset?.baseUrl ?? null,
    ...(preset?.quirks !== undefined && { quirks: preset.quirks }),
    // Belt to `describeRequest`'s braces: if a future adapter ever tried to
    // send from a describe path, it fails loudly here instead of billing the
    // user for a keystroke.
    fetch: (() => {
      throw new Error("describe-only adapter must not send");
    }) as unknown as typeof globalThis.fetch,
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

export function createAdapter(provider: Provider, opts: FactoryOptions = {}): ProviderAdapter {
  const env = opts.env ?? process.env;
  const preset = presetForProvider(provider);

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
