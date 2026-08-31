import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonHealthSchema, ModelIdSchema, TaskSettingsSchema, newTaskId } from "@rewter/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "./config/config.js";
import { type RunningDaemon, bootSummary, startDaemon } from "./daemon.js";
import { readPidfile } from "./service/pidfile.js";

let dir: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewter-daemon-"));
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** Boot on port 0 (OS-assigned) with the DB inside the temp dir. */
async function boot(overrides: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
  const config = ConfigSchema.parse({
    dbPath: join(dir, "nested", "rewter.db"),
    logger: false,
    ...overrides,
  });
  daemon = await startDaemon({ config, env, port: 0 });
  return daemon;
}

describe("startDaemon", () => {
  it("listens and serves health", async () => {
    const d = await boot();
    const res = await fetch(`${d.url}/internal/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("serves health with the real runtime facts, not the app's fallbacks", async () => {
    // The fallbacks (url: null, db path "unknown") are for injected apps; a
    // booted daemon must know both, because an operator reading the dashboard
    // is reading them to point curl at the right socket and du at the right file.
    const d = await boot();
    const health = DaemonHealthSchema.parse(await (await fetch(`${d.url}/internal/health`)).json());
    expect(health.url).toBe(d.url);
    expect(health.db.path).toBe(join(dir, "nested", "rewter.db"));
    expect(health.db.sizeBytes).not.toBeNull();
    expect(health.startedAt).toBeGreaterThan(0);
    expect(health.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("creates the database directory if it does not exist", async () => {
    // A first run on a fresh machine must not fail because ~/.rewter is absent.
    const d = await boot();
    expect(d.db.$client.open).toBe(true);
  });

  it("seeds the registry from config and serves it on /v1/models", async () => {
    const d = await boot(
      {
        providers: [{ preset: "anthropic" }],
        models: [{ id: "anthropic/claude-sonnet-5", provider: "anthropic" }],
      },
      { ANTHROPIC_API_KEY: "sk-test" },
    );
    const body = (await (await fetch(`${d.url}/v1/models`)).json()) as {
      data: { id: string }[];
    };
    const ids = body.data.map((m) => m.id);
    expect(ids[0]).toBe("auto/orchestrator");
    expect(ids).toContain("anthropic/claude-sonnet-5");
  });

  it("hides models of a provider whose key env var is unset", async () => {
    // The provider is seeded disabled, so its models resolve to a 503 that
    // names them rather than silently disappearing from the picker's reach.
    const d = await boot({
      providers: [{ preset: "anthropic" }],
      models: [{ id: "anthropic/claude-sonnet-5", provider: "anthropic" }],
    });
    const res = await fetch(`${d.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain("claude-sonnet-5");
  });

  it("reads the bearer token from the environment by variable name", async () => {
    const d = await boot({ apiKeyEnv: "MY_REWTER_TOKEN" }, { MY_REWTER_TOKEN: "s3cret" });

    const denied = await fetch(`${d.url}/v1/models`);
    expect(denied.status).toBe(401);

    const allowed = await fetch(`${d.url}/v1/models`, {
      headers: { authorization: "Bearer s3cret" },
    });
    expect(allowed.status).toBe(200);
  });

  it("leaves /v1 open when the token env var is unset", async () => {
    const d = await boot({ apiKeyEnv: "UNSET_TOKEN_VAR" });
    expect((await fetch(`${d.url}/v1/models`)).status).toBe(200);
  });

  it("never gates /internal, even with a token configured", async () => {
    // The dashboard is same-origin and holds no key; /internal is loopback-only.
    const d = await boot({ apiKeyEnv: "MY_REWTER_TOKEN" }, { MY_REWTER_TOKEN: "s3cret" });
    expect((await fetch(`${d.url}/internal/health`)).status).toBe(200);
  });

  it("persists the registry across restarts of the same database", async () => {
    const dbPath = join(dir, "persist.db");
    const cfg = {
      dbPath,
      providers: [{ preset: "anthropic" }],
      models: [{ id: "anthropic/claude-sonnet-5", provider: "anthropic" }],
    };
    const first = await boot(cfg, { ANTHROPIC_API_KEY: "sk-test" });
    const providerId = first.repos.listProviders()[0]?.id;
    await first.stop();
    daemon = undefined;

    const second = await boot(cfg, { ANTHROPIC_API_KEY: "sk-test" });
    expect(second.repos.listProviders()).toHaveLength(1);
    expect(second.repos.listProviders()[0]?.id).toBe(providerId);
    expect(second.repos.listModels()).toHaveLength(1);
  });

  it("closes out a task the previous process left running, keeping its history", async () => {
    // The `kill -9` case: the first daemon dies with a task mid-flight, so no
    // code ever writes a terminal status. The second boot must find it — before
    // the socket opens — and say what happened, without erasing what came before.
    const dbPath = join(dir, "crash.db");
    const first = await boot({ dbPath });
    const task = first.repos.createTask({
      id: newTaskId(),
      status: "pending",
      title: "left running",
      initiatorModelId: ModelIdSchema.parse("anthropic/claude-sonnet-5"),
      projectId: null,
      conversationFingerprint: null,
      settings: TaskSettingsSchema.parse({}),
      resultSummary: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      finishedAt: null,
    });
    first.repos.transitionTask(task.id, "running");
    const seqBefore = first.bus.eventsAfter(0, task.id).length;
    // stop() is graceful, but nothing here collapses a task the way a signal
    // would — the row is left exactly as a killed process would leave it.
    await first.stop();
    daemon = undefined;

    const second = await boot({ dbPath });

    expect(second.reconciled.tasks).toEqual([task.id]);
    expect(second.repos.getTask(task.id)?.status).toBe("interrupted");
    // The earlier events are still there, with the interruption appended rather
    // than replacing them: the dashboard's fold replays the whole life.
    const replayed = second.bus.eventsAfter(0, task.id);
    expect(replayed.length).toBe(seqBefore + 1);
    expect(replayed.at(-1)?.payload.type).toBe("task.status_changed");
  });

  it("boots with an empty registry rather than refusing", async () => {
    // Nothing configured yet is a normal first-run state, not an error.
    const d = await boot();
    const body = (await (await fetch(`${d.url}/v1/models`)).json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1); // the orchestrator pseudo-model only
  });

  it("stop() closes both the server and the database", async () => {
    const d = await boot();
    const url = d.url;
    await d.stop();
    daemon = undefined;
    expect(d.db.$client.open).toBe(false);
    await expect(fetch(`${url}/internal/health`)).rejects.toThrow();
  });
});

/**
 * The pidfile is what another terminal's `rewter stop` has to go on. What
 * matters at this level is *when* it is written and removed relative to the
 * socket, not its format — `pidfile.test.ts` owns that.
 */
describe("startDaemon — pidfile", () => {
  it("writes nothing unless asked", async () => {
    // Every test and every library embedding boots without one: a pidfile is a
    // claim about *the* daemon on this machine, and three port-0 daemons must
    // not leave three of them contradicting each other.
    await boot();
    expect(readdirSync(dir).filter((f) => f.endsWith(".pid"))).toEqual([]);
  });

  it("records the address actually bound, not the one asked for", async () => {
    // Booted on port 0, so a file written before `listen` would say ":0" —
    // which is exactly the thing `stop` would then fail to probe.
    const path = join(dir, "rewter.pid");
    const d = await startDaemon({
      config: ConfigSchema.parse({ dbPath: join(dir, "rewter.db"), logger: false }),
      env: {},
      port: 0,
      pidfilePath: path,
    });
    daemon = d;

    const entry = readPidfile(path);
    expect(entry?.url).toBe(d.url);
    expect(entry?.pid).toBe(process.pid);
    // And it is a live address, not just a plausible string.
    expect((await fetch(`${entry?.url}/internal/health`)).status).toBe(200);
  });

  it("removes it on stop, before the socket finishes draining", async () => {
    const path = join(dir, "rewter.pid");
    const d = await startDaemon({
      config: ConfigSchema.parse({ dbPath: join(dir, "rewter.db"), logger: false }),
      env: {},
      port: 0,
      pidfilePath: path,
    });
    await d.stop();
    daemon = undefined;
    // From the moment we decide to stop, the claim is false — a `status`
    // racing the drain should read "not running", not point at a closing socket.
    expect(readPidfile(path)).toBeUndefined();
  });
});

/**
 * Stopping via the route rather than a signal — survey shortlist item 8.
 *
 * The seam has two halves on purpose. `stop()` drains; `requestStop()` drains
 * *and* ends the process, through a hook whoever owns the process lifetime
 * installs. A daemon embedded in a test owns no process and installs none, and
 * then the two are the same thing — which is what makes the route testable
 * without a `process.exit` in the middle of a test run.
 */
describe("startDaemon — stopping", () => {
  it("serves shutdown, and the route really stops the daemon", async () => {
    const d = await boot();
    const url = d.url;

    const res = await fetch(`${url}/internal/shutdown`, { method: "POST" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, pid: process.pid });

    // The reply came back before the drain, so wait for the port to actually go
    // — that gap is the whole reason the payload says "draining", not "stopped".
    daemon = undefined;
    await expect
      .poll(async () => {
        try {
          await fetch(`${url}/internal/health`);
          return "up";
        } catch {
          return "down";
        }
      })
      .toBe("down");
  });

  it("is idempotent — a signal racing the button drains once", async () => {
    const d = await boot();
    // Both callers must await the *same* drain: a boolean guard would let the
    // second return early while the first was still closing the database, and
    // the second close would throw.
    await Promise.all([d.stop(), d.stop(), d.requestStop()]);
    daemon = undefined;
  });

  it("runs the exit hook once the drain is done, not before", async () => {
    const d = await boot();
    const codes: number[] = [];
    d.onExit((code) => codes.push(code));

    const pending = d.requestStop();
    expect(codes).toEqual([]);
    await pending;
    daemon = undefined;

    expect(codes).toEqual([0]);
  });

  it("has no exit hook by default — an embedded daemon owns no process", async () => {
    const d = await boot();
    await d.requestStop();
    daemon = undefined;
    // Reaching here at all is the assertion: an unconditional `process.exit`
    // in `requestStop` would have taken the test runner with it.
    expect(true).toBe(true);
  });
});

describe("bootSummary", () => {
  it("reports the URL and enabled counts, and no secrets", async () => {
    const d = await boot(
      {
        providers: [{ preset: "anthropic" }],
        models: [{ id: "anthropic/claude-sonnet-5", provider: "anthropic" }],
      },
      { ANTHROPIC_API_KEY: "sk-test" },
    );
    const summary = bootSummary(d);
    expect(summary).toContain(d.url);
    expect(summary).toContain("1 provider(s)");
    expect(summary).toContain("1 model(s)");
    expect(summary).not.toContain("sk-test");
  });

  it("counts only enabled providers", async () => {
    const d = await boot({ providers: [{ preset: "anthropic" }] });
    expect(bootSummary(d)).toContain("0 provider(s)");
  });
});
