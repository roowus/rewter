import { ProviderKindSchema } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS, getPreset } from "./presets.js";

describe("provider presets", () => {
  it("covers a broad upstream surface across every category", () => {
    // The point of the table is breadth: an aggregator-style router, not a
    // handful of hardcoded vendors.
    expect(PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(70);
    expect(PROVIDER_PRESETS.filter((p) => p.aggregator === true).length).toBeGreaterThanOrEqual(25);
    expect(PROVIDER_PRESETS.filter((p) => p.local === true).length).toBeGreaterThanOrEqual(3);
  });

  it("keeps every baseUrl at the API root, not the chat path", () => {
    // OmniRoute's registry — where much of this breadth came from — stores the
    // full `…/chat/completions` URL, because its executor posts to `baseUrl`
    // verbatim. rewter hands `baseUrl` to the OpenAI SDK, which appends its own
    // path, so a row copied across unconverted would POST to
    // `/chat/completions/chat/completions` and 404 at the first real request —
    // a mistake no unit test would otherwise catch and no fixture would show.
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.baseUrl ?? "").not.toContain("/chat/completions");
    }
  });

  it("gives every keyed preset a distinct env var", () => {
    // Two upstreams sharing one variable means configuring the second silently
    // reconfigures the first.
    const envs = PROVIDER_PRESETS.map((p) => p.apiKeyEnv).filter((e): e is string => e !== null);
    expect(new Set(envs).size).toBe(envs.length);
  });

  it("has unique slugs and names", () => {
    const slugs = PROVIDER_PRESETS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const names = PROVIDER_PRESETS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("uses slugs that are safe as a model-id namespace", () => {
    for (const preset of PROVIDER_PRESETS) {
      // Model ids are `<slug>/<model>`, so a slug may not contain a slash.
      expect(preset.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("declares a valid kind and a parseable baseUrl", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(() => ProviderKindSchema.parse(preset.kind)).not.toThrow();
      if (preset.baseUrl !== null) {
        expect(() => new URL(preset.baseUrl as string)).not.toThrow();
      }
    }
  });

  it("names env vars rather than embedding keys", () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.apiKeyEnv === null) {
        // Only a local runtime may skip the key.
        expect(preset.local).toBe(true);
        continue;
      }
      // SCREAMING_SNAKE is an env var *name*; a real key would never match.
      expect(preset.apiKeyEnv).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it("routes all but the two first-party SDKs through openai-compat", () => {
    const native = PROVIDER_PRESETS.filter((p) => p.kind !== "openai-compat");
    expect(native.map((p) => p.slug).sort()).toEqual(["anthropic", "google"]);
  });

  it("gives every local runtime usageOptional — they often omit usage", () => {
    for (const preset of PROVIDER_PRESETS.filter((p) => p.local === true)) {
      expect(preset.quirks?.usageOptional).toBe(true);
      expect(preset.baseUrl).toContain("localhost");
    }
  });

  it("asks local runtimes for streaming usage", () => {
    // `usageOptional` is a safety net for upstreams that don't answer, not a
    // reason to stop asking. Pairing it with `noStreamOptions` made every local
    // call record zero tokens and look like a legitimately free request — the
    // one failure `usageOptional` is designed not to complain about (#14).
    for (const preset of PROVIDER_PRESETS.filter((p) => p.local === true)) {
      expect(preset.quirks?.noStreamOptions).not.toBe(true);
    }
  });

  it("getPreset resolves by slug and returns undefined for unknowns", () => {
    expect(getPreset("openrouter")?.name).toBe("OpenRouter");
    expect(getPreset("ollama")?.local).toBe(true);
    expect(getPreset("nope")).toBeUndefined();
  });
});
