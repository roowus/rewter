import { ProviderKindSchema } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS, getPreset } from "./presets.js";

describe("provider presets", () => {
  it("covers a broad upstream surface across every category", () => {
    // The point of the table is breadth: an aggregator-style router, not a
    // handful of hardcoded vendors.
    expect(PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(25);
    expect(PROVIDER_PRESETS.filter((p) => p.aggregator === true).length).toBeGreaterThanOrEqual(5);
    expect(PROVIDER_PRESETS.filter((p) => p.local === true).length).toBeGreaterThanOrEqual(3);
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

  it("getPreset resolves by slug and returns undefined for unknowns", () => {
    expect(getPreset("openrouter")?.name).toBe("OpenRouter");
    expect(getPreset("ollama")?.local).toBe(true);
    expect(getPreset("nope")).toBeUndefined();
  });
});
