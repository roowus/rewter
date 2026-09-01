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
export {
  PROVIDER_PRESETS,
  getPreset,
  presetForProvider,
  presetSlugForProvider,
  type ProviderPreset,
} from "./providers/presets.js";
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
  CatalogError,
  canSync,
  catalogUrl,
  enrichFromOpenRouter,
  fetchCatalog,
  type CatalogEntry,
  type CatalogOptions,
  type CatalogResult,
} from "./registry/catalog.js";
export {
  CAPABILITY_TAGS,
  CARD_PROMPT_VERSION,
  CARD_SYSTEM_PROMPT,
  CardError,
  buildCardMessages,
  formatCard,
  formatCardReport,
  generateCard,
  generateCards,
  parseCardJson,
  type CardDraft,
  type CardGenerator,
  type CardReport,
  type CardResult,
  type CardTarget,
  type GenerateCardsOptions,
  type GenerateOptions,
  type ParsedCard,
} from "./registry/cards.js";
export { renderDigest, type DigestEntry, type DigestOptions } from "./registry/digest.js";
export {
  applyImport,
  formatImportReport,
  type ApplyImportOptions,
} from "./registry/transfer.js";
export {
  formatSyncReport,
  syncModels,
  type ProviderSyncReport,
  type SyncOptions,
  type SyncReport,
  type SyncTarget,
} from "./registry/sync.js";

export {
  AmbiguousModelError,
  ModelNotFoundError,
  ORCHESTRATOR_MODEL,
  ProviderDisabledError,
  isOrchestratorModel,
  pinnedInitiator,
  projectSlug,
  resolveModel,
  type Registry,
  type Resolution,
} from "./router/resolve.js";
export { Router, type RouteRequest, type RouterOptions } from "./router/router.js";

export {
  PROJECT_HEADER,
  ProjectArchivedError,
  ProjectNotFoundError,
  TASK_ID_HEADER,
  buildApp,
  type AppOptions,
} from "./http/app.js";
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
  DEFAULT_ENV_FILE,
  loadEnvFile,
  mergeEnv,
  type EnvFile,
} from "./config/envfile.js";
export {
  bootSummary,
  openRegistry,
  runUntilSignal,
  startDaemon,
  type OpenRegistry,
  type OpenRegistryOptions,
  type RunningDaemon,
  type SignalHandlerOptions,
  type StartDaemonOptions,
} from "./daemon.js";
export {
  INTERRUPTED_REASON,
  reconcileOnBoot,
  reconcileSummary,
  type ReconcileResult,
} from "./reconcile.js";
export {
  DEFAULT_PIDFILE,
  PidfileSchema,
  pidfilePath,
  readPidfile,
  removePidfile,
  writePidfile,
  type Pidfile,
} from "./service/pidfile.js";
export {
  daemonStatus,
  formatStatus,
  stopDaemon,
  type DaemonStatus,
  type HealthPayload,
  type ProbeOptions,
  type StopOptions,
  type StopOutcome,
} from "./service/control.js";
export {
  LOG_DIR,
  SERVICE_LABEL,
  installService,
  renderPlist,
  stableNodePath,
  uninstallService,
  type InstallOptions,
  type InstallResult,
  type PlistOptions,
} from "./service/launchd.js";
export {
  CLI_COMMAND,
  installCli,
  uninstallCli,
  type LinkOptions,
  type LinkResult,
} from "./service/linkcli.js";
export {
  formatLogs,
  logPaths,
  readLogs,
  tailLines,
  type LogLevel,
  type LogLine,
  type LogSource,
  type ReadLogsOptions,
} from "./service/logs.js";
export {
  DEFAULT_RETENTION_DAYS,
  collectGarbage,
  formatGcResult,
  vacuum,
  type GcOptions,
  type GcResult,
} from "./service/gc.js";

export const SERVER_VERSION = REWTER_VERSION;
