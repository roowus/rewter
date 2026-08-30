/**
 * Serving the dashboard bundle at `/`.
 *
 * The architecture promised "built static, served by the same daemon" from the
 * first commit, but nothing ever registered a static plugin — `GET /` 404'd,
 * and the UI existed only behind `vite dev`'s proxy (#16). These tests pin the
 * three things that made it wrong quietly: that the root serves the page, that
 * a static route can never shadow an API one, and that a checkout without a
 * built bundle still boots a working API.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { Router } from "../router/router.js";
import { model, provider } from "../testing/registry.js";
import { buildApp } from "./app.js";

const INDEX = "<!doctype html><title>rewter</title><div id=root></div>";

let db: Db;
let repos: Repos;
let bus: EventBus;
let app: FastifyInstance;
let dir: string;

beforeEach(() => {
  db = openDb(":memory:");
  bus = new EventBus(db);
  repos = new Repos(db, bus);
  repos.upsertProvider(provider());
  repos.upsertModel(model("test/model-a"));

  dir = mkdtempSync(join(tmpdir(), "rewter-dash-"));
  writeFileSync(join(dir, "index.html"), INDEX);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "export const x = 1;\n");
});

afterEach(async () => {
  await app?.close();
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

function boot(dashboardDir: string | null): FastifyInstance {
  app = buildApp({ router: new Router({ repos }), repos, bus, dashboardDir });
  return app;
}

describe("dashboard static serving", () => {
  it("serves the bundle at the root — the URL the daemon prints", async () => {
    const res = await boot(dir).inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("id=root");
  });

  it("serves hashed assets", async () => {
    const res = await boot(dir).inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("export const x");
  });

  it("falls back to index.html for a client-routed deep link", async () => {
    // The dashboard owns its own paths; a URL the server has never heard of is
    // the SPA's to resolve, not a 404 — otherwise a reload on any route but `/`
    // breaks.
    const res = await boot(dir).inject({ method: "GET", url: "/tasks/tsk_abc123" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("id=root");
  });

  it("never shadows an API route", async () => {
    // Registered after every route above it, so the real endpoint still answers.
    const res = await boot(dir).inject({ method: "GET", url: "/v1/models" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).object).toBe("list");
  });

  it("404s an unknown API path as JSON rather than serving the page", async () => {
    // Answering a mistyped fetch with a page of HTML turns a 404 into a JSON
    // parse error inside the caller — much worse to debug than the 404 was.
    for (const url of ["/internal/typo", "/v1/nope"]) {
      const res = await boot(dir).inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
    }
  });

  it("does not answer a non-GET with the page", async () => {
    const res = await boot(dir).inject({ method: "POST", url: "/whatever" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("boots a working API when the bundle was never built", async () => {
    // An operator debugging a provider should not be blocked by a missing UI,
    // so a checkout that has not run `pnpm build` still starts.
    const res = await boot(null).inject({ method: "GET", url: "/v1/models" });
    expect(res.statusCode).toBe(200);
    expect(await app.inject({ method: "GET", url: "/" }).then((r) => r.statusCode)).toBe(404);
  });

  it("boots when the configured directory does not exist", async () => {
    const missing = join(dir, "not-built");
    const res = await boot(missing).inject({ method: "GET", url: "/v1/models" });
    expect(res.statusCode).toBe(200);
  });
});
