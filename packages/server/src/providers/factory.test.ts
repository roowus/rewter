import type { Provider, ProviderKind } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "./anthropic.js";
import { MissingApiKeyError, createAdapter } from "./factory.js";
import { GoogleAdapter } from "./google.js";
import { OpenAICompatAdapter } from "./openai-compat.js";

const provider = (over: Partial<Provider> = {}): Provider => ({
  id: "prv_000000000001" as Provider["id"],
  name: "OpenRouter",
  kind: "openai-compat" as ProviderKind,
  baseUrl: null,
  apiKeyRef: "OPENROUTER_API_KEY",
  enabled: true,
  createdAt: 1_756_252_800_000,
  updatedAt: 1_756_252_800_000,
  ...over,
});

describe("createAdapter", () => {
  it("builds the adapter class matching the provider kind", () => {
    const env = { K: "secret" };
    expect(
      createAdapter(provider({ kind: "openai-compat", apiKeyRef: "K" }), { env }),
    ).toBeInstanceOf(OpenAICompatAdapter);
    expect(
      createAdapter(provider({ name: "Anthropic", kind: "anthropic", apiKeyRef: "K" }), { env }),
    ).toBeInstanceOf(AnthropicAdapter);
    expect(
      createAdapter(provider({ name: "Google Gemini", kind: "google", apiKeyRef: "K" }), { env }),
    ).toBeInstanceOf(GoogleAdapter);
  });

  it("fails loudly when the referenced env var is unset", () => {
    expect(() => createAdapter(provider({ apiKeyRef: "NOT_SET_ANYWHERE" }), { env: {} })).toThrow(
      MissingApiKeyError,
    );
  });

  it("treats an empty env var as unset — an empty key would 401 later", () => {
    expect(() => createAdapter(provider({ apiKeyRef: "EMPTY" }), { env: { EMPTY: "" } })).toThrow(
      MissingApiKeyError,
    );
  });

  it("names the provider and the variable in the error, but never a value", () => {
    try {
      createAdapter(provider({ name: "OpenRouter", apiKeyRef: "OPENROUTER_API_KEY" }), { env: {} });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingApiKeyError);
      const e = err as MissingApiKeyError;
      expect(e.providerName).toBe("OpenRouter");
      expect(e.envVar).toBe("OPENROUTER_API_KEY");
      expect(e.message).toContain("OPENROUTER_API_KEY");
    }
  });

  it("allows a keyless provider — local runtimes need no credential", () => {
    const adapter = createAdapter(provider({ name: "Ollama", apiKeyRef: null }), { env: {} });
    expect(adapter).toBeInstanceOf(OpenAICompatAdapter);
    expect(adapter.kind).toBe("openai-compat");
  });

  it("reads keys from the injected env, never a hardcoded default", () => {
    // The real process env is bypassed entirely when `env` is supplied.
    expect(() =>
      createAdapter(provider({ apiKeyRef: "REWTER_TEST_ABSENT_KEY" }), { env: {} }),
    ).toThrow(MissingApiKeyError);
  });

  it("prefers the provider's own baseUrl over the preset default", async () => {
    const seen: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response("{}", { status: 500 });
    }) as unknown as typeof globalThis.fetch;

    const adapter = createAdapter(
      provider({ name: "Ollama", apiKeyRef: null, baseUrl: "http://127.0.0.1:9999/v1" }),
      { env: {}, fetch },
    );
    for await (const _ of adapter.stream({ model: "m", messages: [] })) {
      // Drain; the 500 becomes an error chunk. We only care about the URL.
    }
    expect(seen[0]).toContain("127.0.0.1:9999");
  });

  it("falls back to the preset baseUrl and quirks when the row omits them", async () => {
    const seen: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response("{}", { status: 500 });
    }) as unknown as typeof globalThis.fetch;

    const adapter = createAdapter(provider({ name: "Ollama", apiKeyRef: null, baseUrl: null }), {
      env: {},
      fetch,
    });
    for await (const _ of adapter.stream({ model: "m", messages: [] })) {
      // Drain.
    }
    // Preset default for the ollama slug.
    expect(seen[0]).toContain("localhost:11434");
  });
});
