/**
 * The probe's whole job is telling five failures apart, so that is what these
 * assert. A test that only checked "ok vs not ok" would pass on a probe that
 * reported a dead localhost runtime as a bad key — which is the exact wrong
 * turn the Test button exists to prevent someone taking.
 *
 * The redaction cases are here rather than in an HTTP test because this is the
 * layer that knows the key. Google's catalog carries it in the query string, so
 * the URL inside a thrown fetch error is a real leak path, not a hypothetical.
 */
import type { Provider } from "@rewter/shared";
import { describe, expect, it, vi } from "vitest";
import { providerIdForSlug } from "../providers/presets.js";
import { probeProvider } from "./probe.js";

function provider(slug: string, over: Partial<Provider> = {}): Provider {
  return {
    id: providerIdForSlug(slug),
    name: slug,
    kind: "openai-compat",
    baseUrl: null,
    apiKeyRef: "OPENAI_API_KEY",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const catalog = (ids: string[]) =>
  new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("probeProvider", () => {
  it("reports the catalog size when the upstream answers", async () => {
    const result = await probeProvider(provider("openai"), {
      env: { OPENAI_API_KEY: "sk-live-abcdefghij" },
      fetch: vi.fn(async () => catalog(["gpt-5", "gpt-5-mini"])),
      clock: () => 42,
    });
    expect(result.verdict).toBe("ok");
    expect(result.models).toBe(2);
    expect(result.checkedAt).toBe(42);
  });

  it("counts zero models as reachable, not as a failure", async () => {
    // A local runtime with nothing pulled. The host is up and the answer is
    // "none" — calling that unreachable would send someone to check the port.
    const result = await probeProvider(provider("ollama", { apiKeyRef: null }), {
      env: {},
      fetch: vi.fn(async () => catalog([])),
    });
    expect(result.verdict).toBe("ok");
    expect(result.models).toBe(0);
    expect(result.message).toContain("0 models");
  });

  it("says no_key without sending anything when the env var is unset", async () => {
    const doFetch = vi.fn(async () => catalog([]));
    const result = await probeProvider(provider("openai"), { env: {}, fetch: doFetch });
    expect(result.verdict).toBe("no_key");
    // The point of the verdict: nothing left the machine.
    expect(doFetch).not.toHaveBeenCalled();
    expect(result.message).toContain("OPENAI_API_KEY");
  });

  it("treats an empty-string key as unset", async () => {
    // `export OPENAI_API_KEY=` is the shape of a shell profile edited in a
    // hurry, and it would otherwise sail into a confusing 401.
    const result = await probeProvider(provider("openai"), {
      env: { OPENAI_API_KEY: "" },
      fetch: vi.fn(async () => catalog([])),
    });
    expect(result.verdict).toBe("no_key");
  });

  it("never asks a keyless local runtime for a key", async () => {
    const result = await probeProvider(provider("lmstudio", { apiKeyRef: null }), {
      env: {},
      fetch: vi.fn(async () => catalog(["qwen3"])),
    });
    expect(result.verdict).toBe("ok");
  });

  it("separates a rejected key from an unreachable host", async () => {
    const refused = await probeProvider(provider("openai"), {
      env: { OPENAI_API_KEY: "sk-live-abcdefghij" },
      fetch: vi.fn(async () => new Response("nope", { status: 401 })),
    });
    expect(refused.verdict).toBe("refused");
    expect(refused.statusCode).toBe(401);
    // The sentence has to name the fix, not the status.
    expect(refused.message).toContain("wrong or revoked");

    const dead = await probeProvider(provider("ollama", { apiKeyRef: null }), {
      env: {},
      fetch: vi.fn(async () => {
        throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:11434");
      }),
    });
    expect(dead.verdict).toBe("unreachable");
    expect(dead.statusCode).toBeNull();
    expect(dead.message).toContain("ECONNREFUSED");
  });

  it("calls a 404 a base-URL problem rather than a key problem", async () => {
    const result = await probeProvider(provider("openai"), {
      env: { OPENAI_API_KEY: "sk-live-abcdefghij" },
      fetch: vi.fn(async () => new Response("", { status: 404 })),
    });
    expect(result.verdict).toBe("refused");
    expect(result.message).toContain("base URL");
  });

  it("says a rate limit means the key works", async () => {
    const result = await probeProvider(provider("openai"), {
      env: { OPENAI_API_KEY: "sk-live-abcdefghij" },
      fetch: vi.fn(async () => new Response("", { status: 429 })),
    });
    expect(result.verdict).toBe("refused");
    expect(result.message).toContain("the key works");
  });

  it("declines to guess for a provider with no catalog endpoint", async () => {
    // Six presets are in this state. The alternative — a one-token completion —
    // bills the user for pressing a button.
    const doFetch = vi.fn(async () => catalog([]));
    const result = await probeProvider(
      provider("perplexity", { apiKeyRef: "PERPLEXITY_API_KEY" }),
      {
        env: { PERPLEXITY_API_KEY: "pplx-abcdefghij" },
        fetch: doFetch,
      },
    );
    expect(result.verdict).toBe("untestable");
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("checks the key before deciding a provider is untestable", async () => {
    // Both are true; `no_key` is the more actionable one, and it is the only
    // one of the two that a user can do something about.
    const result = await probeProvider(
      provider("perplexity", { apiKeyRef: "PERPLEXITY_API_KEY" }),
      {
        env: {},
        fetch: vi.fn(async () => catalog([])),
      },
    );
    expect(result.verdict).toBe("no_key");
  });

  it("keeps the key out of a message that quoted it back", async () => {
    const key = "sk-live-abcdefghij";
    const result = await probeProvider(provider("openai"), {
      env: { OPENAI_API_KEY: key },
      fetch: vi.fn(async () => {
        throw new Error(`request to https://api.openai.com/v1/models?key=${key} failed`);
      }),
    });
    expect(result.verdict).toBe("unreachable");
    expect(result.message).not.toContain(key);
    expect(result.message).toContain("«redacted»");
  });

  it("keeps a percent-encoded key out too", async () => {
    // Google's catalog URL runs the key through `encodeURIComponent`, so the
    // raw substring never appears in the error a failed fetch prints.
    const key = "AIza+needs/encoding=";
    const result = await probeProvider(
      provider("google", { kind: "google", apiKeyRef: "GEMINI_API_KEY" }),
      {
        env: { GEMINI_API_KEY: key },
        fetch: vi.fn(async () => {
          throw new Error(`connect failed: /models?key=${encodeURIComponent(key)}`);
        }),
      },
    );
    expect(result.message).not.toContain(encodeURIComponent(key));
    expect(result.message).not.toContain(key);
  });

  it("probes the provider's own base URL, not the vendor default", async () => {
    // A wrong base URL is one of the two things this button exists to catch, so
    // testing the default instead of the configured one would hide it.
    const seen: string[] = [];
    await probeProvider(
      provider("9router", { apiKeyRef: null, baseUrl: "http://127.0.0.1:20128/v1" }),
      {
        env: {},
        fetch: vi.fn(async (url: unknown) => {
          seen.push(String(url));
          return catalog(["glm-5.3"]);
        }),
      },
    );
    expect(seen[0]).toBe("http://127.0.0.1:20128/v1/models");
  });
});
