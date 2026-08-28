/**
 * Killing a task from the dashboard.
 *
 * The interesting thing about a kill is that the row write is *not* the route's
 * job. A live task's stream already ends with `transitionTask(…, "cancelled")`
 * and a line saying what was spent, so a route that also wrote the row would
 * race it — and because `cancelled` is terminal, the loser throws
 * `IllegalTransitionError` into a generator nobody is catching for.
 *
 * So the route has two paths and reports which one ran, and these tests assert
 * on that distinction rather than on "the status is cancelled", which is true in
 * both and therefore proves neither:
 *
 *  - live session → `aborted: true`, and the *stream* settles the row.
 *  - no session   → the route settles the row itself, `aborted: false`.
 *
 * The first case is the one worth a real orchestration: a stub that never opens
 * a stream cannot show that the abort reaches the workers and that the row is
 * written exactly once.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelIdSchema,
  type StreamChunk,
  type Task,
  type TaskId,
  TaskSettingsSchema,
  newTaskId,
} from "@rewter/shared";
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
import { TASK_ID_HEADER, buildApp } from "./app.js";

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
  workspacesDir = mkdtempSync(join(tmpdir(), "rewter-cancel-"));
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

/**
 * Build the app.
 *
 * `hangWorker` makes the worker's upstream call stay open until its signal
 * aborts — the only state in which a kill is distinguishable from a no-op. A
 * worker that had already reported would leave nothing to collapse, and the test
 * would pass against a `cancel()` that did nothing at all.
 */
function setup(initiator: StreamChunk[][], hangWorker = false): FakeAdapter {
  const initiatorAdapter = new FakeAdapter(initiator);
  // Empty script: with `hang` the call parks immediately, and in the tests that
  // do not hang no worker is ever spawned.
  const workerAdapter = new FakeAdapter([], { hang: hangWorker });
  const router = new Router({
    repos,
    createAdapter: (r) => (r.model.id === SMALL ? workerAdapter : initiatorAdapter),
    sleep: async () => undefined,
  });
  const orchestrator = new Orchestrator({ router, repos, bus, workspacesDir });
  live = new LiveTaskIndex();
  app = buildApp({
    router,
    repos,
    bus,
    orchestrator,
    live,
    clock: () => CREATED_MS,
    sse: { heartbeatMs: 0 },
  });
  return workerAdapter;
}

/** A setup for the row-only tests: no orchestration ever starts. */
const setupIdle = (): FakeAdapter => setup([turn({ name: "finish", args: { answer: "unused" } })]);

async function listen(): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

const HEADERS = { "content-type": "application/json" };

function postChat(base: string, payload: unknown): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(payload),
  });
}

function cancel(base: string, id: string): Promise<Response> {
  return fetch(`${base}/internal/tasks/${id}/cancel`, { method: "POST" });
}

async function bodyOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface CancelBody {
  task: Task;
  aborted: boolean;
  alreadyFinished: boolean;
}

const chat = {
  model: "auto/orchestrator",
  messages: [{ role: "user", content: "do the long thing" }],
  stream: true,
};

/** The visible text of an OpenAI SSE body. */
function feedOf(body: string): string {
  return body
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => block.slice("data: ".length))
    .filter((payload) => payload !== "[DONE]")
    .map((payload) => {
      const frame = JSON.parse(payload) as { choices: Array<{ delta: { content?: string } }> };
      return frame.choices[0]?.delta.content ?? "";
    })
    .join("");
}

/** A row with no live session behind it — a task a restart left running. */
function orphanTask(status: Task["status"] = "running"): TaskId {
  const id = newTaskId();
  repos.createTask({
    id,
    status: "pending",
    title: "an earlier task",
    initiatorModelId: ModelIdSchema.parse(BIG),
    conversationFingerprint: null,
    settings: TaskSettingsSchema.parse({}),
    resultSummary: null,
    error: null,
    createdAt: CREATED_MS,
    updatedAt: CREATED_MS,
    finishedAt: null,
  });
  // Walked through the real guards rather than written directly, so the fixture
  // cannot describe a task shape the state machine would never produce.
  if (status !== "pending") {
    if (status !== "running") repos.transitionTask(id, "running");
    repos.transitionTask(id, status, status === "succeeded" ? { resultSummary: "did it" } : {});
  }
  return id;
}

describe("POST /internal/tasks/:id/cancel", () => {
  it("collapses a live task and lets its own stream settle the row", async () => {
    const worker = setup(
      [
        turn({
          name: "spawn_worker",
          args: { title: "the long thing", model: SMALL, instructions: "grind", tier: 1 },
        }),
        turn({ name: "wait", args: { mode: "all" } }),
        turn({ name: "finish", args: { answer: "should never be reached" } }),
      ],
      true,
    );
    const base = await listen();

    const res = await postChat(base, chat);
    const taskId = res.headers.get(TASK_ID_HEADER) as string;
    expect(taskId).toMatch(/^task_/);

    // Wait until the worker's upstream call is genuinely open, so the abort has
    // something to cut. Polling the adapter, not the clock.
    for (let i = 0; i < 400 && worker.attempts === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(worker.attempts).toBe(1);

    const killed = await cancel(base, taskId);
    expect(killed.status).toBe(200);
    const body = await bodyOf<CancelBody>(killed);
    // The claim: a session was collapsed. Not "the row now reads cancelled" —
    // that happens a moment later, on the stream's own thread.
    expect(body.aborted).toBe(true);
    expect(body.alreadyFinished).toBe(false);

    const feed = feedOf(await res.text());
    // The stream reported the kill itself, with what it had spent.
    expect(feed).toContain("⊘ task cancelled");
    expect(feed).not.toContain("should never be reached");
    expect(repos.getTask(taskId)?.status).toBe("cancelled");
  });

  it("settles a row with no session behind it, and says no session was aborted", async () => {
    setupIdle();
    const base = await listen();
    const id = orphanTask("running");

    const res = await cancel(base, id);
    expect(res.status).toBe(200);
    const body = await bodyOf<CancelBody>(res);
    // Nothing was killed — the task predates this process. Claiming otherwise
    // would send a reader looking for a stream that does not exist.
    expect(body.aborted).toBe(false);
    expect(body.alreadyFinished).toBe(false);
    // But the row was a lie a restart left behind, so it is settled here.
    expect(body.task.status).toBe("cancelled");
    expect(repos.getTask(id)?.error).toBe("cancelled from the dashboard");
  });

  it("409s a task that has already finished", async () => {
    setupIdle();
    const base = await listen();
    const id = orphanTask("succeeded");

    const res = await cancel(base, id);
    expect(res.status).toBe(409);
    const body = await bodyOf<CancelBody & { error: { message: string } }>(res);
    expect(body.error.message).toBe("task is already succeeded");
    expect(body.alreadyFinished).toBe(true);
    // The verdict did not flip: a finished task stays finished.
    expect(repos.getTask(id)?.status).toBe("succeeded");
  });

  it("409s a second kill rather than throwing at the state machine", async () => {
    setupIdle();
    const base = await listen();
    const id = orphanTask("running");

    expect((await cancel(base, id)).status).toBe(200);
    // `cancelled → cancelled` is illegal, so the double-click has to be caught
    // before the repo sees it rather than surfacing as a 500.
    const again = await cancel(base, id);
    expect(again.status).toBe(409);
    expect((await bodyOf<{ error: { message: string } }>(again)).error.message).toBe(
      "task is already cancelled",
    );
  });

  it("404s an id it has never seen", async () => {
    setupIdle();
    const base = await listen();
    expect((await cancel(base, newTaskId())).status).toBe(404);
  });
});
