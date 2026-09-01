/**
 * The skills stage/approve routes.
 *
 * `approveSkill`/`rejectSkill` mechanics live in `skills/stage.test.ts`; these
 * are about what only the route can get wrong: the reindex actually landing in
 * SQLite after each mutation, the project-existence check reaching the repos,
 * the failure-code → HTTP-status mapping, the strict body, the ?status filter,
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
import { Router } from "../router/router.js";
import { reindexSkills } from "../skills/reindex.js";
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
  root = mkdtempSync(join(tmpdir(), "rewter-skills-routes-"));
  app = buildApp({
    router: new Router({ repos, createAdapter: () => new FakeAdapter([]) }),
    repos,
    bus,
    clock: () => NOW,
    sse: { heartbeatMs: 0 },
    skillsRoot: root,
  });
});

afterEach(async () => {
  await app?.close();
  rmSync(root, { recursive: true, force: true });
});

function draft(slug: string, opts: { project?: string } = {}) {
  const dir = join(root, "pending", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    [
      "---",
      `name: ${slug}`,
      "description: what it is for",
      ...(opts.project !== undefined ? [`project: ${opts.project}`] : []),
      "---",
      "",
      "body",
      "",
    ].join("\n"),
  );
  reindexSkills(root, repos);
}

function saveProject(slug: string) {
  repos.upsertProject(
    ProjectSchema.parse({
      id: newProjectId(),
      slug,
      name: slug,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

const list = (qs = "") => app.inject({ method: "GET", url: `/internal/skills${qs}` });
const approve = (slug: string, body: object = {}) =>
  app.inject({ method: "POST", url: `/internal/skills/${slug}/approve`, payload: body });
const reject = (slug: string) =>
  app.inject({ method: "POST", url: `/internal/skills/${slug}/reject` });

describe("GET /internal/skills", () => {
  it("lists the index, filterable by status", async () => {
    draft("proposed-one");
    mkdirSync(join(root, "global", "old-hand"), { recursive: true });
    writeFileSync(
      join(root, "global", "old-hand", "SKILL.md"),
      "---\nname: old-hand\ndescription: d\n---\n\nb\n",
    );
    reindexSkills(root, repos);

    const all = list().then((r) => r.json());
    expect((await all).skills.map((s: { slug: string }) => s.slug)).toEqual([
      "old-hand",
      "proposed-one",
    ]);

    const pending = (await list("?status=pending")).json();
    expect(pending.skills).toMatchObject([{ slug: "proposed-one", status: "pending" }]);
    const approved = (await list("?status=approved")).json();
    expect(approved.skills).toMatchObject([{ slug: "old-hand", status: "approved" }]);
  });
});

describe("POST /internal/skills/:slug/approve", () => {
  it("moves the draft, reindexes, and returns the approved row", async () => {
    draft("a-skill");
    const res = await approve("a-skill");
    expect(res.statusCode).toBe(200);
    expect(res.json().skill).toMatchObject({
      slug: "a-skill",
      status: "approved",
      scope: "global",
      path: join(root, "global", "a-skill", "SKILL.md"),
    });
    // The index caught up: the pending row is gone, the approved one is real.
    expect(repos.listSkills()).toMatchObject([{ slug: "a-skill", status: "approved" }]);
  });

  it("checks the target project against the repos", async () => {
    draft("a-skill", { project: "clarity" });
    const missing = await approve("a-skill");
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.message).toContain('project "clarity"');

    saveProject("clarity");
    const ok = await approve("a-skill");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().skill).toMatchObject({ scope: "project", projectSlug: "clarity" });
  });

  it("409s a collision, then honours an explicit overwrite", async () => {
    draft("a-skill");
    await approve("a-skill");
    draft("a-skill");
    expect((await approve("a-skill")).statusCode).toBe(409);
    expect((await approve("a-skill", { overwrite: true })).statusCode).toBe(200);
  });

  it("404s an unknown slug and 400s a non-strict body", async () => {
    expect((await approve("nope")).statusCode).toBe(404);
    draft("a-skill");
    expect((await approve("a-skill", { force: true })).statusCode).toBe(400);
  });
});

describe("POST /internal/skills/:slug/reject", () => {
  it("deletes the draft and reindexes", async () => {
    draft("a-skill");
    expect(repos.listSkills()).toHaveLength(1);
    const res = await reject("a-skill");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rejected: "a-skill" });
    expect(existsSync(join(root, "pending", "a-skill"))).toBe(false);
    expect(repos.listSkills()).toEqual([]);
  });

  it("404s an unknown slug", async () => {
    expect((await reject("nope")).statusCode).toBe(404);
  });
});

describe("without a skills root", () => {
  it("mutations 501 but the list still answers", async () => {
    const bare = buildApp({
      router: new Router({ repos, createAdapter: () => new FakeAdapter([]) }),
      repos,
      bus: new EventBus(db, () => NOW),
      sse: { heartbeatMs: 0 },
    });
    expect((await bare.inject({ method: "GET", url: "/internal/skills" })).statusCode).toBe(200);
    expect(
      (await bare.inject({ method: "POST", url: "/internal/skills/x/approve", payload: {} }))
        .statusCode,
    ).toBe(501);
    expect(
      (await bare.inject({ method: "POST", url: "/internal/skills/x/reject" })).statusCode,
    ).toBe(501);
    await bare.close();
  });
});
