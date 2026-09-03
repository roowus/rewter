/**
 * The practices stage/approve routes. Mechanics live in
 * `practices/stage.test.ts`; these pin what only the route can get wrong: the
 * reindex landing in SQLite after each mutation, the project check reaching
 * the repos, failure-code → HTTP-status, the strict body, the ?status filter,
 * and the 501 when no tree is configured.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectSchema, newProjectId } from "@rewter/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { reindexPractices } from "../practices/reindex.js";
import { Router } from "../router/router.js";
import { FakeAdapter } from "../testing/fake-adapter.js";
import { buildApp } from "./app.js";

const NOW = 1_756_252_800_000;

let db: Db;
let repos: Repos;
let app: FastifyInstance;
let root: string;

beforeEach(() => {
  db = openDb(":memory:");
  const bus = new EventBus(db, () => NOW);
  repos = new Repos(db, bus, () => NOW);
  root = mkdtempSync(join(tmpdir(), "rewter-practices-routes-"));
  app = buildApp({
    router: new Router({ repos, createAdapter: () => new FakeAdapter([]) }),
    repos,
    bus,
    clock: () => NOW,
    sse: { heartbeatMs: 0 },
    practicesRoot: root,
  });
});

afterEach(async () => {
  await app?.close();
  rmSync(root, { recursive: true, force: true });
});

function write(scopeDir: string, slug: string, opts: { project?: string; fact?: string } = {}) {
  const dir = join(root, scopeDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PRACTICE.md"),
    [
      "---",
      `name: ${slug}`,
      ...(opts.project !== undefined ? [`project: ${opts.project}`] : []),
      "---",
      "",
      opts.fact ?? "The fact.",
      "",
    ].join("\n"),
  );
  reindexPractices(root, repos);
}

const draft = (slug: string, opts: { project?: string } = {}) => write("pending", slug, opts);

function saveProject(slug: string) {
  repos.upsertProject(
    ProjectSchema.parse({ id: newProjectId(), slug, name: slug, createdAt: NOW, updatedAt: NOW }),
  );
}

const list = (qs = "") => app.inject({ method: "GET", url: `/internal/practices${qs}` });
const approve = (slug: string, body: object = {}) =>
  app.inject({ method: "POST", url: `/internal/practices/${slug}/approve`, payload: body });
const reject = (slug: string) =>
  app.inject({ method: "POST", url: `/internal/practices/${slug}/reject` });

describe("GET /internal/practices", () => {
  it("lists the index with facts, filterable by status", async () => {
    draft("proposed-one");
    write("global", "old-rule", { fact: "Always run pnpm check." });

    const all = (await list()).json();
    expect(all.practices.map((p: { slug: string }) => p.slug)).toEqual([
      "old-rule",
      "proposed-one",
    ]);
    expect(all.practices[0].fact).toBe("Always run pnpm check.");

    const pending = (await list("?status=pending")).json();
    expect(pending.practices).toMatchObject([{ slug: "proposed-one", status: "pending" }]);
    const approved = (await list("?status=approved")).json();
    expect(approved.practices).toMatchObject([{ slug: "old-rule", status: "approved" }]);
  });
});

describe("POST /internal/practices/:slug/approve", () => {
  it("moves the draft, reindexes, and returns the approved row", async () => {
    draft("a-rule");
    const res = await approve("a-rule");
    expect(res.statusCode).toBe(200);
    expect(res.json().practice).toMatchObject({
      slug: "a-rule",
      status: "approved",
      scope: "global",
      fact: "The fact.",
      path: join(root, "global", "a-rule", "PRACTICE.md"),
    });
    expect(repos.listPractices()).toMatchObject([{ slug: "a-rule", status: "approved" }]);
  });

  it("checks the target project against the repos", async () => {
    draft("a-rule", { project: "clarity" });
    const missing = await approve("a-rule");
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.message).toContain('project "clarity"');

    saveProject("clarity");
    const ok = await approve("a-rule");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().practice).toMatchObject({ scope: "project", projectSlug: "clarity" });
  });

  it("409s a collision, then honours an explicit overwrite", async () => {
    draft("a-rule");
    await approve("a-rule");
    draft("a-rule");
    const clash = await approve("a-rule");
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.message).toContain("already exists");
    expect((await approve("a-rule", { overwrite: true })).statusCode).toBe(200);
  });

  it("404s an unknown slug and 400s a non-strict body", async () => {
    expect((await approve("nope")).statusCode).toBe(404);
    draft("a-rule");
    expect((await approve("a-rule", { force: true })).statusCode).toBe(400);
  });

  it("422s a draft the owner edited into something that no longer parses", async () => {
    draft("a-rule");
    writeFileSync(
      join(root, "pending", "a-rule", "PRACTICE.md"),
      `---\nname: a-rule\n---\n\n${"z".repeat(500)}\n`,
    );
    const res = await approve("a-rule");
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain("capped at");
  });
});

describe("POST /internal/practices/:slug/reject", () => {
  it("deletes the draft and reindexes", async () => {
    draft("a-rule");
    expect(repos.listPractices()).toHaveLength(1);
    const res = await reject("a-rule");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rejected: "a-rule" });
    expect(existsSync(join(root, "pending", "a-rule"))).toBe(false);
    expect(repos.listPractices()).toEqual([]);
  });

  it("404s an unknown slug", async () => {
    expect((await reject("nope")).statusCode).toBe(404);
  });
});

describe("without a practices root", () => {
  it("mutations 501 but the list still answers", async () => {
    const bare = buildApp({
      router: new Router({ repos, createAdapter: () => new FakeAdapter([]) }),
      repos,
      bus: new EventBus(db, () => NOW),
      sse: { heartbeatMs: 0 },
    });
    expect((await bare.inject({ method: "GET", url: "/internal/practices" })).statusCode).toBe(200);
    expect(
      (await bare.inject({ method: "POST", url: "/internal/practices/x/approve", payload: {} }))
        .statusCode,
    ).toBe(501);
    expect(
      (await bare.inject({ method: "POST", url: "/internal/practices/x/reject" })).statusCode,
    ).toBe(501);
    await bare.close();
  });
});
