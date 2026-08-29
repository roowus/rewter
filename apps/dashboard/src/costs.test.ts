/**
 * The costs fetch client.
 *
 * The aggregation is tested in `shared` and the routing in `app.costs.test.ts`;
 * what is only testable here is the query string this builds and what it does
 * with a response it should not trust — because the number this renders is the
 * one someone will quote as what their week cost.
 */
import { describe, expect, it, vi } from "vitest";
import { fetchCosts } from "./costs.js";

const SUMMARY = {
  groupBy: "model",
  timeZone: "UTC",
  since: null,
  until: null,
  totals: {
    costUsd: 1.5,
    initiatorCostUsd: 1,
    workerCostUsd: 0.5,
    calls: 3,
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  buckets: [],
};

const respond = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

describe("fetchCosts", () => {
  it("asks for the grouping and zone it was given", async () => {
    const spy = vi.fn(respond(SUMMARY));
    await fetchCosts({ groupBy: "day", timeZone: "America/Los_Angeles" }, spy as typeof fetch);
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain("groupBy=day");
    expect(url).toContain("tz=America%2FLos_Angeles");
  });

  it("omits since when there is no window rather than sending an empty one", async () => {
    const spy = vi.fn(respond(SUMMARY));
    await fetchCosts({ groupBy: "model" }, spy as typeof fetch);
    expect(String(spy.mock.calls[0]?.[0])).not.toContain("since=");
  });

  it("returns the parsed summary", async () => {
    const result = await fetchCosts({ groupBy: "model" }, respond(SUMMARY));
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.summary.totals.costUsd).toBe(1.5);
  });

  it("rejects a shape it only half-understands instead of rendering holes", async () => {
    // A daemon newer than this bundle. `undefined` formatted as a dash reads as
    // zero, which is the one wrong answer that looks like good news.
    const result = await fetchCosts({ groupBy: "model" }, respond({ totals: { costUsd: 5 } }));
    expect(result).toEqual({ ok: false, message: "unrecognized response from daemon" });
  });

  it("reports a non-JSON body rather than throwing inside an effect", async () => {
    const html = (async () => new Response("<html>nope</html>", { status: 200 })) as typeof fetch;
    expect(await fetchCosts({ groupBy: "model" }, html)).toMatchObject({ ok: false });
  });

  it("passes an error status through", async () => {
    expect(await fetchCosts({ groupBy: "model" }, respond({}, 400))).toEqual({
      ok: false,
      message: "daemon said 400",
    });
  });

  it("turns a dead daemon into an answer", async () => {
    const dead = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await fetchCosts({ groupBy: "model" }, dead)).toEqual({
      ok: false,
      message: "daemon unreachable",
    });
  });

  it("distinguishes an abort from a failure", async () => {
    // The panel refetches on every event; an in-flight request being replaced
    // is routine, and must not flash an error between two good renders.
    const aborting = (async () => {
      throw new DOMException("aborted", "AbortError");
    }) as typeof fetch;
    expect(await fetchCosts({ groupBy: "model" }, aborting)).toEqual({
      ok: false,
      message: "aborted",
    });
  });
});
