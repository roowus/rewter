/**
 * Harness runner tests, against a scripted fake session.
 *
 * The adapter has its own tests; these are about the runner's three edges and
 * the lifecycle. In order of what would hurt most if it broke:
 *
 *  - **The gate is real.** A denied spawn is a failed worker with the reason in
 *    its summary and no process ever created — the fake's spawn counter is the
 *    proof. Auto-approve and in-workspace short-circuit it exactly as tier 2's
 *    gate does, because it is the same gate object.
 *  - **The run always closes.** Success, harness-reported failure, fatal,
 *    abort-before-gate, abort mid-stream: each walked against a real in-memory
 *    database, because `WORKER_RUN_TRANSITIONS` has no shortcut edge and a
 *    path that skips the write throws in production.
 *  - **The inbox reaches the session, and decides when it ends.** A turn that
 *    was sent a follow-up must keep stdin open; a turn nothing was sent into
 *    must close it. The `end()` call count is the observable.
 *  - **Money is visible.** A turn that reports cost lands a CostRecord under
 *    the synthetic harness model id; a turn that reports nothing lands nothing
 *    (a zero row would read as "free").
 */
import {
  ModelIdSchema,
  type TaskId,
  TaskSettingsSchema,
  type WorkItem,
  newTaskId,
  newWorkItemId,
} from "@rewter/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import type { WorkerContext, WorkerRouter } from "../orchestrator/worker.js";
import { Approvals } from "../workers/approvals.js";
import { EventQueue } from "./claude-code.js";
import { HARNESS_COST_MODEL_ID, type HarnessRunnerOptions, runHarnessWorker } from "./runner.js";
import type { HarnessAdapter, HarnessEvent, HarnessSession, HarnessSpec } from "./types.js";

let db: Db;
let repos: Repos;
let bus: EventBus;
let tick: number;
let taskId: TaskId;
let autoApprove: boolean;
let approvals: Approvals;
let progress: string[];
/** Drained destructively by the runner, exactly like the engine's per-item inbox. */
let inboxMessages: string[];

beforeEach(() => {
  db = openDb(":memory:");
  tick = 1_756_252_800_000;
  const clock = () => ++tick;
  bus = new EventBus(db, clock);
  repos = new Repos(db, bus, clock);
  autoApprove = false;
  progress = [];
  inboxMessages = [];
  taskId = newTaskId();
  const now = ++tick;
  repos.createTask({
    id: taskId,
    status: "running",
    title: "tier 3",
    initiatorModelId: ModelIdSchema.parse("anthropic/claude-opus-5"),
    projectId: null,
    conversationFingerprint: null,
    settings: TaskSettingsSchema.parse({}),
    resultSummary: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  });
  approvals = new Approvals({ repos, taskId, autoApprove: () => autoApprove, clock });
});

let timers: NodeJS.Timeout[] = [];
afterEach(() => {
  for (const t of timers) clearInterval(t);
  timers = [];
});

/** Resolve whatever parks, whenever it parks — a user watching the dashboard. */
function autoResolve(approved: boolean, note?: string): void {
  const timer = setInterval(() => {
    for (const a of approvals.pending()) approvals.resolve(a.id, approved, "dashboard", note);
  }, 1);
  timers.push(timer);
}

interface FakeCalls {
  spawns: HarnessSpec[];
  sent: string[];
  ended: number;
  killed: number;
}

/**
 * A scripted harness. Events ride a real `EventQueue` so `kill()` genuinely
 * ends the stream — which is the only way the runner's abort path terminates.
 * `closeAfterScript: false` leaves the stream open (for the abort test).
 */
function fakeAdapter(
  script: HarnessEvent[],
  opts: { closeAfterScript?: boolean } = {},
): { adapter: HarnessAdapter; calls: FakeCalls } {
  const calls: FakeCalls = { spawns: [], sent: [], ended: 0, killed: 0 };
  const adapter: HarnessAdapter = {
    id: "fake",
    displayName: "Fake Harness",
    spawn(spec: HarnessSpec): HarnessSession {
      calls.spawns.push(spec);
      const queue = new EventQueue();
      for (const event of script) queue.push(event);
      if (opts.closeAfterScript !== false) queue.close();
      return {
        events: queue.events(),
        send: (m) => calls.sent.push(m),
        end: () => {
          calls.ended += 1;
          queue.close();
        },
        kill: () => {
          calls.killed += 1;
          queue.close();
        },
      };
    },
  };
  return { adapter, calls };
}

const turnEnd = (
  over: Partial<Extract<HarnessEvent, { type: "turn_end" }>> = {},
): HarnessEvent => ({
  type: "turn_end",
  resultText: "done",
  isError: false,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  ...over,
});

/** The runner never touches the router; the context just requires one. */
const NO_ROUTER = {
  complete: () => Promise.reject(new Error("the harness runner must not call the router")),
  resolve: () => {
    throw new Error("the harness runner must not resolve models");
  },
} as unknown as WorkerRouter;

function makeContext(over: { signal?: AbortSignal } = {}): WorkerContext & { workItem: WorkItem } {
  const now = ++tick;
  const workItem = repos.createWorkItem({
    id: newWorkItemId(),
    taskId,
    parentWorkItemId: null,
    status: "pending",
    title: "refactor the module",
    instructions: "refactor the module and report",
    modelId: HARNESS_COST_MODEL_ID,
    tier: 3,
    resultSummary: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  });
  return {
    workItem,
    taskId,
    router: NO_ROUTER,
    repos,
    clock: () => ++tick,
    signal: over.signal ?? new AbortController().signal,
    inbox: () => {
      const pending = inboxMessages;
      inboxMessages = [];
      return pending;
    },
  };
}

function options(
  adapter: HarnessAdapter,
  over: Partial<HarnessRunnerOptions> = {},
): HarnessRunnerOptions {
  return {
    adapter,
    approvals,
    cwd: "/tmp/ws/task",
    // In-workspace by default so the gate auto-approves and tests that are not
    // about the gate never park.
    cwdInWorkspace: true,
    onProgress: (note) => progress.push(note),
    ...over,
  };
}

describe("the happy path", () => {
  it("streams a session to success: lifecycle, session id, summary, progress", async () => {
    const { adapter, calls } = fakeAdapter([
      { type: "session", sessionId: "sess_42" },
      { type: "text", text: "reading the code" },
      { type: "tool_use", name: "Bash", detail: '{"command":"ls"}' },
      turnEnd({ resultText: "All refactored.\nSUMMARY: split the module in two" }),
    ]);
    const ctx = makeContext();

    const outcome = await runHarnessWorker(ctx, options(adapter));

    expect(outcome.status).toBe("succeeded");
    expect(outcome.summary).toBe("split the module in two");
    expect(outcome.fullText).toContain("All refactored.");
    expect(outcome.error).toBeNull();

    const run = repos.getWorkerRun(outcome.workerRunId);
    expect(run?.status).toBe("succeeded");
    expect(run?.harnessSessionId).toBe("sess_42");
    expect(run?.resultText).toContain("All refactored.");

    // The spawn got the instructions and the cwd, verbatim.
    expect(calls.spawns).toHaveLength(1);
    expect(calls.spawns[0]?.instructions).toBe("refactor the module and report");
    expect(calls.spawns[0]?.cwd).toBe("/tmp/ws/task");

    // A turn nothing was sent into ends the conversation.
    expect(calls.ended).toBe(1);

    expect(progress).toEqual(["reading the code", 'Bash {"command":"ls"}']);
  });

  it("falls back to the head of the result when there is no SUMMARY line", async () => {
    const { adapter } = fakeAdapter([turnEnd({ resultText: "just some prose about the work" })]);
    const outcome = await runHarnessWorker(makeContext(), options(adapter));
    expect(outcome.status).toBe("succeeded");
    expect(outcome.summary).toBe("just some prose about the work");
  });
});

describe("the gate", () => {
  it("asks once before spawning, and a denial is a failed worker with no process", async () => {
    const { adapter, calls } = fakeAdapter([turnEnd()]);
    autoResolve(false, "not on this machine");
    const ctx = makeContext();

    const outcome = await runHarnessWorker(
      ctx,
      options(adapter, { cwdInWorkspace: false, cwd: "/Users/x/projects/thing" }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("harness spawn refused");
    expect(outcome.summary).toContain("not on this machine");
    expect(calls.spawns).toHaveLength(0);
    expect(repos.getWorkerRun(outcome.workerRunId)?.status).toBe("failed");

    // The card named the harness and the directory — what the user approves.
    const approval = bus
      .eventsAfter(0, taskId)
      .map((e) => e.payload)
      .find((p) => p.type === "approval.requested");
    expect(approval?.type === "approval.requested" && approval.approval.summary).toBe(
      "run Fake Harness in /Users/x/projects/thing",
    );
    expect(approval?.type === "approval.requested" && approval.approval.kind).toBe("spawn_harness");
  });

  it("proceeds after an approval", async () => {
    const { adapter, calls } = fakeAdapter([turnEnd()]);
    autoResolve(true);

    const outcome = await runHarnessWorker(
      makeContext(),
      options(adapter, { cwdInWorkspace: false }),
    );

    expect(outcome.status).toBe("succeeded");
    expect(calls.spawns).toHaveLength(1);
  });

  it("auto-approves inside the workspace, logged but never parked", async () => {
    // No autoResolve running: if this parked, the test would hang and time out.
    const { adapter } = fakeAdapter([turnEnd()]);
    const outcome = await runHarnessWorker(makeContext(), options(adapter));
    expect(outcome.status).toBe("succeeded");

    const approval = bus
      .eventsAfter(0, taskId)
      .map((e) => e.payload)
      .find((p) => p.type === "approval.requested");
    expect(approval?.type === "approval.requested" && approval.approval.status).toBe(
      "auto_approved",
    );
  });
});

describe("failure paths", () => {
  it("a fatal event is a failed run carrying the adapter's error", async () => {
    const { adapter } = fakeAdapter([
      { type: "text", text: "starting" },
      { type: "fatal", error: "claude exited (code 1) without a result: Invalid API key" },
    ]);

    const outcome = await runHarnessWorker(makeContext(), options(adapter));

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("Invalid API key");
    expect(repos.getWorkerRun(outcome.workerRunId)?.status).toBe("failed");
  });

  it("a stream that ends without any result is failed, not silently succeeded", async () => {
    const { adapter } = fakeAdapter([{ type: "text", text: "then nothing" }]);
    const outcome = await runHarnessWorker(makeContext(), options(adapter));
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("exited without producing a result");
  });

  it("a 'successful' turn with no output is failed, not silently succeeded", async () => {
    // The live-smoke defect: a child whose upstream returned empty streams
    // still emits `result` with is_error:false and result:"" — and the task's
    // actual work was never done. An empty success is a failure.
    const { adapter } = fakeAdapter([turnEnd({ resultText: "  \n " })]);

    const outcome = await runHarnessWorker(makeContext(), options(adapter));

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("returned no output");
    expect(repos.getWorkerRun(outcome.workerRunId)?.status).toBe("failed");
  });

  it("a harness that says it failed is failed, with its text kept as the artifact", async () => {
    const { adapter } = fakeAdapter([
      turnEnd({ resultText: "I could not find the module you named.", isError: true }),
    ]);

    const outcome = await runHarnessWorker(makeContext(), options(adapter));

    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("could not find the module");
    expect(outcome.fullText).toBe("I could not find the module you named.");
    const run = repos.getWorkerRun(outcome.workerRunId);
    expect(run?.status).toBe("failed");
    expect(run?.resultText).toBe("I could not find the module you named.");
  });
});

describe("cancellation", () => {
  it("an abort before the gate closes the run without asking anyone", async () => {
    const { adapter, calls } = fakeAdapter([turnEnd()]);
    const controller = new AbortController();
    controller.abort();

    const outcome = await runHarnessWorker(
      makeContext({ signal: controller.signal }),
      options(adapter),
    );

    expect(outcome.status).toBe("cancelled");
    expect(calls.spawns).toHaveLength(0);
    expect(repos.getWorkerRun(outcome.workerRunId)?.status).toBe("cancelled");
  });

  it("an abort mid-stream kills the session and closes the run as cancelled", async () => {
    // The script never closes on its own — only kill() ends this stream, which
    // is exactly the claim under test.
    const { adapter, calls } = fakeAdapter([{ type: "text", text: "working…" }], {
      closeAfterScript: false,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const outcome = await runHarnessWorker(
      makeContext({ signal: controller.signal }),
      options(adapter),
    );

    expect(outcome.status).toBe("cancelled");
    expect(calls.killed).toBeGreaterThanOrEqual(1);
    expect(repos.getWorkerRun(outcome.workerRunId)?.status).toBe("cancelled");
  });
});

describe("the inbox", () => {
  it("forwards a queued message and keeps stdin open for the turn it starts", async () => {
    const { adapter, calls } = fakeAdapter([
      turnEnd({ resultText: "first turn done" }),
      turnEnd({ resultText: "follow-up handled.\nSUMMARY: applied the correction" }),
    ]);
    inboxMessages = ["actually, keep the old file name"];

    const outcome = await runHarnessWorker(makeContext(), options(adapter));

    expect(calls.sent).toEqual(["actually, keep the old file name"]);
    // end() only after the second turn — the one nothing was sent into. The
    // last turn's result wins.
    expect(calls.ended).toBe(1);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.summary).toBe("applied the correction");
  });
});

describe("money", () => {
  it("records a turn's cost under the synthetic harness model id", async () => {
    const { adapter } = fakeAdapter([
      turnEnd({
        costUsd: 0.37,
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 5000,
        cacheWriteTokens: 100,
      }),
    ]);

    const outcome = await runHarnessWorker(makeContext(), options(adapter));

    const costs = repos.listCosts(taskId);
    expect(costs).toHaveLength(1);
    const cost = costs[0];
    expect(cost?.modelId).toBe(HARNESS_COST_MODEL_ID);
    expect(cost?.costUsd).toBe(0.37);
    expect(cost?.inputTokens).toBe(1200);
    expect(cost?.outputTokens).toBe(300);
    expect(cost?.cacheReadTokens).toBe(5000);
    expect(cost?.cacheWriteTokens).toBe(100);
    expect(cost?.workerRunId).toBe(outcome.workerRunId);
    // The harness computed the cost; there is no per-token price to snapshot.
    expect(cost?.pricingSnapshot.inputPerMTok).toBeNull();
  });

  it("records nothing for a turn that reported nothing — a zero row would read as free", async () => {
    const { adapter } = fakeAdapter([turnEnd()]);
    await runHarnessWorker(makeContext(), options(adapter));
    expect(repos.listCosts(taskId)).toEqual([]);
  });
});
