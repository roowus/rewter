import { describe, expect, it } from "vitest";
import { PRV_A, PRV_B, model, provider, registry } from "../testing/registry.js";
import {
  AmbiguousModelError,
  ModelNotFoundError,
  ProviderDisabledError,
  isOrchestratorModel,
  pinnedInitiator,
  projectSlug,
  resolveModel,
} from "./resolve.js";

describe("resolveModel", () => {
  it("resolves an exact id", () => {
    const reg = registry(
      [model("anthropic/claude-sonnet-5")],
      [provider(PRV_A, { kind: "anthropic" })],
    );
    const r = resolveModel(reg, "anthropic/claude-sonnet-5");
    expect(r.model.id).toBe("anthropic/claude-sonnet-5");
    expect(r.upstreamId).toBe("claude-sonnet-5");
    expect(r.provider.kind).toBe("anthropic");
  });

  it("resolves a bare name to its namespaced model", () => {
    const reg = registry([model("anthropic/claude-sonnet-5")]);
    expect(resolveModel(reg, "claude-sonnet-5").model.id).toBe("anthropic/claude-sonnet-5");
  });

  it("resolves by upstream id when it differs from the slug", () => {
    const reg = registry([model("zai/glm", PRV_A, { upstreamId: "glm-5.3" })]);
    expect(resolveModel(reg, "glm-5.3").model.id).toBe("zai/glm");
  });

  it("matches an over-qualified id by suffix", () => {
    // Clients configured against OpenRouter keep sending the vendor-prefixed
    // form even when the model is wired up directly.
    const reg = registry([model("anthropic/claude-sonnet-5")]);
    expect(resolveModel(reg, "openrouter/anthropic/claude-sonnet-5").model.id).toBe(
      "anthropic/claude-sonnet-5",
    );
  });

  it("prefers an exact id over a suffix match on another provider", () => {
    // The same weights behind two keys: asking for the exact id must not become
    // ambiguous just because a longer id also ends with it.
    const reg = registry(
      [
        model("anthropic/claude-sonnet-5", PRV_A),
        model("openrouter/anthropic/claude-sonnet-5", PRV_B),
      ],
      [provider(PRV_A), provider(PRV_B)],
    );
    expect(resolveModel(reg, "anthropic/claude-sonnet-5").model.providerId).toBe(PRV_A);
    expect(resolveModel(reg, "openrouter/anthropic/claude-sonnet-5").model.providerId).toBe(PRV_B);
  });

  it("refuses to guess when a bare name matches two providers", () => {
    const reg = registry(
      [model("anthropic/claude-sonnet-5", PRV_A), model("bedrock/claude-sonnet-5", PRV_B)],
      [provider(PRV_A), provider(PRV_B)],
    );
    // Picking one silently would bill an account the caller never chose.
    expect(() => resolveModel(reg, "claude-sonnet-5")).toThrow(AmbiguousModelError);
    try {
      resolveModel(reg, "claude-sonnet-5");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as AmbiguousModelError).candidates).toEqual([
        "anthropic/claude-sonnet-5",
        "bedrock/claude-sonnet-5",
      ]);
    }
  });

  it("does not match a bare name as a bare substring", () => {
    const reg = registry([model("anthropic/not-sonnet-5")]);
    expect(() => resolveModel(reg, "sonnet-5")).toThrow(ModelNotFoundError);
  });

  it("ignores disabled models", () => {
    const reg = registry([model("anthropic/claude-sonnet-5", PRV_A, { enabled: false })]);
    expect(() => resolveModel(reg, "claude-sonnet-5")).toThrow(ModelNotFoundError);
  });

  it("rejects a model whose provider is disabled", () => {
    // Distinct from "not found": the name is right, the account is switched off.
    const reg = registry(
      [model("anthropic/claude-sonnet-5")],
      [provider(PRV_A, { enabled: false })],
    );
    expect(() => resolveModel(reg, "claude-sonnet-5")).toThrow(ProviderDisabledError);
  });

  it("throws on an unknown model", () => {
    expect(() => resolveModel(registry([], []), "nope")).toThrow(ModelNotFoundError);
  });
});

describe("orchestrator pseudo-model", () => {
  it.each([
    "auto",
    "auto/orchestrator",
    "auto/orchestrator:anthropic/claude-opus-5",
    "auto@rewter",
    "auto/orchestrator@rewter",
    "auto@rewter:anthropic/claude-opus-5",
    "auto/orchestrator@rewter:anthropic/claude-opus-5",
  ])("recognizes %s", (name) => {
    expect(isOrchestratorModel(name)).toBe(true);
  });

  it.each(["anthropic/claude-sonnet-5", "automatic/thing", "auto-x", "auto/orch@x"])(
    "does not claim %s",
    (name) => {
      expect(isOrchestratorModel(name)).toBe(false);
    },
  );

  it("extracts a pinned initiator", () => {
    expect(pinnedInitiator("auto/orchestrator:anthropic/claude-opus-5")).toBe(
      "anthropic/claude-opus-5",
    );
    expect(pinnedInitiator("auto/orchestrator")).toBeNull();
    expect(pinnedInitiator("auto/orchestrator:")).toBeNull();
  });

  it("extracts a pin that follows a project slug", () => {
    expect(pinnedInitiator("auto@rewter:anthropic/claude-opus-5")).toBe("anthropic/claude-opus-5");
    expect(pinnedInitiator("auto/orchestrator@rewter")).toBeNull();
  });

  it("extracts a project slug, with and without a pin", () => {
    expect(projectSlug("auto@rewter")).toBe("rewter");
    expect(projectSlug("auto/orchestrator@rewter")).toBe("rewter");
    expect(projectSlug("auto/orchestrator@rewter:anthropic/claude-opus-5")).toBe("rewter");
    expect(projectSlug("auto/orchestrator")).toBeNull();
    expect(projectSlug("auto/orchestrator:anthropic/claude-opus-5")).toBeNull();
    expect(projectSlug("anthropic/claude-sonnet-5")).toBeNull();
    // Empty suffix is "no project", not a project named "".
    expect(projectSlug("auto@")).toBeNull();
  });

  it("routing accepts a malformed slug — existence is the lookup's question", () => {
    expect(isOrchestratorModel("auto@Not_A_Slug")).toBe(true);
    expect(projectSlug("auto@Not_A_Slug")).toBe("Not_A_Slug");
  });
});
