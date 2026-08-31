/**
 * Moving a task's spending cap from the dashboard.
 *
 * The cap has been in `TaskSettings` since M5 and reachable only by editing the
 * config file and restarting the daemon — which is no use at all to someone
 * watching a task they started from Claude Code approach its ceiling. This route
 * is the control that closes that, and the tests below are about the one thing
 * that makes it more than a row write:
 *
 *  - `applied: true`  — a live session took the new cap, so what the task *will*
 *    spend changed.
 *  - `applied: false` — the row moved and nothing is executing under it. Real,
 *    but it is editing history, and a route that reported both the same way
 *    would be claiming the first when it had only done the second.
 *
 * The row is written on both paths, deliberately: unlike `cancel`, no stream is
 * racing to write it, and the log should read the same whether or not the daemon
 * happened to be running the task.
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
  workspacesDir = mkdtempSync(join(tmpdir(), "rewter-settings-"));
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

/** `hangWorker` parks the worker's upstream call, so a session stays live. */
function setup(initiator: StreamChunk[][], hangWorker = false): FakeAdapter {
  const initiatorAdapter = new FakeAdapter(initiator);
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

interface SettingsBody {
  task: Task;
  applied: boolean;
  error?: { message: string };
}

/** Through `inject` where no stream is involved — no socket, no port. */
async function setBudget(
  id: string,
  payload: unknown,
): Promise<{ status: number; body: SettingsBody }> {
  const res = await app.inject({
    method: "POST",
    url: `/internal/tasks/${id}/settings`,
    payload: payload as never,
  });
  return { status: res.statusCode, body: res.json() as SettingsBody };
}

/** A row with no live session behind it — a task a restart left running. */
function orphanTask(status: Task["status"] = "running", maxSpendUsd: number | null = null): TaskId {
  const id = newTaskId();
  repos.createTask({
    id,
    status: "pending",
    title: "an earlier task",
    initiatorModelId: ModelIdSchema.parse(BIG),
    projectId: null,
    conversationFingerprint: null,
    settings: TaskSettingsSchema.parse({ maxSpendUsd }),
    resultSummary: null,
    error: null,
    createdAt: CREATED_MS,
    updatedAt: CREATED_MS,
    finishedAt: null,
  });
  if (status !== "pending") {
    if (status !== "running") repos.transitionTask(id, "running");
    repos.transitionTask(id, status, status === "succeeded" ? { resultSummary: "did it" } : {});
  }
  return id;
}

describe("POST /internal/tasks/:id/settings", () => {
  it("hands a new cap to a task that is actually running", async () => {
    const worker = setup(
      [
        turn({
          name: "spawn_worker",
          args: { title: "the long thing", model: SMALL, instructions: "grind", tier: 1 },
        }),
        turn({ name: "wait", args: { mode: "all" } }),
        turn({ name: "finish", args: { answer: "done" } }),
      ],
      true,
    );
    const base = await listen();

    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto/orchestrator",
        messages: [{ role: "user", content: "do the long thing" }],
        stream: true,
        settings: { maxSpendUsd: 1 },
      }),
    });
    const taskId = chat.headers.get(TASK_ID_HEADER) as string;

    // Poll the adapter, not the clock: the session must genuinely exist before
    // the claim "a live session took it" means anything.
    for (let i = 0; i < 400 && worker.attempts === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(worker.attempts).toBe(1);

    const { status, body } = await setBudget(taskId, { maxSpendUsd: 5 });
    expect(status).toBe(200);
    // The distinction the route exists to report.
    expect(body.applied).toBe(true);
    expect(body.task.settings.maxSpendUsd).toBe(5);
    // And the other three are untouched — this is a budget call, not a settings
    // replacement.
    expect(body.task.settings.concurrency).toBe(TaskSettingsSchema.parse({}).concurrency);
    expect(body.task.settings.autoApprove).toBe(false);

    await fetch(`${base}/internal/tasks/${taskId}/cancel`, { method: "POST" });
    await chat.text();
  });

  it("writes the row for a task nothing is executing, and says so", async () => {
    setupIdle();
    const id = orphanTask("running", 1);

    const { status, body } = await setBudget(id, { maxSpendUsd: 9 });
    expect(status).toBe(200);
    // A restart left this row behind. Saving the cap is right; claiming a
    // running task changed course is not.
    expect(body.applied).toBe(false);
    expect(body.task.settings.maxSpendUsd).toBe(9);
    expect(repos.getTask(id)?.settings.maxSpendUsd).toBe(9);
  });

  it("removes a cap, which is not the same as a cap of zero", async () => {
    setupIdle();
    const id = orphanTask("running", 2);

    const cleared = await setBudget(id, { maxSpendUsd: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.task.settings.maxSpendUsd).toBeNull();

    // Zero would mean "may not spend", which no caller can have meant, and the
    // schema is the one place that rule lives.
    const zero = await setBudget(id, { maxSpendUsd: 0 });
    expect(zero.status).toBe(400);
    expect(repos.getTask(id)?.settings.maxSpendUsd).toBeNull();
  });

  it("rejects a missing field rather than reading it as uncapped", async () => {
    setupIdle();
    const id = orphanTask("running", 3);

    // `{}` and `{maxSpendUsd: null}` are different requests; treating the first
    // as the second would remove a cap nobody asked to remove.
    const { status } = await setBudget(id, {});
    expect(status).toBe(400);
    expect(repos.getTask(id)?.settings.maxSpendUsd).toBe(3);
  });

  it("rejects a non-numeric cap", async () => {
    setupIdle();
    const id = orphanTask("running", 3);

    const { status } = await setBudget(id, { maxSpendUsd: "five dollars" });
    expect(status).toBe(400);
    expect(repos.getTask(id)?.settings.maxSpendUsd).toBe(3);
  });

  it("409s a finished task, because the cap would be in force over nothing", async () => {
    setupIdle();
    const id = orphanTask("succeeded", 1);

    const { status, body } = await setBudget(id, { maxSpendUsd: 5 });
    expect(status).toBe(409);
    expect(body.error?.message).toBe("task is already succeeded");
    expect(body.applied).toBe(false);
    // Nothing written — a 200 here would read in the log as a budget that held.
    expect(repos.getTask(id)?.settings.maxSpendUsd).toBe(1);
  });

  it("404s an unknown task", async () => {
    setupIdle();
    const { status } = await setBudget(newTaskId(), { maxSpendUsd: 5 });
    expect(status).toBe(404);
  });

  it("emits a settings_changed event carrying both sides of the move", async () => {
    setupIdle();
    const id = orphanTask("running", 1);
    await setBudget(id, { maxSpendUsd: 7 });

    const payloads = bus.eventsAfter(0, id).map((e) => e.payload);
    const change = payloads.find((p) => p.type === "task.settings_changed");
    if (change?.type !== "task.settings_changed") throw new Error("no settings event");
    // `from` is what lets the dashboard render a diff rather than a restatement,
    // and what lets a reader of the log see what was raised *from*.
    expect(change.from.maxSpendUsd).toBe(1);
    expect(change.to.maxSpendUsd).toBe(7);
  });
});
