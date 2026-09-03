/**
 * The `web_search` backend: one small interface, three implementations, and a
 * factory that turns the config block into an instance or a reason there is none.
 *
 * Why an interface at all, for something that is "call a search API": because the
 * tier-2 loop declares `web_search` to the model **only when a backend exists**.
 * A tool that is offered and then errors every time costs the worker a turn to
 * discover and invites a retry; a tool that is simply absent costs nothing. So
 * the loop needs a yes/no it can ask before the first turn, and "is there a
 * backend object" is that yes/no. (`docs/design/web-search.md` has the
 * reasoning in full.)
 *
 * The three backends are the free-first lean the issue asked for:
 *
 * - **searxng** — a self-hosted metasearch instance, keyless, `format=json`.
 *   The zero-bill option for anyone already running one.
 * - **brave** — the Brave Search API. Has a free tier; key in an env var.
 * - **tavily** — a search API built for LLM consumers; free tier; key in env.
 *
 * Every one of them is a JSON HTTP call, so they share the `fetchImpl` seam the
 * `web_fetch` tool already has and the tests stay off the network. What comes
 * back is normalized to `{title, url, snippet}`: the model does not need to know
 * which vendor answered, and the renderer in `execute.ts` only formats one shape.
 *
 * Keys are read from the environment by **name**, as everywhere else in rewter.
 * A configured provider whose key variable is unset is not an error at boot —
 * the factory reports a warning, the daemon logs it in the same breath as the
 * "provider disabled" lines, and `web_search` is simply not offered. Booting
 * without search is the right failure for a missing key; refusing to boot is not.
 */
import type { SearchConfig } from "../config/config.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchQuery {
  query: string;
  /** Already clamped by the caller to the config's `maxResults`. */
  maxResults: number;
  signal: AbortSignal;
}

export interface SearchBackend {
  /** Shown to the model in tool output and to the operator in logs: `brave`, … */
  readonly id: string;
  /**
   * Throws on transport or upstream failure; the tool turns the error into a
   * result string. Kept as a throw here so each backend stays a straight-line
   * "call, check, map" and error wording lives in one place.
   */
  search(q: SearchQuery, fetchImpl: typeof fetch): Promise<SearchResult[]>;
}

/** Default env var names, one per keyed provider. Overridable via `apiKeyEnv`. */
export const DEFAULT_SEARCH_KEY_ENV = {
  brave: "BRAVE_SEARCH_API_KEY",
  tavily: "TAVILY_API_KEY",
} as const;

const DEFAULT_BASE_URL = {
  brave: "https://api.search.brave.com/res/v1/web/search",
  tavily: "https://api.tavily.com/search",
} as const;

export type SearchBackendResolution =
  | { backend: SearchBackend; warning: null }
  | { backend: null; warning: string | null };

/**
 * Config → backend, or a reason there is none.
 *
 * `warning: null` with `backend: null` is the ordinary case — no provider
 * configured, nothing to say. A non-null warning is a misconfiguration the
 * operator will want to see once, at boot.
 */
export function createSearchBackend(
  config: SearchConfig,
  env: NodeJS.ProcessEnv,
): SearchBackendResolution {
  switch (config.provider) {
    case null:
      return { backend: null, warning: null };

    case "searxng": {
      if (config.baseUrl === null) {
        return {
          backend: null,
          warning: 'search.provider "searxng" needs search.baseUrl (the instance URL)',
        };
      }
      return { backend: searxng(config.baseUrl), warning: null };
    }

    case "brave":
    case "tavily": {
      const envName = config.apiKeyEnv ?? DEFAULT_SEARCH_KEY_ENV[config.provider];
      const key = env[envName];
      if (key === undefined || key === "") {
        return {
          backend: null,
          warning: `web_search disabled: search.provider "${config.provider}" needs ${envName} set`,
        };
      }
      const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL[config.provider];
      return {
        backend: config.provider === "brave" ? brave(baseUrl, key) : tavily(baseUrl, key),
        warning: null,
      };
    }
  }
}

/** Reject anything but http(s) — same rule as `web_fetch`, same reason. */
function httpUrl(raw: string, what: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${what} must be an http(s) URL, not ${url.protocol}`);
  }
  return url;
}

async function getJson(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
  what: string,
): Promise<unknown> {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    throw new Error(`${what} returned HTTP ${res.status} ${res.statusText}`.trimEnd());
  }
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`${what} returned a body that was not JSON: ${errorText(err)}`);
  }
}

/**
 * Pull `{title, url, snippet}` rows out of whatever a vendor returned.
 *
 * Vendors disagree on field names but not on shape — an array of objects with a
 * title, a link and a description — so each backend names its three fields and
 * this does the rest. Rows without a usable http(s) URL are dropped: a result
 * the worker cannot `web_fetch` is not a result.
 */
function pickResults(
  rows: unknown,
  fields: { title: string; url: string; snippet: string },
  max: number,
): SearchResult[] {
  if (!Array.isArray(rows)) return [];
  const out: SearchResult[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const url = typeof r[fields.url] === "string" ? (r[fields.url] as string).trim() : "";
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({
      title: str(r[fields.title]),
      url,
      snippet: str(r[fields.snippet]),
    });
    if (out.length >= max) break;
  }
  return out;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function searxng(baseUrl: string): SearchBackend {
  return {
    id: "searxng",
    async search(q, fetchImpl) {
      const url = httpUrl(baseUrl, "search.baseUrl");
      // Instance URLs are given as roots (`https://searx.example`); the JSON
      // endpoint is `/search` on them. A URL that already ends in `/search` is
      // left alone so an operator can point at a reverse-proxy path.
      if (!url.pathname.endsWith("/search")) {
        url.pathname = `${url.pathname.replace(/\/$/, "")}/search`;
      }
      url.searchParams.set("q", q.query);
      url.searchParams.set("format", "json");
      const body = await getJson(fetchImpl, url, { signal: q.signal }, "searxng");
      const rows = (body as { results?: unknown } | null)?.results;
      return pickResults(rows, { title: "title", url: "url", snippet: "content" }, q.maxResults);
    },
  };
}

function brave(baseUrl: string, key: string): SearchBackend {
  return {
    id: "brave",
    async search(q, fetchImpl) {
      const url = httpUrl(baseUrl, "search.baseUrl");
      url.searchParams.set("q", q.query);
      url.searchParams.set("count", String(q.maxResults));
      const body = await getJson(
        fetchImpl,
        url,
        {
          signal: q.signal,
          headers: { Accept: "application/json", "X-Subscription-Token": key },
        },
        "Brave Search",
      );
      const rows = (body as { web?: { results?: unknown } } | null)?.web?.results;
      return pickResults(
        rows,
        { title: "title", url: "url", snippet: "description" },
        q.maxResults,
      );
    },
  };
}

function tavily(baseUrl: string, key: string): SearchBackend {
  return {
    id: "tavily",
    async search(q, fetchImpl) {
      const url = httpUrl(baseUrl, "search.baseUrl");
      const body = await getJson(
        fetchImpl,
        url,
        {
          method: "POST",
          signal: q.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ query: q.query, max_results: q.maxResults }),
        },
        "Tavily",
      );
      const rows = (body as { results?: unknown } | null)?.results;
      return pickResults(rows, { title: "title", url: "url", snippet: "content" }, q.maxResults);
    },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
