/**
 * Catalog parsing. These run against hand-trimmed captures of what the four
 * upstream shapes actually return — the point is not that zod runs, but that a
 * price string of `"-1"`, a `models/` prefix, or an embedding-only row lands
 * the way it should.
 */
import { describe, expect, it } from "vitest";
import { CatalogError, catalogUrl, enrichFromOpenRouter, fetchCatalog } from "./catalog.js";

function jsonFetch(body: unknown, status = 200): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

/** Records the URL and headers so auth-shape assertions are possible. */
function spyFetch(body: unknown) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { seen, fetch };
}

const OPENROUTER_BODY = {
  data: [
    {
      id: "anthropic/claude-sonnet-5",
      name: "Anthropic: Claude Sonnet 5",
      context_length: 200_000,
      pricing: {
        prompt: "0.000003",
        completion: "0.000015",
        input_cache_read: "0.0000003",
        input_cache_write: "0.00000375",
      },
      architecture: { input_modalities: ["text", "image"] },
      top_provider: { max_completion_tokens: 64_000 },
      supported_parameters: ["tools", "temperature"],
    },
    {
      id: "meta-llama/llama-3-8b:free",
      context_length: 8192,
      pricing: { prompt: "0", completion: "0" },
      architecture: { modality: "text->text" },
      supported_parameters: [],
    },
  ],
};

describe("fetchCatalog — OpenRouter", () => {
  it("converts per-token prices to per-MTok", async () => {
    const out = await fetchCatalog(
      { slug: "openrouter", kind: "openai-compat" },
      { apiKey: "k", fetch: jsonFetch(OPENROUTER_BODY) },
    );
    const sonnet = out.entries[0];
    expect(sonnet?.pricing.inputPerMTok).toBe(3);
    expect(sonnet?.pricing.outputPerMTok).toBe(15);
    expect(sonnet?.pricing.cacheReadPerMTok).toBe(0.3);
    expect(sonnet?.pricing.cacheWritePerMTok).toBe(3.75);
  });

  it("keeps a genuinely free model at 0 rather than calling it unknown", async () => {
    const out = await fetchCatalog(
      { slug: "openrouter", kind: "openai-compat" },
      { apiKey: "k", fetch: jsonFetch(OPENROUTER_BODY) },
    );
    expect(out.entries[1]?.pricing.inputPerMTok).toBe(0);
  });

  it("treats a sentinel '-1' price as unknown, not as negative money", async () => {
    const out = await fetchCatalog(
      { slug: "openrouter", kind: "openai-compat" },
      {
        apiKey: "k",
        fetch: jsonFetch({
          data: [{ id: "x/varies", pricing: { prompt: "-1", completion: "-1" } }],
        }),
      },
    );
    expect(out.entries[0]?.pricing.inputPerMTok).toBeNull();
  });

  it("reads modalities from either the array or the arrow string", async () => {
    const out = await fetchCatalog(
      { slug: "openrouter", kind: "openai-compat" },
      { apiKey: "k", fetch: jsonFetch(OPENROUTER_BODY) },
    );
    expect(out.entries[0]?.modalities).toEqual(["text", "image"]);
    expect(out.entries[0]?.supports.vision).toBe(true);
    expect(out.entries[1]?.modalities).toEqual(["text"]);
  });

  it("infers caching from a cache price rather than assuming it", async () => {
    const out = await fetchCatalog(
      { slug: "openrouter", kind: "openai-compat" },
      { apiKey: "k", fetch: jsonFetch(OPENROUTER_BODY) },
    );
    expect(out.entries[0]?.supports.caching).toBe(true);
    expect(out.entries[1]?.supports.caching).toBe(false);
  });

  it("distinguishes a model that lists no tool support from one that lists nothing", async () => {
    const out = await fetchCatalog(
      { slug: "openrouter", kind: "openai-compat" },
      {
        apiKey: "k",
        fetch: jsonFetch({
          data: [{ id: "a/reports-none", supported_parameters: [] }, { id: "b/reports-nothing" }],
        }),
      },
    );
    // An empty array is an answer; an absent field is silence. Collapsing the
    // second into `false` would let enrichment's "fill unknowns only" rule read
    // it as a denial and decline to correct it from OpenRouter's own listing.
    expect(out.entries[0]?.supports.tools).toBe(false);
    expect(out.entries[1]?.supports.tools).toBeNull();
  });
});

describe("fetchCatalog — Google", () => {
  const BODY = {
    models: [
      {
        name: "models/gemini-2.5-pro",
        displayName: "Gemini 2.5 Pro",
        inputTokenLimit: 1_048_576,
        outputTokenLimit: 65_536,
        supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
      },
      {
        name: "models/text-embedding-004",
        supportedGenerationMethods: ["embedContent"],
      },
    ],
  };

  it("strips the models/ prefix from the upstream id", async () => {
    const out = await fetchCatalog(
      { slug: "google", kind: "google" },
      { apiKey: "k", fetch: jsonFetch(BODY) },
    );
    expect(out.entries[0]?.upstreamId).toBe("gemini-2.5-pro");
  });

  it("drops embedding-only endpoints, which are not chat models", async () => {
    const out = await fetchCatalog(
      { slug: "google", kind: "google" },
      { apiKey: "k", fetch: jsonFetch(BODY) },
    );
    expect(out.entries.map((e) => e.upstreamId)).toEqual(["gemini-2.5-pro"]);
  });

  it("reports limits but leaves price unknown rather than zero", async () => {
    const out = await fetchCatalog(
      { slug: "google", kind: "google" },
      { apiKey: "k", fetch: jsonFetch(BODY) },
    );
    expect(out.entries[0]?.contextWindow).toBe(1_048_576);
    expect(out.entries[0]?.pricing.inputPerMTok).toBeNull();
  });

  it("authenticates by query parameter, not header", () => {
    const url = catalogUrl({ slug: "google", kind: "google" }, { apiKey: "se cret" });
    expect(url).toContain("?key=se%20cret");
  });
});

describe("fetchCatalog — Anthropic and plain OpenAI", () => {
  it("sends anthropic's key header and version", async () => {
    const spy = spyFetch({ data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }] });
    await fetchCatalog(
      { slug: "anthropic", kind: "anthropic" },
      { apiKey: "sk-test", fetch: spy.fetch },
    );
    expect(spy.seen[0]?.headers["x-api-key"]).toBe("sk-test");
    expect(spy.seen[0]?.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("sends a bearer token for openai-compat", async () => {
    const spy = spyFetch({ data: [{ id: "gpt-5" }] });
    await fetchCatalog(
      { slug: "openai", kind: "openai-compat" },
      { apiKey: "sk-test", baseUrl: "https://api.openai.com/v1", fetch: spy.fetch },
    );
    expect(spy.seen[0]?.headers.authorization).toBe("Bearer sk-test");
    expect(spy.seen[0]?.url).toBe("https://api.openai.com/v1/models");
  });

  it("returns an id list with everything else honestly unknown", async () => {
    const out = await fetchCatalog(
      { slug: "openai", kind: "openai-compat" },
      { apiKey: "k", fetch: jsonFetch({ data: [{ id: "gpt-5" }] }) },
    );
    expect(out.entries[0]).toMatchObject({
      upstreamId: "gpt-5",
      contextWindow: null,
      maxOutputTokens: null,
    });
    // Capabilities included. This parser serves a dozen unrelated vendors from
    // a response carrying one field, so a boolean here is a guess about
    // whichever of them is on the other end — and it is a guess that costs
    // either way: `tools: true` gets a tool-less local model spawned for
    // tier-2 work, `vision: false` takes the only model that can read a scan
    // out of the running for the subtask that needs it.
    expect(out.entries[0]?.supports).toEqual({
      tools: null,
      streaming: true,
      vision: null,
      caching: null,
    });
  });

  it("keeps Anthropic's line-wide capabilities, which are a fact and not a guess", async () => {
    const out = await fetchCatalog(
      { slug: "anthropic", kind: "anthropic" },
      { apiKey: "k", fetch: jsonFetch({ data: [{ id: "claude-sonnet-5" }] }) },
    );
    // Unreported too, but the difference from the case above is the scope of
    // the claim: this endpoint only ever answers for Claude, and every model in
    // the line does tools, vision and caching.
    expect(out.entries[0]?.supports).toEqual({
      tools: true,
      streaming: true,
      vision: true,
      caching: true,
    });
  });
});

describe("fetchCatalog — failure modes", () => {
  it("raises with the status when the catalog request fails", async () => {
    await expect(
      fetchCatalog(
        { slug: "openai", kind: "openai-compat" },
        { apiKey: "k", fetch: jsonFetch({ error: "nope" }, 429) },
      ),
    ).rejects.toMatchObject({ name: "CatalogError", statusCode: 429 });
  });

  it("raises when the body is not the shape the endpoint promises", async () => {
    await expect(
      fetchCatalog(
        { slug: "openai", kind: "openai-compat" },
        { apiKey: "k", fetch: jsonFetch({ models: [] }) },
      ),
    ).rejects.toBeInstanceOf(CatalogError);
  });

  it("loses one malformed row, not the rest of the catalog", async () => {
    const out = await fetchCatalog(
      { slug: "openai", kind: "openai-compat" },
      {
        apiKey: "k",
        fetch: jsonFetch({ data: [{ id: "gpt-5" }, { name: "no id here" }, { id: "gpt-4o" }] }),
      },
    );
    expect(out.entries.map((e) => e.upstreamId)).toEqual(["gpt-5", "gpt-4o"]);
    expect(out.skipped).toBe(1);
  });
});

describe("enrichFromOpenRouter", () => {
  const bare = {
    upstreamId: "claude-sonnet-5",
    displayName: "claude-sonnet-5",
    contextWindow: null,
    maxOutputTokens: null,
    pricing: {
      inputPerMTok: null,
      outputPerMTok: null,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    },
    modalities: ["text" as const],
    // What a bare `/models` list yields: streaming is the format, everything
    // else is unreported.
    supports: { tools: null, streaming: true, vision: null, caching: null },
  };

  const rich = {
    upstreamId: "anthropic/claude-sonnet-5",
    displayName: "Anthropic: Claude Sonnet 5",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    },
    modalities: ["text" as const, "image" as const],
    supports: { tools: true, streaming: true, vision: true, caching: true },
  };

  it("matches across namespaces on the id tail", () => {
    const [out] = enrichFromOpenRouter([bare], [rich]);
    expect(out?.pricing.inputPerMTok).toBe(3);
    expect(out?.contextWindow).toBe(200_000);
  });

  it("does not overwrite a price the upstream itself stated", () => {
    const stated = { ...bare, pricing: { ...bare.pricing, inputPerMTok: 2.5 } };
    const [out] = enrichFromOpenRouter([stated], [rich]);
    expect(out?.pricing.inputPerMTok).toBe(2.5);
    // …while still filling the ones it left null.
    expect(out?.pricing.outputPerMTok).toBe(15);
  });

  it("fills an unreported capability from OpenRouter's view of the model", () => {
    const [out] = enrichFromOpenRouter([bare], [rich]);
    expect(out?.supports.vision).toBe(true);
    expect(out?.modalities).toEqual(["text", "image"]);
  });

  it("does not overwrite a capability the upstream itself denied", () => {
    // Same rule as pricing: a report beats a third party's view of it. The old
    // `a || b` merge could not express this — it read every false as an
    // assumption to be overridden, because before tri-state, it was one.
    const denied = { ...bare, supports: { ...bare.supports, vision: false } };
    const [out] = enrichFromOpenRouter([denied], [rich]);
    expect(out?.supports.vision).toBe(false);
    // …while still filling the ones it left unknown.
    expect(out?.supports.caching).toBe(true);
  });

  it("leaves a model OpenRouter has never heard of alone", () => {
    const [out] = enrichFromOpenRouter([{ ...bare, upstreamId: "local-mystery" }], [rich]);
    expect(out?.pricing.inputPerMTok).toBeNull();
  });

  it("prefers the base model over a :free variant listed later", () => {
    const free = { ...rich, upstreamId: "anthropic/claude-sonnet-5:free" };
    free.pricing = { ...rich.pricing, inputPerMTok: 0 };
    const [out] = enrichFromOpenRouter([bare], [rich, free]);
    expect(out?.pricing.inputPerMTok).toBe(3);
  });
});
