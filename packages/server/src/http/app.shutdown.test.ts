/**
 * Stopping the daemon from its own dashboard — survey shortlist item 8.
 *
 * Four claims, and only the first is about HTTP:
 *
 *  - **The reply comes out before the process goes.** There is no other order
 *    available, so the route schedules the stop rather than awaiting it, and
 *    these tests assert the body arrives *and* the hook still runs.
 *  - **It says which supervisor it is under, and what will not happen.** Under
 *    launchd a clean exit stays down by design, so the payload's job is to say
 *    so and name the command that brings it back.
 *  - **`willRestart: null` when it cannot tell.** A boolean there would be a
 *    guess printed as a fact.
 *  - **No hook, no shutdown.** An app that cannot stop the daemon says 501
 *    rather than closing itself and leaving the pidfile behind.
 */
import { ShutdownResultSchema } from "@rewter/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { Router } from "../router/router.js";
import { SERVICE_LABEL } from "../service/launchd.js";
import { PRV_A, model, provider } from "../testing/registry.js";
import { type AppOptions, buildApp } from "./app.js";

let db: Db;
let repos: Repos;
let bus: EventBus;
let app: FastifyInstance;

beforeEach(() => {
  db = openDb(":memory:");
  bus = new EventBus(db);
  repos = new Repos(db, bus);
  repos.upsertProvider(provider());
  repos.upsertModel(model("anthropic/claude-opus-5", PRV_A));
});

afterEach(async () => {
  await app?.close();
});

function build(overrides: Partial<AppOptions> = {}): FastifyInstance {
  app = buildApp({
    router: new Router({ repos, env: {} }),
    repos,
    bus,
    ...overrides,
  });
  return app;
}

/** Lets a test wait for the hook the route deliberately does not await. */
function deferredHook(): { hook: () => Promise<void>; called: Promise<void>; count: () => number } {
  let resolve!: () => void;
  const called = new Promise<void>((r) => {
    resolve = r;
  });
  let count = 0;
  return {
    hook: async () => {
      count += 1;
      resolve();
    },
    called,
    count: () => count,
  };
}

describe("POST /internal/shutdown", () => {
  it("answers 202 before it stops, and then stops", async () => {
    const { hook, called, count } = deferredHook();
    const a = build({ shutdown: hook, supervisor: "standalone" });

    const res = await a.inject({ method: "POST", url: "/internal/shutdown" });

    // The reply is the point: a route that awaited the stop would be closing
    // the server that has to write this.
    expect(res.statusCode).toBe(202);
    const body = ShutdownResultSchema.parse(res.json());
    expect(body.ok).toBe(true);
    expect(body.pid).toBe(process.pid);

    // And the scheduled half really runs — a 202 for work that never happens
    // is the worst of the available failures, because it looks like success.
    await called;
    expect(count()).toBe(1);
  });

  it("names launchd and the kickstart command, and says nothing will restart it", async () => {
    const { hook } = deferredHook();
    const a = build({ shutdown: hook, supervisor: "launchd" });

    const body = ShutdownResultSchema.parse(
      (await a.inject({ method: "POST", url: "/internal/shutdown" })).json(),
    );

    expect(body.supervisor).toBe("launchd");
    // The whole reason there is no Restart button: the generated plist sets
    // KeepAlive to { SuccessfulExit: false }, so a clean exit stays down.
    expect(body.willRestart).toBe(false);
    expect(body.restartWith).toContain("launchctl kickstart");
    expect(body.restartWith).toContain(SERVICE_LABEL);
  });

  it("tells a hand-started daemon to use `rewter start`", async () => {
    const { hook } = deferredHook();
    const a = build({ shutdown: hook, supervisor: "standalone" });

    const body = ShutdownResultSchema.parse(
      (await a.inject({ method: "POST", url: "/internal/shutdown" })).json(),
    );

    expect(body.willRestart).toBe(false);
    expect(body.restartWith).toBe("rewter start");
  });

  it("reports willRestart: null when it cannot tell what started it", async () => {
    const { hook } = deferredHook();
    const a = build({ shutdown: hook, supervisor: "unknown" });

    const body = ShutdownResultSchema.parse(
      (await a.inject({ method: "POST", url: "/internal/shutdown" })).json(),
    );

    // Not `false`: a container or a third-party supervisor may well bring it
    // straight back, and this process has no way to know.
    expect(body.willRestart).toBeNull();
    expect(body.restartWith).toBe("rewter start");
  });

  it("501s with no shutdown hook, and does not close itself", async () => {
    const a = build();

    const res = await a.inject({ method: "POST", url: "/internal/shutdown" });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ error: { message: expect.stringContaining("hook") } });
    // Still serving: the failure mode worth ruling out is a route that half-ran.
    expect((await a.inject({ method: "GET", url: "/internal/health" })).statusCode).toBe(200);
  });

  it("survives a hook that throws — the reply is already gone", async () => {
    let called = false;
    const a = build({
      shutdown: () => {
        called = true;
        throw new Error("db was already closed");
      },
      supervisor: "standalone",
    });

    const res = await a.inject({ method: "POST", url: "/internal/shutdown" });
    expect(res.statusCode).toBe(202);

    // The throw happens on a later tick with nothing to catch it but the route's
    // own handler; an unhandled rejection here would fail the run.
    await new Promise((r) => setImmediate(r));
    expect(called).toBe(true);
  });

  it("is a POST — a prefetched link must not stop the daemon", async () => {
    const { hook, count } = deferredHook();
    const a = build({ shutdown: hook, supervisor: "standalone" });

    const res = await a.inject({ method: "GET", url: "/internal/shutdown" });

    expect(res.statusCode).toBe(404);
    expect(count()).toBe(0);
  });
});
