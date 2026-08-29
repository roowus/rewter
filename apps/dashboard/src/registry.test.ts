/**
 * The registry fetch client.
 *
 * The promotion arithmetic is tested in `shared` and the routing in
 * `app.registry.test.ts`. What is only testable here is what this does with a
 * daemon that says no — because a rejected edit whose reason never reaches the
 * screen is the exact failure the whole editor exists to prevent: the user
 * believes the price is fixed and it is not.
 */
import { describe, expect, it, vi } from "vitest";
import { deleteModel, fetchRegistry, patchModel } from "./registry.js";

const MODEL = {
  id: "anthropic/claude-sonnet-5",
  providerId: "prv_aaaaaaaaaaaa",
  upstreamId: "claude-sonnet-5",
  displayName: "Claude Sonnet 5",
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  pricing: {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  modalities: ["text"],
  supports: { tools: true, streaming: true, vision: false, caching: true },
  source: "synced",
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

const respond = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

describe("fetchRegistry", () => {
  it("returns models and cards from the one round-trip", async () => {
    const result = await fetchRegistry(respond({ models: [MODEL], cards: [] }));
    expect(result.ok && result.value.models[0]?.id).toBe(MODEL.id);
  });

  it("refuses a shape it does not recognize rather than rendering blanks", async () => {
    // A daemon newer than this bundle. Half-understanding a price is worse
    // than admitting we cannot read the answer.
    const result = await fetchRegistry(respond({ models: [{ id: "x" }], cards: [] }));
    expect(result).toEqual({ ok: false, message: "unrecognized response from daemon" });
  });
});

describe("patchModel", () => {
  it("sends only what it was given, as PATCH", async () => {
    const spy = vi.fn(respond({ model: MODEL, changed: true }));
    await patchModel(MODEL.id, { enabled: false }, spy as typeof fetch);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    // Not escaped: model ids contain slashes and the route is a wildcard, so a
    // %2F would arrive as a literal and match no model.
    expect(url).toBe("/internal/models/anthropic/claude-sonnet-5");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
  });

  it("reports changed:false rather than treating it as success", async () => {
    // The daemon compares by value. "Saved" and "nothing was different" are
    // different facts and the second one means the form was stale.
    const result = await patchModel(MODEL.id, {}, respond({ model: MODEL, changed: false }));
    expect(result.ok && result.value.changed).toBe(false);
  });

  it("surfaces the daemon's own complaint, not the status code", async () => {
    // "pricing.inputPerMTok: must be >= 0" tells the user what to fix.
    // "daemon said 400" does not.
    const result = await patchModel(
      MODEL.id,
      { pricing_input: 2 },
      respond({ error: { message: "body: Unrecognized key(s): 'pricing_input'" } }, 400),
    );
    expect(result).toEqual({
      ok: false,
      message: "body: Unrecognized key(s): 'pricing_input'",
    });
  });

  it("falls back to the status when the error body is not the shape we expect", async () => {
    const result = await patchModel(MODEL.id, {}, respond({ nope: true }, 500));
    expect(result).toEqual({ ok: false, message: "daemon said 500" });
  });

  it("says the daemon is unreachable rather than throwing into a click handler", async () => {
    const boom = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await patchModel(MODEL.id, {}, boom)).toEqual({
      ok: false,
      message: "daemon unreachable",
    });
  });
});

describe("deleteModel", () => {
  it("uses DELETE and reports the id the daemon says it removed", async () => {
    const spy = vi.fn(respond({ deleted: MODEL.id }));
    const result = await deleteModel(MODEL.id, spy as typeof fetch);
    expect((spy.mock.calls[0]?.[1] as RequestInit).method).toBe("DELETE");
    expect(result.ok && result.value).toBe(MODEL.id);
  });
});
