/**
 * Steering a task by its id — `POST /internal/tasks/:id/steer`.
 *
 * `app.orchestrator.test.ts` proves the conversational door (re-POST the
 * transcript, the daemon matches it back); these prove the direct one, which is
 * what the `rewt` TUI uses — it holds the task id, so injection is exact, not
 * inferred from a fingerprint. The claims that are only provable here:
 *
 *  - a message lands in the *running* task's queue and reaches the initiator
 *    (the durable proof is `steering.received` on the event log, appended by
 *    the engine at injection time, not by the route);
 *  - `approve apr_…` typed into the steer body resolves the approval through
 *    the same gate the dashboard buttons use — one grammar, two doors;
 *  - there is no row-only fallback: a task with no live session is a 409,
 *    because a queued message with nobody to drain it is a message to nobody.
 *
 * Steering tests need a real socket: `app.inject()` serializes in-flight
 * streams, so the steer POST would only dispatch after the task had finished —
 * and a finished task is not a task you can steer.
 *
 * The live tests hold the task open with a *parked worker runner* (released by
 * the test), not a cancel: injection happens at the initiator's next turn
 * boundary, and a cancelled task never reaches one.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelIdSchema,
  type SteerTaskResult,
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
import type { WorkerOutcome, WorkerRunner } from "../orchestrator/worker.js";
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

/** A full pricing block — `model()` spreads shallowly, so partials would drop fields. */
const price = (inputPerMTok: number, outputPerMTok: number) => ({
  inputPerMTok,
  outputPerMTok,
  cacheReadPerMTok: inputPerMTok / 10,
  cacheWritePerMTok: inputPerMTok * 1.25,
});

beforeEach(() => {
  db = openDb(":memory:");
  let tick = CREATED_MS;
  const clock = (): number => ++tick;
  bus = new EventBus(db, clock);
  repos = new Repos(db, bus, clock);
  repos.upsertProvider(provider());
  repos.upsertModel(model(BIG, PRV_A, { pricing: price(15, 75) }));
  repos.upsertModel(model(SMALL, PRV_A, { pricing: price(0.6, 2.2) }));
  workspacesDir = mkdtempSync(join(tmpdir(), "rewter-steer-"));
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

const outcome = (over: Partial<WorkerOutcome> = {}): WorkerOutcome => ({
  status: "succeeded",
  summary: "did the thing",
  fullText: "did the thing, at length",
  error: null,
  workerRunId: "run_stub" as WorkerOutcome["workerRunId"],
  durationMs: 5,
  ...over,
});

/** A worker the test can hold open — the initiator stays parked on `wait`. */
function parkedWorker(): { runner: WorkerRunner; release: () => void; started: Promise<void> } {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let markStarted!: () => void;
  const started = new Promise<void>((r) => {
    markStarted = r;
  });
  const runner: WorkerRunner = async () => {
    markStarted();
    await gate;
    return outcome();
  };
  return { runner, release, started };
}

/**
 * Build the app around a scripted initiator. `runWorker` intercepts spawns
 * (tier-1 tests); leave it unset and pass `worker` scripts instead to run the
 * real tier dispatcher — the only path that builds an approval gate.
 */
function setup(
  initiator: StreamChunk[][],
  opts: { runWorker?: WorkerRunner; worker?: StreamChunk[][] } = {},
): void {
  const initiatorAdapter = new FakeAdapter(initiator);
  const workerAdapter = new FakeAdapter(opts.worker ?? []);
  const router = new Router({
    repos,
    createAdapter: (r) => (r.model.id === SMALL ? workerAdapter : initiatorAdapter),
    sleep: async () => undefined,
  });
  const orchestrator = new Orchestrator({
    router,
    repos,
    bus,
    workspacesDir,
    ...(opts.runWorker ? { runWorker: opts.runWorker } : {}),
  });
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
}

/** Spawn one tier-1 worker and wait on it — parked until the test releases it. */
function parkedScript(): StreamChunk[][] {
  return [
    turn({
      name: "spawn_worker",
      args: { title: "the long thing", model: SMALL, instructions: "grind" },
    }),
    turn({ name: "wait", args: { mode: "all" } }),
    turn({ name: "finish", args: { answer: "done" } }),
  ];
}

async function listen(): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

const HEADERS = { "content-type": "application/json" };

/** Start a live task over a real socket and return its id plus the response. */
async function startTask(base: string): Promise<{ taskId: string; chat: Response }> {
  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      model: "auto/orchestrator",
      messages: [{ role: "user", content: "do the long thing" }],
      stream: true,
    }),
  });
  return { taskId: chat.headers.get(TASK_ID_HEADER) as string, chat };
}

/** The visible text of an OpenAI SSE body — what the user actually reads. */
function feedOf(body: string): string {
  return body
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && !block.includes("[DONE]"))
    .map((block) => {
      const frame = JSON.parse(block.slice("data: ".length)) as {
        choices: Array<{ delta: { content?: string } }>;
      };
      return frame.choices[0]?.delta.content ?? "";
    })
    .join("");
}

interface SteerBody extends SteerTaskResult {
  error?: { message: string };
}

async function steer(
  base: string,
  id: string,
  payload: unknown,
): Promise<{ status: number; body: SteerBody }> {
  const res = await fetch(`${base}/internal/tasks/${id}/steer`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as SteerBody };
}

/** A row with no live session behind it — a task a restart left running. */
function orphanTask(status: Task["status"] = "running"): TaskId {
  const id = newTaskId();
  repos.createTask({
    id,
    status: "pending",
    title: "an earlier task",
    initiatorModelId: ModelIdSchema.parse(BIG),
    projectId: null,
    conversationFingerprint: null,
    settings: TaskSettingsSchema.parse({}),
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

describe("POST /internal/tasks/:id/steer", () => {
  it("queues a message into the running task, and the engine injects it", async () => {
    const parked = parkedWorker();
    setup(parkedScript(), { runWorker: parked.runner });
    const base = await listen();
    const { taskId, chat } = await startTask(base);
    await parked.started;

    const { status, body } = await steer(base, taskId, { message: "focus on the third one" });
    expect(status).toBe(202);
    expect(body).toMatchObject({
      taskId,
      queued: true,
      remainder: "focus on the third one",
      approvals: 0,
    });

    // The response says "queued"; the log says "landed". Release the worker so
    // the initiator reaches its next turn boundary, where injection happens.
    parked.release();
    const feed = feedOf(await chat.text());
    expect(feed).toContain("focus on the third one");
    expect(feed).toContain("done");
    const steered = bus
      .eventsAfter(0)
      .filter((e) => e.payload.type === "steering.received")
      .map((e) => (e.payload as { text: string }).text);
    expect(steered).toEqual(["focus on the third one"]);
  });

  it("routes an approval command through the gate, not to the initiator", async () => {
    // A real tier-2 worker that shells out: the command is not on the read-only
    // allowlist, so the run parks on a pending approval the test can act on.
    setup(
      [
        turn({
          name: "spawn_worker",
          args: { title: "run it", model: SMALL, instructions: "run it", tier: 2 },
        }),
        turn({ name: "wait", args: { mode: "all" } }),
        turn({ name: "finish", args: { answer: "done" } }),
      ],
      {
        worker: [
          turn({ name: "shell", args: { command: "echo ran > ran.txt" } }),
          turn({ name: "finish_report", args: { status: "success", summary: "ran it" } }),
        ],
      },
    );
    const base = await listen();
    const { taskId, chat } = await startTask(base);

    // Wait for the approval card the shell call raises.
    let pending = repos.listPendingApprovals(taskId);
    for (let i = 0; i < 400 && pending.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
      pending = repos.listPendingApprovals(taskId);
    }
    expect(pending).toHaveLength(1);
    const card = pending[0] as (typeof pending)[number];

    const { status, body } = await steer(base, taskId, {
      message: `approve ${card.id}: go ahead`,
    });
    expect(status).toBe(202);
    // The whole message was a command — nothing left for the initiator.
    expect(body).toMatchObject({ queued: false, remainder: "", approvals: 1 });

    const feed = feedOf(await chat.text());
    expect(feed).toContain("done");
    const row = repos.getApproval(card.id);
    expect(row?.status).toBe("approved");
    expect(row?.resolvedBy).toBe("in_band");
    expect(row?.resolutionNote).toBe("go ahead");
    // And no steering event: a consumed command line never reaches the initiator.
    expect(bus.eventsAfter(0).some((e) => e.payload.type === "steering.received")).toBe(false);
  });

  it("splits a mixed message: commands to the gate, the rest to the queue", async () => {
    const parked = parkedWorker();
    setup(parkedScript(), { runWorker: parked.runner });
    const base = await listen();
    const { taskId, chat } = await startTask(base);
    await parked.started;

    // No pending approvals exist — the command is applied against an empty set,
    // which is a quiet no-op by design; the split itself is what is under test.
    const { status, body } = await steer(base, taskId, {
      message: "approve all\nthen write the summary in French",
    });
    expect(status).toBe(202);
    expect(body).toMatchObject({
      queued: true,
      remainder: "then write the summary in French",
      approvals: 1,
    });

    parked.release();
    const feed = feedOf(await chat.text());
    expect(feed).toContain("then write the summary in French");
    expect(feed).not.toContain("approve all");
  });

  it("400s an empty or missing message without touching the task", async () => {
    const parked = parkedWorker();
    setup(parkedScript(), { runWorker: parked.runner });
    const base = await listen();
    const { taskId, chat } = await startTask(base);
    await parked.started;

    expect((await steer(base, taskId, {})).status).toBe(400);
    expect((await steer(base, taskId, { message: "  \n " })).status).toBe(400);
    expect((await steer(base, taskId, { message: 42 })).status).toBe(400);

    parked.release();
    const feed = feedOf(await chat.text());
    expect(bus.eventsAfter(0).some((e) => e.payload.type === "steering.received")).toBe(false);
    expect(feed).toContain("done");
  });

  it("409s a task with no live session — a queued message to nobody is a lie", async () => {
    setup([turn({ name: "finish", args: { answer: "unused" } })]);
    const base = await listen();
    const id = orphanTask("running");

    const { status, body } = await steer(base, id, { message: "hello?" });
    expect(status).toBe(409);
    expect(body.error?.message).toContain("no live session");
  });

  it("409s a finished task, and says finished rather than missing", async () => {
    setup([turn({ name: "finish", args: { answer: "unused" } })]);
    const base = await listen();
    const id = orphanTask("succeeded");

    const { status, body } = await steer(base, id, { message: "one more thing" });
    expect(status).toBe(409);
    expect(body.error?.message).toBe("task is already succeeded");
  });

  it("404s an unknown task id", async () => {
    setup([turn({ name: "finish", args: { answer: "unused" } })]);
    const base = await listen();

    const { status } = await steer(base, newTaskId(), { message: "anyone home?" });
    expect(status).toBe(404);
  });
});
