/**
 * Approving a gated action from outside the worker that asked for it.
 *
 * The unit tests in `workers/approvals.test.ts` prove the gate; `steering.test.ts`
 * proves the parser. What is only provable here is the *reconciliation*: an
 * approval is a row in SQLite **and** a promise a worker is parked on, and only
 * one of those two is reachable from an HTTP request. Resolving the row alone
 * looks exactly like success while leaving the worker hung forever, so these
 * tests run a real tier-2 worker — no stub runner — and assert that the command
 * actually ran, on disk, after the approval came in over the wire.
 *
 * That is also why `runWorker` is left unset throughout. `Session.runnerFor`
 * returns an injected runner for *every* tier, so a test that stubs the worker
 * never opens a workspace, never builds a gate, and would assert against a
 * `null` that always agrees with it.
 *
 * Three ways in, one resolution path:
 *
 *  - `POST /internal/approvals/:id` — the dashboard's buttons, and `curl`.
 *  - `approve <id>` as the next user turn — the client that has only a
 *    conversation to talk through.
 *  - The gate's own `resolveAll`, reached by `deny all`.
 *
 * A denial is the more interesting half. It must come back to the model as a
 * tool *result* carrying the user's note, because a worker told "use the fixture
 * instead" adapts and a worker handed an exception does not.
 */
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Approval,
  ModelIdSchema,
  type StreamChunk,
  type TaskId,
  TaskSettingsSchema,
  newApprovalId,
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
/** The worker's adapter, so a test can read what came back as a tool result. */
let workerAdapter: FakeAdapter;

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
  // The priciest tools-capable model leads by default, so BIG is the initiator
  // and SMALL is what it will be scripted to spend on workers.
  repos.upsertModel(model(BIG, PRV_A, { pricing: price(15, 75) }));
  repos.upsertModel(model(SMALL, PRV_A, { pricing: price(0.6, 2.2) }));
  workspacesDir = mkdtempSync(join(tmpdir(), "rewter-approvals-"));
});

afterEach(async () => {
  live?.shutdown();
  app?.server.closeAllConnections();
  await app?.close();
});

/** One turn as chunks: tool calls, then the finish reason a provider really sends. */
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
 * Build the app around two scripts: one for the initiator, one for the worker.
 *
 * Split by model rather than sharing one `FakeAdapter`, because the two loops
 * interleave — the worker's first turn happens between the initiator's first and
 * second — and a single script would be asserting on that interleaving rather
 * than on approvals.
 */
function setup(initiator: StreamChunk[][], worker: StreamChunk[][]): void {
  const initiatorAdapter = new FakeAdapter(initiator);
  workerAdapter = new FakeAdapter(worker);
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
}

/** Spawn one tier-2 worker, wait for it, answer. `tier` defaults to 1, so say it. */
function initiatorScript(answer = "done"): StreamChunk[][] {
  return [
    turn({
      name: "spawn_worker",
      args: { title: "run the thing", model: SMALL, instructions: "run it", tier: 2 },
    }),
    turn({ name: "wait", args: { mode: "all" } }),
    turn({ name: "finish", args: { answer } }),
  ];
}

/**
 * A worker that shells out, then reports.
 *
 * `echo` is deliberately not on the read-only allowlist and the redirection
 * would forfeit it anyway, so this is a command that must be asked about — and
 * one whose effect is visible on disk afterwards.
 */
const SHELL_COMMAND = "echo ran > ran.txt";

function workerScript(summary: string): StreamChunk[][] {
  return [
    turn({ name: "shell", args: { command: SHELL_COMMAND } }),
    turn({ name: "finish_report", args: { status: "success", summary } }),
  ];
}

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

const conversation = [{ role: "user", content: "run the thing for me" }];

const chat = (over: Record<string, unknown> = {}) => ({
  model: "auto/orchestrator",
  messages: conversation,
  stream: true,
  ...over,
});

interface ListedApproval extends Approval {
  parked: boolean;
}

/** `Response.json()` is `unknown` by design; every caller here knows its shape. */
async function bodyOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function listApprovals(base: string, taskId: string): Promise<ListedApproval[]> {
  const res = await fetch(`${base}/internal/approvals?taskId=${taskId}`);
  return (await bodyOf<{ approvals: ListedApproval[] }>(res)).approvals;
}

/**
 * Wait for the worker to park.
 *
 * Polling rather than a hook: the worker's first turn happens on its own
 * schedule inside the engine's limiter, and the whole scenario under test is a
 * user reacting to a card that has appeared.
 */
async function waitForApproval(base: string, taskId: string): Promise<ListedApproval> {
  for (let i = 0; i < 400; i++) {
    const [first] = await listApprovals(base, taskId);
    if (first !== undefined) return first;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("no approval was ever requested");
}

function resolveOverHttp(
  base: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${base}/internal/approvals/${id}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
}

/** The visible text of an OpenAI SSE body — what the user actually reads. */
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

/** Every tool result the worker was handed back, across all its turns. */
function toolResultsSeen(): string[] {
  return workerAdapter.requests.flatMap((req) =>
    req.messages.filter((m) => m.role === "tool").map((m) => m.content ?? ""),
  );
}

/** Did the shell command actually run? The workspace is realpath'd on the way in. */
function ranFileExists(taskId: string): boolean {
  return existsSync(join(realpathSync(workspacesDir), taskId, "ran.txt"));
}

describe("POST /internal/approvals/:id", () => {
  it("releases the parked worker, and the command actually runs", async () => {
    setup(initiatorScript("all done"), workerScript("ran it"));
    const base = await listen();

    const res = await postChat(base, chat());
    const taskId = res.headers.get(TASK_ID_HEADER) as string;
    expect(taskId).toMatch(/^task_/);

    const card = await waitForApproval(base, taskId);
    expect(card.kind).toBe("shell");
    // The user reads the command itself, not a category.
    expect(card.summary).toBe(SHELL_COMMAND);
    // A worker in *this* process is genuinely waiting on it.
    expect(card.parked).toBe(true);
    expect(ranFileExists(taskId)).toBe(false);

    const approved = await resolveOverHttp(base, card.id, { approved: true });
    expect(approved.status).toBe(200);
    const payload = await bodyOf<{
      approval: { status: string; resolvedBy: string };
      resumedWorker: boolean;
    }>(approved);
    expect(payload.approval.status).toBe("approved");
    expect(payload.approval.resolvedBy).toBe("dashboard");
    // The claim that matters: a worker was released, not just a row updated.
    expect(payload.resumedWorker).toBe(true);

    const feed = feedOf(await res.text());
    expect(feed).toContain("✔ [w1] done");
    expect(feed).toContain("all done");
    // Classify, then ask, then act — the effect exists only after the approval.
    expect(ranFileExists(taskId)).toBe(true);
    expect(toolResultsSeen().join("\n")).toContain("exit code: 0");
  });

  it("hands a denial back to the worker as a result carrying the note", async () => {
    setup(initiatorScript("could not"), workerScript("the command was refused"));
    const base = await listen();

    const res = await postChat(base, chat());
    const taskId = res.headers.get(TASK_ID_HEADER) as string;
    const card = await waitForApproval(base, taskId);

    const denied = await resolveOverHttp(base, card.id, {
      approved: false,
      note: "use the test fixture instead",
    });
    expect(denied.status).toBe(200);
    expect((await bodyOf<{ approval: { status: string } }>(denied)).approval.status).toBe("denied");

    await res.text();
    // The note is the useful half: bare "denied" invites the identical retry.
    expect(toolResultsSeen()).toContain(
      "command not run: denied by the user: use the test fixture instead",
    );
    // And nothing happened on disk, which is the only claim a gate really makes.
    expect(ranFileExists(taskId)).toBe(false);
  });

  it("lists a pending approval with the command and the task it belongs to", async () => {
    setup(initiatorScript(), workerScript("ran it"));
    const base = await listen();
    const res = await postChat(base, chat());
    const taskId = res.headers.get(TASK_ID_HEADER) as string;

    const card = await waitForApproval(base, taskId);
    expect(card).toMatchObject({ taskId, status: "pending", kind: "shell" });
    // Grouped under the worker that asked, so the dashboard can say who wants it.
    expect(card.workItemId).toMatch(/^wi_/);
    expect(card.workerRunId).toMatch(/^run_/);

    await resolveOverHttp(base, card.id, { approved: true });
    await res.text();
    // Settled rows leave the pending list.
    expect(await listApprovals(base, taskId)).toHaveLength(0);
  });
});

describe("POST /internal/approvals/:id — refusals", () => {
  /** A settled-able row with no session behind it: a task that has finished. */
  function orphanRow(): { taskId: TaskId; id: string } {
    const taskId = newTaskId();
    const now = CREATED_MS;
    repos.createTask({
      id: taskId,
      status: "running",
      title: "an earlier task",
      initiatorModelId: ModelIdSchema.parse(BIG),
      conversationFingerprint: null,
      settings: TaskSettingsSchema.parse({}),
      resultSummary: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    });
    const approval = repos.createApproval({
      id: newApprovalId(),
      taskId,
      workItemId: null,
      workerRunId: null,
      status: "pending",
      kind: "shell",
      summary: "rm -rf node_modules",
      detail: null,
      resolvedBy: null,
      resolutionNote: null,
      createdAt: now,
      resolvedAt: null,
    });
    return { taskId, id: approval.id };
  }

  it("settles a row nobody is parked on, and says so", async () => {
    setup(initiatorScript(), workerScript("ran it"));
    const base = await listen();
    const { id } = orphanRow();

    const res = await resolveOverHttp(base, id, { approved: true, note: "fine" });
    expect(res.status).toBe(200);
    // The audit trail is the durable half and is resolved either way; claiming a
    // worker resumed when none did would send a reader looking for one.
    expect(await bodyOf<{ resumedWorker: boolean }>(res)).toMatchObject({ resumedWorker: false });
    expect(repos.getApproval(id)?.status).toBe("approved");
    expect(repos.getApproval(id)?.resolutionNote).toBe("fine");
  });

  it("409s a second resolution — a race lost, not a mistake made", async () => {
    setup(initiatorScript(), workerScript("ran it"));
    const base = await listen();
    const { id } = orphanRow();

    expect((await resolveOverHttp(base, id, { approved: true })).status).toBe(200);
    const again = await resolveOverHttp(base, id, { approved: false });
    expect(again.status).toBe(409);
    expect((await bodyOf<{ error: { message: string } }>(again)).error.message).toBe(
      "already approved",
    );
    // And the verdict did not flip.
    expect(repos.getApproval(id)?.status).toBe("approved");
  });

  it("404s an id it has never seen", async () => {
    setup(initiatorScript(), workerScript("ran it"));
    const base = await listen();
    const res = await resolveOverHttp(base, newApprovalId(), { approved: true });
    expect(res.status).toBe(404);
  });

  it("400s a body that does not say yes or no", async () => {
    setup(initiatorScript(), workerScript("ran it"));
    const base = await listen();
    const { id } = orphanRow();

    expect((await resolveOverHttp(base, id, {})).status).toBe(400);
    expect((await resolveOverHttp(base, id, { approved: "yes" })).status).toBe(400);
    expect((await resolveOverHttp(base, id, { approved: true, note: 7 })).status).toBe(400);
    // Rejected before anything was written.
    expect(repos.getApproval(id)?.status).toBe("pending");
  });
});

describe("in-band approve/deny", () => {
  /** The follow-up turn an OpenAI client sends to reply to a running task. */
  function followUp(reply: string): Record<string, unknown> {
    return chat({
      messages: [
        ...conversation,
        { role: "assistant", content: "waiting on you" },
        { role: "user", content: reply },
      ],
    });
  }

  it("approves from the conversation, the same as the dashboard button", async () => {
    setup(initiatorScript("all done"), workerScript("ran it"));
    const base = await listen();

    const first = await postChat(base, chat());
    const taskId = first.headers.get(TASK_ID_HEADER) as string;
    const card = await waitForApproval(base, taskId);

    const second = await postChat(base, followUp(`approve ${card.id}`));
    // Steering, not a second orchestration: the same task, the same stream.
    expect(second.headers.get(TASK_ID_HEADER)).toBe(taskId);

    const [firstBody] = await Promise.all([first.text(), second.text()]);
    expect(ranFileExists(taskId)).toBe(true);
    expect(repos.getApproval(card.id)?.resolvedBy).toBe("in_band");
    expect(feedOf(firstBody)).toContain("all done");
  });

  it("keeps the command and the instruction in one message apart", async () => {
    setup(initiatorScript("all done"), workerScript("ran it"));
    const base = await listen();

    const first = await postChat(base, chat());
    const taskId = first.headers.get(TASK_ID_HEADER) as string;
    const card = await waitForApproval(base, taskId);

    const second = await postChat(
      base,
      followUp(`approve ${card.id}\nthen move on to the integration tests`),
    );
    const [firstBody] = await Promise.all([first.text(), second.text()]);
    const feed = feedOf(firstBody);

    // The remainder reached the initiator…
    expect(feed).toContain("steering: then move on to the integration tests");
    // …and the line that resolved the approval was not *also* read as
    // instruction. Matched against the steering line rather than the whole feed,
    // which quotes `approve <id>` back at the user in the approval prompt.
    expect(feed).not.toContain("steering: approve");
    expect(repos.getApproval(card.id)?.status).toBe("approved");
  });

  it("denies with a note the worker can act on", async () => {
    setup(initiatorScript("could not"), workerScript("the command was refused"));
    const base = await listen();

    const first = await postChat(base, chat());
    const taskId = first.headers.get(TASK_ID_HEADER) as string;
    const card = await waitForApproval(base, taskId);

    const second = await postChat(base, followUp(`deny ${card.id}: use the fixture instead`));
    await Promise.all([first.text(), second.text()]);

    expect(repos.getApproval(card.id)?.status).toBe("denied");
    expect(toolResultsSeen()).toContain(
      "command not run: denied by the user: use the fixture instead",
    );
    expect(ranFileExists(taskId)).toBe(false);
  });

  it("scopes 'deny all' to the conversation it was typed into", async () => {
    setup(initiatorScript("could not"), workerScript("the command was refused"));
    const base = await listen();

    const first = await postChat(base, chat());
    const taskId = first.headers.get(TASK_ID_HEADER) as string;
    await waitForApproval(base, taskId);

    // Another task's pending card, which this reply must not touch.
    const otherTask = newTaskId();
    repos.createTask({
      id: otherTask,
      status: "running",
      title: "someone else's task",
      initiatorModelId: ModelIdSchema.parse(BIG),
      conversationFingerprint: null,
      settings: TaskSettingsSchema.parse({}),
      resultSummary: null,
      error: null,
      createdAt: CREATED_MS,
      updatedAt: CREATED_MS,
      finishedAt: null,
    });
    const other = repos.createApproval({
      id: newApprovalId(),
      taskId: otherTask,
      workItemId: null,
      workerRunId: null,
      status: "pending",
      kind: "shell",
      summary: "rm -rf elsewhere",
      detail: null,
      resolvedBy: null,
      resolutionNote: null,
      createdAt: CREATED_MS,
      resolvedAt: null,
    });

    const second = await postChat(base, followUp("deny all: not right now"));
    await Promise.all([first.text(), second.text()]);

    expect(await listApprovals(base, taskId)).toHaveLength(0);
    // "approve all" typed into one conversation must not clear another's cards.
    expect(repos.getApproval(other.id)?.status).toBe("pending");
    expect(ranFileExists(taskId)).toBe(false);
  });

  it("leaves prose that merely mentions approving as steering", async () => {
    setup(initiatorScript("all done"), workerScript("ran it"));
    const base = await listen();

    const first = await postChat(base, chat());
    const taskId = first.headers.get(TASK_ID_HEADER) as string;
    const card = await waitForApproval(base, taskId);

    const second = await postChat(base, followUp("please approve whatever you think is right"));
    // Nothing was consumed, so the card is still up and the worker still parked.
    expect(repos.getApproval(card.id)?.status).toBe("pending");

    const [firstBody] = await Promise.all([
      (async () => {
        // Release it the ordinary way so the task can finish and the test end.
        await resolveOverHttp(base, card.id, { approved: true });
        return first.text();
      })(),
      second.text(),
    ]);
    expect(feedOf(firstBody)).toContain("steering: please approve whatever you think is right");
  });
});
