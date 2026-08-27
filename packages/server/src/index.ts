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

export { FREE_PRICING, computeCost, type CostBreakdown } from "./costs/compute.js";

export {
  AmbiguousModelError,
  ModelNotFoundError,
  ORCHESTRATOR_MODEL,
  ProviderDisabledError,
  isOrchestratorModel,
  pinnedInitiator,
  resolveModel,
  type Registry,
  type Resolution,
} from "./router/resolve.js";
export { Router, type RouteRequest, type RouterOptions } from "./router/router.js";

export { buildApp, type AppOptions } from "./http/app.js";
export {
  roleFrame,
  toOpenAIChunk,
  type StreamFrameContext,
} from "./http/openai-stream.js";
export { HEARTBEAT_MS, SseWriter, type SseWriterOptions } from "./http/sse.js";

export {
  ConfigError,
  ConfigSchema,
  DEFAULT_CONFIG_PATH,
  DEFAULT_PORT,
  ModelConfigSchema,
  ProviderConfigSchema,
  expandPath,
  loadConfig,
  type Config,
  type LoadedConfig,
  type ModelConfig,
  type ProviderConfig,
} from "./config/config.js";
export {
  SeedError,
  providerIdForSlug,
  seedRegistry,
  type SeedResult,
  type SeedTarget,
} from "./config/seed.js";
export {
  bootSummary,
  runUntilSignal,
  startDaemon,
  type RunningDaemon,
  type SignalHandlerOptions,
  type StartDaemonOptions,
} from "./daemon.js";

export const SERVER_VERSION = REWTER_VERSION;
