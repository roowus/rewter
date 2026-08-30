/**
 * Starting an orchestration from the dashboard — survey shortlist item 7.
 *
 * Everything else on `/internal` reports on tasks that already exist. This one
 * makes one, and the tests below are about the three claims that separates it
 * from a thin wrapper over the chat route:
 *
 *  - **It answers before the task does.** A 202 with an id, not a result. The
 *    answer arrives as events, in the fold the dashboard already runs.
 *  - **The task outlives the request.** Registration with the `LiveTaskIndex`
 *    is what buys that — and, because the grace timer is started by the last
 *    *subscriber* leaving, a task with no subscriber at all is never on a
 *    clock. That is easy to state and easy to get wrong, so it is asserted by
 *    letting a run finish with nobody attached.
 *  - **It refuses a concrete model**, the mirror of `chat-test` refusing an
 *    orchestrator. Neither wants to be the other's cheap version.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTaskResult, StreamChunk, TaskId } from "@rewter/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { Orchestrator } from "../orchestrator/engine.js";
import { LiveTaskIndex } from "../orchestrator/live.js";
import { Router } from "../router/router.js";
import { FakeAdapter, end } from "../testing/fake-adapter.js";
import { PRV_A, model, provider } from "../testing/registry.js";
import { buildApp } from "./app.js";

const BIG = "anthropic/claude-opus-5";
const SMALL = "zai/glm-5.3";
const CREATED_MS = 1_756_252_800_000;

let db: Db;
let repos: Repos;
let bus: EventBus;
let app: FastifyInstance;
let live: LiveTaskIndex;
let workspacesDir: string;

beforeEach(() => {
  db = openDb(":memory:");
  let tick = CREATED_MS;
  bus = new EventBus(db, () => ++tick);
  repos = new Repos(db, bus, () => ++tick);
  repos.upsertProvider(provider());
  repos.upsertModel(model(BIG, PRV_A));
  repos.upsertModel(model(SMALL, PRV_A));
  workspacesDir = mkdtempSync(join(tmpdir(), "rewter-run-"));
});

afterEach(async () => {
  live?.shutdown();
  app?.server.closeAllConnections();
  await app?.close();
});

function turn(...calls: Array<{ name: string; args: unknown }>): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  calls.forEach((call, index) => {
    chunks.push({ type: "tool_call_start", index, id: `call_${index}`, name: call.name });
    chunks.push({ type: "tool_call_delta", index, argumentsDelta: JSON.stringify(call.args) });
  });
  chunks.push(end("tool_calls"));
  return chunks;
}

function setup(initiator: StreamChunk[][], opts: { orchestrator?: boolean } = {}): void {
  const initiatorAdapter = new FakeAdapter(initiator);
  const workerAdapter = new FakeAdapter([]);
  const router = new Router({
    repos,
    createAdapter: (r) => (r.model.id === SMALL ? workerAdapter : initiatorAdapter),
    sleep: async () => undefined,
  });
  live = new LiveTaskIndex();
  app = buildApp({
    router,
    repos,
    bus,
    // `null` is the build with no engine — the 501 branch.
    orchestrator:
      opts.orchestrator === false ? null : new Orchestrator({ router, repos, bus, workspacesDir }),
    live,
    clock: () => CREATED_MS,
    sse: { heartbeatMs: 0 },
  });
}

const answering = (answer = "the answer"): StreamChunk[][] => [
  turn({ name: "finish", args: { answer } }),
];

async function run(payload: unknown): Promise<{
  status: number;
  body: RunTaskResult & { error?: { message: string } };
}> {
  const res = await app.inject({ method: "POST", url: "/internal/run", payload: payload as never });
  return { status: res.statusCode, body: res.json() as RunTaskResult & never };
}

/** Wait for a task row to reach a terminal state, polling the database. */
async function settle(taskId: TaskId): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const status = repos.getTask(taskId)?.status ?? "pending";
    if (status === "succeeded" || status === "failed" || status === "cancelled") return status;
    await new Promise((r) => setTimeout(r, 5));
  }
  return repos.getTask(taskId)?.status ?? "pending";
}

describe("POST /internal/run", () => {
  it("returns an id before the task has produced anything", async () => {
    setup(answering());
    const { status, body } = await run({ prompt: "compare these three things" });

    // 202, not 200: accepted and started, with the outcome elsewhere. A 200
    // carrying an id would read as "here is your result".
    expect(status).toBe(202);
    expect(body.taskId).toMatch(/^task_/);
    // The row exists *now* — that is what makes the id usable immediately by
    // the kill and budget routes.
    const task = repos.getTask(body.taskId);
    expect(task?.status === "pending" || task?.status === "running").toBe(true);
  });

  it("titles the task from the prompt and names the model actually leading", async () => {
    setup(answering());
    const { body } = await run({ prompt: "compare these three things" });

    // Read back from the row, not echoed from the request: the title is the
    // engine's derivation and the initiator is the registry's answer.
    expect(body.title).toBe("compare these three things");
    expect(body.initiatorModelId).toBe(BIG);
  });

  it("runs to completion with nobody watching", async () => {
    // The claim registration exists for. No SSE stream is ever opened here, so
    // the task has zero subscribers for its whole life — and the disconnect
    // grace timer, which is started by the *last subscriber leaving*, never
    // starts. A task started from the dashboard is not on a 30-second clock.
    setup(answering("done without an audience"));
    const { body } = await run({ prompt: "do it quietly" });

    expect(await settle(body.taskId)).toBe("succeeded");
    expect(repos.getTask(body.taskId)?.resultSummary).toBe("done without an audience");
  });

  it("takes a budget for the run, since a run started on a whim is the one that wants one", async () => {
    setup(answering());
    const { body } = await run({
      prompt: "something open-ended",
      settings: { maxSpendUsd: 0.5, autoApprove: true },
    });

    const settings = repos.getTask(body.taskId)?.settings;
    expect(settings?.maxSpendUsd).toBe(0.5);
    expect(settings?.autoApprove).toBe(true);
    // Untouched fields keep the schema's default rather than becoming
    // `undefined` on the way through.
    expect(settings?.concurrency).toBe(4);
  });

  it("leaves an omitted setting to the daemon's configured default", async () => {
    // Not the same as sending the schema's value: the engine layers request
    // over configured over schema, and a form that posted `undefined` fields as
    // present would silently overwrite the daemon's configuration with the
    // schema's.
    const initiatorAdapter = new FakeAdapter(answering());
    const router = new Router({
      repos,
      createAdapter: () => initiatorAdapter,
      sleep: async () => undefined,
    });
    live = new LiveTaskIndex();
    app = buildApp({
      router,
      repos,
      bus,
      orchestrator: new Orchestrator({
        router,
        repos,
        bus,
        workspacesDir,
        defaultSettings: { concurrency: 2, maxSpendUsd: 9 },
      }),
      live,
      clock: () => CREATED_MS,
      sse: { heartbeatMs: 0 },
    });

    const { body } = await run({ prompt: "inherit the defaults", settings: { maxSpendUsd: 1 } });
    const settings = repos.getTask(body.taskId)?.settings;
    expect(settings?.maxSpendUsd).toBe(1);
    expect(settings?.concurrency).toBe(2);
  });

  it("can be killed by id the moment it comes back", async () => {
    // The id is a real handle, not a receipt: the whole point of returning
    // early is that the other task routes work on it straight away.
    setup([
      turn({
        name: "spawn_worker",
        args: { title: "grind", model: SMALL, instructions: "grind", tier: 1 },
      }),
      turn({ name: "wait", args: { mode: "all" } }),
      turn({ name: "finish", args: { answer: "unreached" } }),
    ]);
    const { body } = await run({ prompt: "start something long" });

    const kill = await app.inject({
      method: "POST",
      url: `/internal/tasks/${body.taskId}/cancel`,
    });
    expect(kill.statusCode).toBe(200);
    expect(await settle(body.taskId)).toBe("cancelled");
  });

  it("refuses a concrete model, pointing at the tester that wants one", async () => {
    setup(answering());
    const { status, body } = await run({ prompt: "hello", model: BIG });

    expect(status).toBe(400);
    expect(body.error?.message).toContain("auto/orchestrator");
    expect(body.error?.message).toContain("chat tester");
  });

  it("accepts a pinned initiator", async () => {
    setup(answering());
    const { status, body } = await run({
      prompt: "use the small one to lead",
      model: `auto/orchestrator:${SMALL}`,
    });

    expect(status).toBe(202);
    expect(body.initiatorModelId).toBe(SMALL);
  });

  it("reports a pin naming a model that does not exist, rather than starting", async () => {
    setup(answering());
    const before = repos.listUnfinishedTasks().length;
    const { status } = await run({
      prompt: "lead with a ghost",
      model: "auto/orchestrator:nobody/nothing",
    });

    // The eager half of `start` throws before the generator, which is the only
    // window in which a status code is still available — and the status is the
    // registry's own 404 for a name it does not know, the same one the chat
    // routes give, rather than a second vocabulary for the same mistake. And
    // nothing was written: a refused run leaves no row behind to explain.
    expect(status).toBe(404);
    expect(repos.listUnfinishedTasks().length).toBe(before);
  });

  it("rejects an empty prompt without inventing a task", async () => {
    setup(answering());
    const { status, body } = await run({ prompt: "   " });
    expect(status).toBe(400);
    expect(body.error?.message).toContain("prompt");
  });

  it("rejects a zero budget, because zero is not the way to say uncapped", async () => {
    setup(answering());
    const { status } = await run({ prompt: "hello", settings: { maxSpendUsd: 0 } });
    expect(status).toBe(400);
  });

  it("answers 501 on a build with no engine", async () => {
    setup(answering(), { orchestrator: false });
    const { status } = await run({ prompt: "hello" });
    expect(status).toBe(501);
  });
});
