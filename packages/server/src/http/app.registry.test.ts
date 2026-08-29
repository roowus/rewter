/**
 * The registry editor's routes.
 *
 * `applyModelPatch` is tested exhaustively in `shared`, so these are not about
 * the promotion arithmetic. They are about what only the route can get wrong:
 * the writes actually reaching SQLite, the foreign keys that would otherwise
 * surface as a 500 from inside the driver, and — the one that matters most —
 * an edited price being what the *router* sees on the next request, not just
 * what the editor sees on the next render.
 */
import { type CapabilityCard, CapabilityCardSchema, type Model, ModelSchema } from "@rewter/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { Router } from "../router/router.js";
import { FakeAdapter } from "../testing/fake-adapter.js";
import { PRV_A, PRV_B, model, provider } from "../testing/registry.js";
import { buildApp } from "./app.js";

const SONNET = "anthropic/claude-sonnet-5";
const NOW = 1_756_252_800_000;
const LATER = NOW + 60_000;

let db: Db;
let repos: Repos;
let app: FastifyInstance;
/** Advanced by hand so `updatedAt` changes are visible, not coincidental. */
let now = NOW;

beforeEach(() => {
  now = NOW;
  db = openDb(":memory:");
  const bus = new EventBus(db, () => NOW);
  repos = new Repos(db, bus, () => now);
  repos.upsertProvider(provider());
  repos.upsertModel(model(SONNET, PRV_A, { source: "synced" }));
  app = buildApp({
    router: new Router({ repos, createAdapter: () => new FakeAdapter([]) }),
    repos,
    bus,
    clock: () => now,
    sse: { heartbeatMs: 0 },
  });
});

afterEach(async () => {
  await app?.close();
});

const patch = (id: string, body: object) =>
  app.inject({ method: "PATCH", url: `/internal/models/${id}`, payload: body });

const stored = (id: string): Model => {
  const found = repos.getModel(id);
  if (found === undefined) throw new Error(`no model ${id}`);
  return found;
};

describe("GET /internal/models", () => {
  it("returns cards alongside models so the editor renders in one round-trip", async () => {
    repos.upsertCard({
      modelId: SONNET as never,
      summary: "strong generalist",
      strengths: ["coding"],
      weaknesses: [],
      bestAt: ["planning"],
      notes: null,
      userOverrides: null,
      generatedBy: null,
      generatedAt: null,
      updatedAt: NOW,
    });
    const body = (await app.inject({ method: "GET", url: "/internal/models" })).json<{
      models: unknown[];
      cards: unknown[];
    }>();
    expect(body.models.map((m) => ModelSchema.parse(m).id)).toContain(SONNET);
    expect(CapabilityCardSchema.parse(body.cards[0]).bestAt).toEqual(["planning"]);
  });

  it("lists a model with no card without inventing one", async () => {
    const body = (await app.inject({ method: "GET", url: "/internal/models" })).json<{
      cards: unknown[];
    }>();
    expect(body.cards).toEqual([]);
  });
});

describe("PATCH /internal/models/:id", () => {
  it("persists a price correction and promotes the row off the sync path", async () => {
    now = LATER;
    const res = await patch(SONNET, {
      pricing: {
        inputPerMTok: 2.5,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ changed: boolean }>().changed).toBe(true);

    const after = stored(SONNET);
    expect(after.pricing.inputPerMTok).toBe(2.5);
    // Without this the correction survives exactly until the next sync-models.
    expect(after.source).toBe("manual");
    expect(after.updatedAt).toBe(LATER);
  });

  it("does not write, or move updatedAt, when nothing changed", async () => {
    // A form that POSTs every field on every save hits this on every Save that
    // followed a glance rather than an edit.
    now = LATER;
    const existing = stored(SONNET);
    const res = await patch(SONNET, { displayName: existing.displayName, enabled: true });
    expect(res.json<{ changed: boolean }>().changed).toBe(false);
    expect(stored(SONNET).updatedAt).toBe(NOW);
    expect(stored(SONNET).source).toBe("synced");
  });

  it("lets the router see the edit on the very next request", async () => {
    // The point of the whole feature. If `Router` held a snapshot of the
    // registry, an edited price would be right on screen and wrong on the bill.
    await patch(SONNET, { enabled: false });
    const res = await app.inject({ method: "GET", url: "/v1/models" });
    expect(res.json<{ data: Array<{ id: string }> }>().data.map((m) => m.id)).not.toContain(SONNET);
  });

  it("rejects a misspelled field instead of returning 200 and changing nothing", async () => {
    // The failure mode that looks like success: the user believes the price is
    // fixed and it is not.
    const res = await patch(SONNET, { pricing_input: 2 });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain("pricing_input");
  });

  it("refuses to let a caller set source directly", async () => {
    // Promotion is earned by editing a fact; claiming it in the body would let
    // a client take a row off the sync path without changing anything.
    expect((await patch(SONNET, { source: "manual" })).statusCode).toBe(400);
  });

  it("404s an unknown model rather than creating one", async () => {
    expect((await patch("anthropic/ghost", { enabled: false })).statusCode).toBe(404);
  });
});

describe("POST /internal/models", () => {
  const body = {
    id: "ollama/qwen3-coder",
    providerId: PRV_B,
    upstreamId: "qwen3-coder",
    displayName: "Qwen3 Coder",
  };

  beforeEach(() => {
    repos.upsertProvider(provider(PRV_B, { name: "Ollama" }));
  });

  it("creates a hand-typed model as manual, unpriced, and routable", async () => {
    const res = await app.inject({ method: "POST", url: "/internal/models", payload: body });
    expect(res.statusCode).toBe(201);
    const created = stored(body.id);
    expect(created.source).toBe("manual");
    expect(created.pricing.inputPerMTok).toBeNull();
    expect(created.createdAt).toBe(NOW);

    const listed = (await app.inject({ method: "GET", url: "/v1/models" })).json<{
      data: Array<{ id: string }>;
    }>();
    expect(listed.data.map((m) => m.id)).toContain(body.id);
  });

  it("409s a duplicate rather than overwriting", async () => {
    // An upsert here would be a way to edit a synced row without the promotion
    // rule ever running.
    const res = await app.inject({
      method: "POST",
      url: "/internal/models",
      payload: { ...body, id: SONNET, providerId: PRV_A },
    });
    expect(res.statusCode).toBe(409);
    expect(stored(SONNET).source).toBe("synced");
  });

  it("400s an unknown provider instead of 500ing on the foreign key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/models",
      payload: { ...body, providerId: "prv_cccccccccccc" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain("provider");
  });

  it("400s a model id that is not a slug", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/models",
      payload: { ...body, id: "has spaces" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /internal/models/:id", () => {
  it("removes the model and its card together", async () => {
    // The card holds a foreign key onto the model; leaving it would fail the
    // delete from inside SQLite.
    repos.upsertCard({
      modelId: SONNET as never,
      summary: "s",
      strengths: [],
      weaknesses: [],
      bestAt: [],
      notes: null,
      userOverrides: null,
      generatedBy: null,
      generatedAt: null,
      updatedAt: NOW,
    });
    expect(
      (await app.inject({ method: "DELETE", url: `/internal/models/${SONNET}` })).statusCode,
    ).toBe(200);
    expect(repos.getModel(SONNET)).toBeUndefined();
    expect(repos.getCard(SONNET)).toBeUndefined();
  });

  it("leaves cost history naming the deleted model", async () => {
    // Deliberate: a spend report that loses rows when a model is retired is
    // worse than one naming something you can no longer route to.
    repos.recordCost({
      id: "cst_aaaaaaaaaaaa" as never,
      taskId: null as never,
      workerRunId: null as never,
      modelId: SONNET as never,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.02,
      pricingSnapshot: {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
      },
      createdAt: NOW,
    });
    await app.inject({ method: "DELETE", url: `/internal/models/${SONNET}` });
    const costs = (await app.inject({ method: "GET", url: "/internal/costs" })).json<{
      totals: { costUsd: number };
    }>();
    expect(costs.totals.costUsd).toBeCloseTo(0.02);
  });

  it("404s an unknown model", async () => {
    expect(
      (await app.inject({ method: "DELETE", url: "/internal/models/anthropic/ghost" })).statusCode,
    ).toBe(404);
  });
});

describe("PUT /internal/models/:id/card-overrides", () => {
  const putOverrides = (body: object) =>
    app.inject({
      method: "PUT",
      url: `/internal/card-overrides/${SONNET}`,
      payload: body,
    });

  beforeEach(() => {
    repos.upsertCard({
      modelId: SONNET as never,
      summary: "generated summary",
      strengths: ["coding"],
      weaknesses: ["ocr"],
      bestAt: ["coding"],
      notes: null,
      userOverrides: null,
      generatedBy: null,
      generatedAt: NOW,
      updatedAt: NOW,
    });
  });

  it("returns the merged card, with the override on top", async () => {
    const res = await putOverrides({ overrides: { bestAt: ["planning", "reasoning"] } });
    expect(res.statusCode).toBe(200);
    const card = CapabilityCardSchema.parse(res.json<{ card: unknown }>().card);
    expect(card.bestAt).toEqual(["planning", "reasoning"]);
    // The un-overridden half still comes from the generated card.
    expect(card.summary).toBe("generated summary");
  });

  it("survives the card being regenerated", async () => {
    // The reason overrides exist at all: `rewter card <model>` re-running must
    // not discard a correction someone made by hand.
    await putOverrides({ overrides: { summary: "actually mediocre at OCR" } });
    repos.upsertCard({
      ...(repos.getRawCard(SONNET) as CapabilityCard),
      summary: "freshly generated summary",
      updatedAt: LATER,
    });
    expect(repos.getCard(SONNET)?.summary).toBe("actually mediocre at OCR");
  });

  it("clears the patch with null, restoring the generated card", async () => {
    await putOverrides({ overrides: { summary: "hand written" } });
    await putOverrides({ overrides: null });
    expect(repos.getCard(SONNET)?.summary).toBe("generated summary");
  });

  it("rejects a tag outside the fixed vocabulary", async () => {
    // The vocabulary doubles as the phase-2 stats key; a freehand tag joins to
    // nothing and would quietly stop counting.
    expect((await putOverrides({ overrides: { bestAt: ["vibes"] } })).statusCode).toBe(400);
  });

  it("refuses to rewrite provenance out loud", async () => {
    // mergeCardOverrides drops these silently, which is right inside the DB and
    // wrong at the boundary.
    expect((await putOverrides({ overrides: { generatedBy: "anthropic/other" } })).statusCode).toBe(
      400,
    );
  });

  it("404s when there is no generated card to patch", async () => {
    repos.upsertModel(model("anthropic/uncarded", PRV_A));
    const res = await app.inject({
      method: "PUT",
      url: "/internal/card-overrides/anthropic/uncarded",
      payload: { overrides: { summary: "x" } },
    });
    expect(res.statusCode).toBe(404);
  });
});
