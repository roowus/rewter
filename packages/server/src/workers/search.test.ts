/**
 * The `web_search` backends, off the network.
 *
 * Two things matter here. The factory's answer decides whether a worker is told
 * `web_search` exists at all, so every branch of it — no provider, a provider
 * with no key, a searxng with no URL — is pinned, with the warning text the
 * operator will read. And each backend's wire shape is what makes a real call
 * succeed, so the request each one sends (method, headers, query string, body)
 * is asserted against a stub `fetch`, along with the field mapping back to the
 * one normalized result shape.
 */
import { describe, expect, it } from "vitest";
import { SearchConfigSchema } from "../config/config.js";
import { type SearchBackend, createSearchBackend } from "./search.js";

/** A config block the way `loadConfig` would hand it over: defaults filled in. */
function config(over: Record<string, unknown> = {}) {
  return SearchConfigSchema.parse(over);
}

function backendOf(over: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): SearchBackend {
  const r = createSearchBackend(config(over), env);
  if (r.backend === null) throw new Error(`no backend: ${r.warning}`);
  return r.backend;
}

interface Captured {
  url: URL;
  init: RequestInit | undefined;
}

/** A `fetch` that records the one request it gets and answers with `body`. */
function stubFetch(body: unknown, status = 200): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(input instanceof Request ? input.url : String(input)), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      statusText: status === 200 ? "OK" : "Error",
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const query = (q = "rewter router") => ({
  query: q,
  maxResults: 5,
  signal: new AbortController().signal,
});

describe("createSearchBackend", () => {
  it("returns no backend and no warning when no provider is configured", () => {
    // The ordinary daemon. Silence is right: nothing was asked for.
    expect(createSearchBackend(config(), {})).toEqual({ backend: null, warning: null });
  });

  it("refuses searxng without an instance URL, and says which key is missing", () => {
    const r = createSearchBackend(config({ provider: "searxng" }), {});
    expect(r.backend).toBeNull();
    expect(r.warning).toContain("search.baseUrl");
  });

  it("builds searxng from a base URL alone — it needs no key", () => {
    const r = createSearchBackend(
      config({ provider: "searxng", baseUrl: "https://searx.example" }),
      {},
    );
    expect(r.warning).toBeNull();
    expect(r.backend?.id).toBe("searxng");
  });

  it.each([
    ["brave", "BRAVE_SEARCH_API_KEY"],
    ["tavily", "TAVILY_API_KEY"],
  ])("disables %s with a warning naming %s when the key is unset", (provider, envName) => {
    // A warning, not a throw: a missing key must never stop the daemon booting.
    const r = createSearchBackend(config({ provider }), {});
    expect(r.backend).toBeNull();
    expect(r.warning).toContain("web_search disabled");
    expect(r.warning).toContain(envName);
  });

  it("treats an empty key the same as an unset one", () => {
    const r = createSearchBackend(config({ provider: "brave" }), { BRAVE_SEARCH_API_KEY: "" });
    expect(r.backend).toBeNull();
  });

  it("reads the key from apiKeyEnv when the operator names a different variable", () => {
    const r = createSearchBackend(config({ provider: "tavily", apiKeyEnv: "MY_TAVILY" }), {
      MY_TAVILY: "k",
    });
    expect(r.warning).toBeNull();
    expect(r.backend?.id).toBe("tavily");
  });

  it("never puts the key itself in the warning", () => {
    const r = createSearchBackend(config({ provider: "brave", apiKeyEnv: "SOME_VAR" }), {});
    expect(r.warning).toContain("SOME_VAR");
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});

describe("searxng backend", () => {
  it("GETs /search with q and format=json on the instance root", async () => {
    const stub = stubFetch({
      results: [
        { title: "A", url: "https://a.example/", content: "first" },
        { title: "B", url: "https://b.example/", content: "second" },
      ],
    });
    const results = await backendOf({
      provider: "searxng",
      baseUrl: "https://searx.example",
    }).search(query(), stub.fetch);
    const call = stub.calls[0];
    expect(call?.url.origin).toBe("https://searx.example");
    expect(call?.url.pathname).toBe("/search");
    expect(call?.url.searchParams.get("q")).toBe("rewter router");
    expect(call?.url.searchParams.get("format")).toBe("json");
    expect(call?.init?.method ?? "GET").toBe("GET");
    expect(results).toEqual([
      { title: "A", url: "https://a.example/", snippet: "first" },
      { title: "B", url: "https://b.example/", snippet: "second" },
    ]);
  });

  it("leaves a base URL that already ends in /search alone", async () => {
    // For an operator who reverse-proxies the JSON endpoint at its own path.
    const stub = stubFetch({ results: [] });
    await backendOf({ provider: "searxng", baseUrl: "https://proxy.example/sx/search" }).search(
      query(),
      stub.fetch,
    );
    expect(stub.calls[0]?.url.pathname).toBe("/sx/search");
  });

  it("drops rows without an http(s) URL — a result the worker cannot fetch is not a result", async () => {
    const stub = stubFetch({
      results: [
        { title: "ftp", url: "ftp://files.example/x", content: "" },
        { title: "no url", content: "orphan" },
        { title: "ok", url: "http://ok.example/", content: "kept" },
        { title: "js", url: "javascript:alert(1)", content: "" },
      ],
    });
    const results = await backendOf({
      provider: "searxng",
      baseUrl: "https://searx.example",
    }).search(query(), stub.fetch);
    expect(results.map((r) => r.title)).toEqual(["ok"]);
  });

  it("caps the mapped rows at maxResults even when the instance returns more", async () => {
    const stub = stubFetch({
      results: Array.from({ length: 30 }, (_, i) => ({
        title: `r${i}`,
        url: `https://r${i}.example/`,
        content: "",
      })),
    });
    const results = await backendOf({
      provider: "searxng",
      baseUrl: "https://searx.example",
    }).search({ ...query(), maxResults: 3 }, stub.fetch);
    expect(results).toHaveLength(3);
  });

  it("returns nothing, not a throw, when the body has no results array", async () => {
    const stub = stubFetch({ unexpected: true });
    const results = await backendOf({
      provider: "searxng",
      baseUrl: "https://searx.example",
    }).search(query(), stub.fetch);
    expect(results).toEqual([]);
  });

  it("throws with the HTTP status on a non-2xx answer", async () => {
    const stub = stubFetch("rate limited", 429);
    await expect(
      backendOf({ provider: "searxng", baseUrl: "https://searx.example" }).search(
        query(),
        stub.fetch,
      ),
    ).rejects.toThrow(/searxng returned HTTP 429/);
  });

  it("throws a readable error when the body is not JSON", async () => {
    // A searxng with `format=json` disabled answers with an HTML page and 200.
    const stub = stubFetch("<html>not json</html>");
    await expect(
      backendOf({ provider: "searxng", baseUrl: "https://searx.example" }).search(
        query(),
        stub.fetch,
      ),
    ).rejects.toThrow(/not JSON/);
  });

  it("refuses a non-http(s) base URL rather than fetching it", async () => {
    // The config schema only checks `url()`, so `file:` gets this far.
    const stub = stubFetch({ results: [] });
    await expect(
      backendOf({ provider: "searxng", baseUrl: "file:///etc/searx" }).search(query(), stub.fetch),
    ).rejects.toThrow(/http\(s\)/);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("brave backend", () => {
  const env = { BRAVE_SEARCH_API_KEY: "brave-key" };

  it("GETs the web search endpoint with the key in X-Subscription-Token", async () => {
    const stub = stubFetch({
      web: {
        results: [{ title: "Brave hit", url: "https://hit.example/", description: "desc" }],
      },
    });
    const results = await backendOf({ provider: "brave" }, env).search(query(), stub.fetch);
    const call = stub.calls[0];
    expect(call?.url.origin).toBe("https://api.search.brave.com");
    expect(call?.url.pathname).toBe("/res/v1/web/search");
    expect(call?.url.searchParams.get("q")).toBe("rewter router");
    expect(call?.url.searchParams.get("count")).toBe("5");
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers["X-Subscription-Token"]).toBe("brave-key");
    expect(headers.Accept).toBe("application/json");
    expect(call?.init?.method ?? "GET").toBe("GET");
    expect(results).toEqual([{ title: "Brave hit", url: "https://hit.example/", snippet: "desc" }]);
  });

  it("reads results from body.web.results and tolerates their absence", async () => {
    const stub = stubFetch({ query: { original: "x" } });
    expect(await backendOf({ provider: "brave" }, env).search(query(), stub.fetch)).toEqual([]);
  });

  it("honours a baseUrl override", async () => {
    const stub = stubFetch({ web: { results: [] } });
    await backendOf({ provider: "brave", baseUrl: "https://mirror.example/brave" }, env).search(
      query(),
      stub.fetch,
    );
    expect(stub.calls[0]?.url.origin).toBe("https://mirror.example");
  });

  it("names the vendor in an HTTP error", async () => {
    const stub = stubFetch({ message: "bad key" }, 401);
    await expect(backendOf({ provider: "brave" }, env).search(query(), stub.fetch)).rejects.toThrow(
      /Brave Search returned HTTP 401/,
    );
  });
});

describe("tavily backend", () => {
  const env = { TAVILY_API_KEY: "tavily-key" };

  it("POSTs JSON with the query and max_results, bearer-authenticated", async () => {
    const stub = stubFetch({
      results: [{ title: "T", url: "https://t.example/", content: "tavily says" }],
    });
    const results = await backendOf({ provider: "tavily" }, env).search(query(), stub.fetch);
    const call = stub.calls[0];
    expect(call?.url.href).toBe("https://api.tavily.com/search");
    expect(call?.init?.method).toBe("POST");
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tavily-key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      query: "rewter router",
      max_results: 5,
    });
    expect(results).toEqual([{ title: "T", url: "https://t.example/", snippet: "tavily says" }]);
  });

  it("passes the abort signal through so a cancelled worker cancels its search", async () => {
    const stub = stubFetch({ results: [] });
    const controller = new AbortController();
    await backendOf({ provider: "tavily" }, env).search(
      { ...query(), signal: controller.signal },
      stub.fetch,
    );
    expect(stub.calls[0]?.init?.signal).toBe(controller.signal);
  });

  it("names the vendor in an HTTP error", async () => {
    const stub = stubFetch({ detail: "quota" }, 432);
    await expect(
      backendOf({ provider: "tavily" }, env).search(query(), stub.fetch),
    ).rejects.toThrow(/Tavily returned HTTP 432/);
  });
});
