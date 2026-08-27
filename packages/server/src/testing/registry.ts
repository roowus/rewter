/**
 * Registry fixtures: providers and models built with sane defaults so a test
 * only states the field it cares about.
 *
 * Test-only module; nothing here is exported from the package entrypoint.
 */
import { type Model, ModelIdSchema, type Provider, ProviderIdSchema } from "@rewter/shared";
import type { Registry } from "../router/resolve.js";

/** Fixed so ids and timestamps are stable across runs. */
export const TS = 1_756_252_800_000;

export const PRV_A = ProviderIdSchema.parse("prv_aaaaaaaaaaaa");
export const PRV_B = ProviderIdSchema.parse("prv_bbbbbbbbbbbb");

export function provider(id: string = PRV_A, overrides: Partial<Provider> = {}): Provider {
  return {
    id: ProviderIdSchema.parse(id),
    name: "Test Provider",
    kind: "openai-compat",
    baseUrl: "https://example.test/v1",
    apiKeyRef: "TEST_API_KEY",
    enabled: true,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

export function model(
  id: string,
  providerId: string = PRV_A,
  overrides: Partial<Model> = {},
): Model {
  return {
    id: ModelIdSchema.parse(id),
    providerId: ProviderIdSchema.parse(providerId),
    upstreamId: id.slice(id.lastIndexOf("/") + 1),
    displayName: id,
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    pricing: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    },
    modalities: ["text"],
    supports: { tools: true, streaming: true, vision: false, caching: true },
    source: "manual",
    enabled: true,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

/** An in-memory Registry — enough for resolution tests, no database needed. */
export function registry(models: Model[], providers: Provider[] = [provider()]): Registry {
  return {
    listModels: (opts) => (opts?.enabledOnly === true ? models.filter((m) => m.enabled) : models),
    getProvider: (id) => providers.find((p) => p.id === id),
  };
}
