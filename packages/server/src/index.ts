import { REWTER_VERSION } from "@rewter/shared";

export { openDb, type Db } from "./db/connection.js";
export * as schema from "./db/schema.js";
export { Repos } from "./db/repos.js";
export { EventBus, type EventListener } from "./events/bus.js";

export { AnthropicAdapter } from "./providers/anthropic.js";
export { collectStream } from "./providers/collect.js";
export {
  MissingApiKeyError,
  createAdapter,
  type FactoryOptions,
} from "./providers/factory.js";
export { GoogleAdapter } from "./providers/google.js";
export { OpenAICompatAdapter } from "./providers/openai-compat.js";
export { PROVIDER_PRESETS, getPreset, type ProviderPreset } from "./providers/presets.js";
export {
  AdapterError,
  isRetryableStatus,
  toErrorChunk,
  type AdapterConfig,
  type AdapterRequest,
  type ProviderAdapter,
  type Quirks,
} from "./providers/types.js";

export const SERVER_VERSION = REWTER_VERSION;
