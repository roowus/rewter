/**
 * Moving a registry between machines, over the wire.
 *
 * `planImport` is tested exhaustively in `shared`, so these are not about which
 * outcome a row gets. They are about what only the route can get wrong: that
 * the export really is free of credentials once it has been through JSON, that
 * the plan's decisions actually reach SQLite (and that `dryRun` reaches
 * nothing), and — the one that would be silently lost otherwise — that a
 * hand-written override survives a round trip as an override rather than being
 * flattened into the generated text on the way.
 */
import type { CapabilityCard } from "@rewter/shared";
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
const OPUS = "anthropic/claude-opus-5";
const NOW = 1_756_252_800_000;
const LATER = NOW + 60_000;

let db: Db;
let repos: Repos;
let app: FastifyInstance;
let now = NOW;

/** A second machine: same code, its own empty database. */
function freshMachine(): { repos: Repos; app: FastifyInstance } {
  const other = openDb(":memory:");
  const bus = new EventBus(other, () => NOW);
  const r = new Repos(other, bus, () => LATER);
  return {
    repos: r,
    app: buildApp({
      router: new Router({ repos: r, createAdapter: () => new FakeAdapter([]) }),
      repos: r,
      bus,
      clock: () => LATER,
      sse: { heartbeatMs: 0 },
    }),
  };
}

function card(modelId: string, over: Partial<CapabilityCard> = {}): CapabilityCard {
  return {
    modelId: modelId as never,
    summary: "generated summary",
    strengths: ["coding"],
    weaknesses: [],
    bestAt: ["planning"],
    notes: null,
    userOverrides: null,
    generatedBy: null,
    generatedAt: NOW,
    updatedAt: NOW,
    ...over,
  } as CapabilityCard;
}

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

const exportBundle = async (query = "") => {
  const res = await app.inject({ method: "GET", url: `/internal/registry/export${query}` });
  expect(res.statusCode).toBe(200);
  return res.json<Record<string, unknown>>();
};

type Report = {
  dryRun: boolean;
  onConflict: string;
  models: { id: string; outcome: string; reason: string | null }[];
  cards: { id: string; outcome: string; reason: string | null }[];
  missingProviders: { id: string; name: string; modelCount: number }[];
};

const importInto = async (target: FastifyInstance, payload: object) => {
  const res = await target.inject({
    method: "POST",
    url: "/internal/registry/import",
    payload,
  });
  return { status: res.statusCode, body: res.json<Report>() };
};

describe("GET /internal/registry/export", () => {
  it("carries no credential once it is JSON on the wire", async () => {
    // The provider fixture references TEST_API_KEY. Not "we omitted the field"
    // — the assertion is on the serialised bytes, which is what leaves the
    // machine.
    const res = await app.inject({ method: "GET", url: "/internal/registry/export" });
    expect(res.body).not.toContain("apiKeyRef");
    expect(res.body).not.toContain("TEST_API_KEY");
  });

  it("describes the providers its models belong to, by identity only", async () => {
    const bundle = await exportBundle();
    expect(bundle.providers).toEqual([
      {
        id: PRV_A,
        name: "Test Provider",
        kind: "openai-compat",
        baseUrl: "https://example.test/v1",
      },
    ]);
  });

  it("exports cards with the user's layer still separate from the generated one", async () => {
    // The whole reason export reads raw cards. Flattened, the far machine's
    // next `rewter card` would discard the correction with nothing to show it
    // ever existed.
    repos.upsertCard(card(SONNET));
    repos.setCardOverrides(SONNET, { summary: "corrected by hand" });
    const bundle = await exportBundle();
    const [only] = bundle.cards as CapabilityCard[];
    expect(only?.summary).toBe("generated summary");
    expect(only?.userOverrides).toEqual({ summary: "corrected by hand" });
  });

  it("keeps the note a human wrote on it", async () => {
    const bundle = await exportBundle("?note=laptop%20before%20reinstall");
    expect(bundle.note).toBe("laptop before reinstall");
    expect(bundle.exportedAt).toBe(NOW);
  });
});

describe("POST /internal/registry/import", () => {
  it("round-trips a registry onto a machine that has the provider", async () => {
    repos.upsertCard(card(SONNET));
    repos.setCardOverrides(SONNET, { summary: "corrected by hand" });
    const bundle = await exportBundle();

    const other = freshMachine();
    other.repos.upsertProvider(provider());
    const { status, body } = await importInto(other.app, { bundle });

    expect(status).toBe(200);
    expect(body.models).toEqual([{ id: SONNET, outcome: "added", reason: null }]);
    expect(other.repos.getModel(SONNET)?.pricing.inputPerMTok).toBe(3);
    // The correction arrived as a correction, not as generated text.
    expect(other.repos.getRawCard(SONNET)?.userOverrides).toEqual({ summary: "corrected by hand" });
    expect(other.repos.getCard(SONNET)?.summary).toBe("corrected by hand");
    await other.app.close();
  });

  it("leaves a locally edited row alone by default, and says how to mean otherwise", async () => {
    // Rule 1, at the route: importing the same bundle twice cannot destroy work
    // done between the two runs.
    const bundle = await exportBundle();
    const other = freshMachine();
    other.repos.upsertProvider(provider());
    other.repos.upsertModel(
      model(SONNET, PRV_A, {
        source: "manual",
        pricing: { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
      }),
    );

    const { body } = await importInto(other.app, { bundle });
    expect(body.onConflict).toBe("skip");
    expect(body.models[0]?.outcome).toBe("exists");
    expect(other.repos.getModel(SONNET)?.pricing.inputPerMTok).toBe(1);
    await other.app.close();
  });

  it("replaces the row when overwrite was asked for", async () => {
    const bundle = await exportBundle();
    const other = freshMachine();
    other.repos.upsertProvider(provider());
    other.repos.upsertModel(
      model(SONNET, PRV_A, {
        pricing: { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
      }),
    );

    const { body } = await importInto(other.app, { bundle, onConflict: "overwrite" });
    expect(body.models[0]?.outcome).toBe("replaced");
    expect(other.repos.getModel(SONNET)?.pricing.inputPerMTok).toBe(3);
    // Written here, now — "last touched" is the column read when working out
    // why a price moved.
    expect(other.repos.getModel(SONNET)?.updatedAt).toBe(LATER);
    await other.app.close();
  });

  it("never removes a local model the bundle has not heard of", async () => {
    // Rule 2, at the route. Cost records name model ids forever.
    const bundle = await exportBundle();
    const other = freshMachine();
    other.repos.upsertProvider(provider());
    other.repos.upsertModel(model("local/only-here", PRV_A));

    await importInto(other.app, { bundle, onConflict: "overwrite" });
    expect(other.repos.getModel("local/only-here")).toBeDefined();
    await other.app.close();
  });

  it("writes nothing on a dry run, and reports exactly what it would have done", async () => {
    const bundle = await exportBundle();
    const other = freshMachine();
    other.repos.upsertProvider(provider());

    const preview = await importInto(other.app, { bundle, dryRun: true });
    expect(preview.body.dryRun).toBe(true);
    expect(preview.body.models[0]?.outcome).toBe("added");
    expect(other.repos.getModel(SONNET)).toBeUndefined();

    // And the preview was truthful: running it for real does the same thing.
    const real = await importInto(other.app, { bundle });
    expect(real.body.models).toEqual(preview.body.models);
    expect(other.repos.getModel(SONNET)).toBeDefined();
    await other.app.close();
  });

  it("skips a model whose provider is not configured here, and names it once with a count", async () => {
    // Not "create the provider": a half-configured upstream with no key fails
    // later, further away, as a 503 from inside a task.
    repos.upsertModel(model(OPUS, PRV_A));
    const bundle = await exportBundle();

    const other = freshMachine();
    const { body } = await importInto(other.app, { bundle });
    expect(body.models.map((d) => d.outcome)).toEqual(["no_provider", "no_provider"]);
    expect(body.missingProviders).toEqual([{ id: PRV_A, name: "Test Provider", modelCount: 2 }]);
    expect(other.repos.listModels()).toEqual([]);
    await other.app.close();
  });

  it("lands a card on a model arriving in the same request", async () => {
    repos.upsertCard(card(SONNET));
    const bundle = await exportBundle();
    const other = freshMachine();
    other.repos.upsertProvider(provider());

    const { body } = await importInto(other.app, { bundle });
    expect(body.cards[0]?.outcome).toBe("added");
    expect(other.repos.getCard(SONNET)?.bestAt).toEqual(["planning"]);
    await other.app.close();
  });

  it("does not import a card whose model was skipped, rather than orphaning it", async () => {
    repos.upsertCard(card(SONNET));
    const bundle = await exportBundle();
    const other = freshMachine(); // no provider, so the model does not land

    const { body } = await importInto(other.app, { bundle });
    expect(body.cards[0]?.outcome).toBe("no_model");
    expect(other.repos.getRawCard(SONNET)).toBeUndefined();
    await other.app.close();
  });

  it("refuses a malformed bundle with the field that is wrong, not a 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/registry/import",
      payload: {
        bundle: { version: 1, exportedAt: NOW, providers: [], models: [], cards: [] },
        onConflict: "merge",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain("onConflict");
  });

  it("refuses a bundle from a version it does not know", async () => {
    const bundle = { ...(await exportBundle()), version: 2 };
    const res = await app.inject({
      method: "POST",
      url: "/internal/registry/import",
      payload: { bundle },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain("version");
  });

  it("imports a model belonging to a provider this machine happens to call something else", async () => {
    // Providers are matched by id, which is derived from the preset slug — so
    // the same upstream configured on two machines has the same id, and a
    // renamed provider still matches.
    repos.upsertProvider(provider(PRV_B, { name: "Second" }));
    repos.upsertModel(model("second/model-a", PRV_B));
    const bundle = await exportBundle();

    const other = freshMachine();
    other.repos.upsertProvider(provider(PRV_B, { name: "Renamed locally" }));
    const { body } = await importInto(other.app, { bundle });
    const secondModel = body.models.find((d) => d.id === "second/model-a");
    expect(secondModel?.outcome).toBe("added");
    expect(other.repos.getProvider(PRV_B)?.name).toBe("Renamed locally");
    await other.app.close();
  });
});
