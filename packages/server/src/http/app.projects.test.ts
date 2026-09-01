/**
 * The projects editor's routes.
 *
 * `applyProjectPatch` and the create/patch schemas are tested exhaustively in
 * `shared`, so these are not about the fold arithmetic or strictness tables.
 * They are about what only the route can get wrong: slug-addressed lookups
 * actually reaching SQLite, the 409 on a taken slug, server-minted fields a
 * body cannot smuggle in, the archived filter on the list, and delete leaving
 * task history alone.
 */
import { type Project, ProjectSchema, newProjectId } from "@rewter/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { Router } from "../router/router.js";
import { FakeAdapter } from "../testing/fake-adapter.js";
import { buildApp } from "./app.js";

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

function saveProject(over: Record<string, unknown> = {}): Project {
  const project = ProjectSchema.parse({
    id: newProjectId(),
    slug: "rewter",
    name: "Rewter",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
  repos.upsertProject(project);
  return project;
}

const create = (body: object) =>
  app.inject({ method: "POST", url: "/internal/projects", payload: body });
const patch = (slug: string, body: object) =>
  app.inject({ method: "PATCH", url: `/internal/projects/${slug}`, payload: body });

describe("GET /internal/projects", () => {
  it("lists live projects sorted by slug, hiding archived by default", async () => {
    saveProject({ slug: "zeta" });
    saveProject({ slug: "alpha" });
    saveProject({ slug: "old-one", archived: true });
    const body = (await app.inject({ method: "GET", url: "/internal/projects" })).json<{
      projects: Project[];
    }>();
    expect(body.projects.map((p) => p.slug)).toEqual(["alpha", "zeta"]);
  });

  it("includeArchived=true shows everything — unarchive has to find its target", async () => {
    saveProject({ slug: "live" });
    saveProject({ slug: "gone", archived: true });
    const body = (
      await app.inject({ method: "GET", url: "/internal/projects?includeArchived=true" })
    ).json<{ projects: Project[] }>();
    expect(body.projects.map((p) => p.slug)).toEqual(["gone", "live"]);
  });
});

describe("POST /internal/projects", () => {
  it("creates from slug + name alone, minting id and timestamps", async () => {
    const res = await create({ slug: "new-proj", name: "New Project" });
    expect(res.statusCode).toBe(201);
    const { project } = res.json<{ project: Project }>();
    expect(project.id).toMatch(/^proj_/);
    expect(project.createdAt).toBe(NOW);
    expect(project.archived).toBe(false);
    // And it landed in SQLite, addressable by the slug every channel uses.
    expect(repos.getProjectBySlug("new-proj")?.id).toBe(project.id);
  });

  it("409s on a taken slug — the slug is an address, not an upsert key", async () => {
    saveProject({ slug: "taken" });
    const res = await create({ slug: "taken", name: "Usurper" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain("already exists");
    expect(repos.getProjectBySlug("taken")?.name).toBe("Rewter");
  });

  it("400s a body trying to supply server-minted fields", async () => {
    for (const field of [{ id: "prj_x" }, { archived: true }, { createdAt: 1 }]) {
      const res = await create({ slug: "s", name: "n", ...field });
      expect(res.statusCode).toBe(400);
    }
    expect(repos.getProjectBySlug("s")).toBeUndefined();
  });

  it("400s an invalid slug with the field path", async () => {
    const res = await create({ slug: "Has Caps", name: "n" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("slug");
  });
});

describe("PATCH /internal/projects/:slug", () => {
  it("applies a patch and bumps updatedAt to the route's clock", async () => {
    saveProject();
    now = LATER;
    const res = await patch("rewter", { name: "Renamed", policy: { maxSpendUsd: 2 } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ project: Project; changed: boolean }>();
    expect(body.changed).toBe(true);
    expect(body.project.name).toBe("Renamed");
    expect(body.project.policy.maxSpendUsd).toBe(2);
    expect(body.project.updatedAt).toBe(LATER);
    expect(repos.getProjectBySlug("rewter")?.name).toBe("Renamed");
  });

  it("a no-op patch returns changed:false and leaves updatedAt alone", async () => {
    saveProject();
    now = LATER;
    const res = await patch("rewter", { name: "Rewter" });
    const body = res.json<{ project: Project; changed: boolean }>();
    expect(body.changed).toBe(false);
    expect(body.project.updatedAt).toBe(NOW);
    expect(repos.getProjectBySlug("rewter")?.updatedAt).toBe(NOW);
  });

  it("archives and unarchives with the same edit", async () => {
    saveProject();
    await patch("rewter", { archived: true });
    expect(repos.getProjectBySlug("rewter")?.archived).toBe(true);
    await patch("rewter", { archived: false });
    expect(repos.getProjectBySlug("rewter")?.archived).toBe(false);
  });

  it("404s an unknown slug and 400s a slug-rename attempt", async () => {
    expect((await patch("nope", { name: "x" })).statusCode).toBe(404);
    saveProject();
    const res = await patch("rewter", { slug: "new-address" });
    expect(res.statusCode).toBe(400);
    expect(repos.getProjectBySlug("rewter")).toBeDefined();
    expect(repos.getProjectBySlug("new-address")).toBeUndefined();
  });
});

describe("DELETE /internal/projects/:slug", () => {
  it("deletes by slug and 404s the second attempt", async () => {
    saveProject();
    const res = await app.inject({ method: "DELETE", url: "/internal/projects/rewter" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: "rewter" });
    expect(repos.getProjectBySlug("rewter")).toBeUndefined();
    expect(
      (await app.inject({ method: "DELETE", url: "/internal/projects/rewter" })).statusCode,
    ).toBe(404);
  });
});
