/**
 * Tier-2 loop tests.
 *
 * The tools already have their own tests against a real directory, so these are
 * about the *loop*: what it does with a model that misbehaves, and whether the
 * lifecycle survives every exit. The properties, in the order they matter:
 *
 *  - **The run always closes.** `WORKER_RUN_TRANSITIONS` has no shortcut edge,
 *    so a path that returns without transitioning throws at the repo write and
 *    takes the task down. Every exit here is walked against a real in-memory
 *    database: report, prose fallback, turn exhaustion, provider throw, error
 *    finish, pre-abort and mid-flight abort.
 *  - **A denied call is asked about once.** The whole point of remembering
 *    denials is that a model which ignores the prompt and retries does not put
 *    the same card in front of the user again. The test counts approvals, because
 *    counting is the only way to see the difference.
 *  - **Nothing throws.** Malformed arguments, an invented tool, a bad report —
 *    all of them have to come back as a turn the model can answer.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChatResponse,
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
import type { RouteRequest } from "../router/router.js";
import { model } from "../testing/registry.js";
import { Approvals } from "./approvals.js";
import { type Tier2Options, createTier2Runner, runTier2Worker } from "./tier2.js";
import { type Workspace, openWorkspace } from "./workspace.js";

const MODEL_ID = "anthropic/claude-sonnet-5";

let db: Db;
let repos: Repos;
let bus: EventBus;
let tick: number;
let callSeq: number;
let taskId: TaskId;
let autoApprove: boolean;
let approvals: Approvals;
let workspace: Workspace;
/** Where a task pointed at "a real project" works. Outside the zone by design. */
let project: string;
let progress: string[];

beforeEach(() => {
  db = openDb(":memory:");
  tick = 1_756_252_800_000;
  callSeq = 0;
  const clock = () => ++tick;
  bus = new EventBus(db, clock);
  repos = new Repos(db, bus, clock);
  autoApprove = false;
  progress = [];
  taskId = newTaskId();
  const now = ++tick;
  repos.createTask({
    id: taskId,
    status: "running",
    title: "tier 2",
    initiatorModelId: ModelIdSchema.parse(MODEL_ID),
    conversationFingerprint: null,
    settings: TaskSettingsSchema.parse({}),
    resultSummary: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  });

  const base = mkdtempSync(join(tmpdir(), "rewter-t2-"));
  project = mkdtempSync(join(tmpdir(), "rewter-t2-project-"));
  workspace = openWorkspace({ taskId, baseDir: base });
  approvals = new Approvals({ repos, taskId, autoApprove: () => autoApprove, clock });
});

/** A tool call as a provider would deliver it: arguments are a raw JSON string. */
function toolCall(name: string, args: unknown, id = `c${++callSeq}`): ChatResponse {
  return {
    message: {
      role: "assistant",
      content: null,
      toolCalls: [{ id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) }],
    },
    finishReason: "tool_calls",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

function prose(content: string): ChatResponse {
  return {
    message: { role: "assistant", content },
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

const report = (
  status: "success" | "failure" | "partial",
  summary: string,
  extra: { details?: string; artifacts?: string[] } = {},
): ChatResponse => toolCall("finish_report", { status, summary, ...extra });

/**
 * A router that plays a script, one reply per turn.
 *
 * The recorded `messages` matter as much as the replies: the loop's contract with
 * the model is that a tool result comes back as a `role: "tool"` turn, and the
 * only way to see that is to look at what the next call was given.
 */
function scriptedRouter(
  script: ChatResponse[],
): WorkerRouter & { requests: RouteRequest[]; turns: number } {
  const requests: RouteRequest[] = [];
  let turns = 0;
  const router = {
    requests,
    get turns() {
      return turns;
    },
    async complete(req: RouteRequest) {
      // Copied, not kept: the loop grows one `messages` array in place and hands
      // the same reference over every turn, so storing the request as-is would
      // make every recorded turn alias the final state — and an assertion about
      // "what the model was told at turn 2" would silently be about turn 9.
      requests.push({ ...req, messages: [...req.messages] });
      const next = script[turns++];
      if (next === undefined) throw new Error(`script exhausted at turn ${turns}`);
      return next;
    },
    resolve: () => ({ model: model(MODEL_ID) }),
  };
  return router as WorkerRouter & { requests: RouteRequest[]; turns: number };
}

function makeContext(
  router: WorkerRouter,
  over: { instructions?: string; signal?: AbortSignal } = {},
): WorkerContext & { workItem: WorkItem } {
  const now = ++tick;
  const workItem = repos.createWorkItem({
    id: newWorkItemId(),
    taskId,
    parentWorkItemId: null,
    status: "pending",
    title: "count things",
    instructions: over.instructions ?? "count the TODOs and report",
    modelId: ModelIdSchema.parse(MODEL_ID),
    tier: 2,
    resultSummary: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  });
  return {
    workItem,
    taskId,
    router,
    repos,
    clock: () => ++tick,
    signal: over.signal ?? new AbortController().signal,
  };
}

function options(over: Partial<Tier2Options> = {}): Tier2Options {
  return {
    workspace,
    approvals,
    onProgress: (note) => progress.push(note),
    ...over,
  };
}

/**
 * Stand in for a user watching the dashboard: resolve whatever parks, whenever it
 * parks. A one-shot `setTimeout` would be a race in any test where a second call
 * parks after the first resolution, which is exactly the retry cases below.
 */
function autoResolve(approved: boolean, note?: string): void {
  const timer = setInterval(() => {
    for (const a of approvals.pending()) approvals.resolve(a.id, approved, "dashboard", note);
  }, 1);
  timers.push(timer);
}

let timers: NodeJS.Timeout[] = [];
afterEach(() => {
  for (const t of timers) clearInterval(t);
  timers = [];
});

/**
 * How many distinct approval cards this task produced.
 *
 * Counted off the event log rather than the pending list, because the question is
 * how many times the *user was asked* — and by the time a test looks, every one of
 * them has been resolved and is no longer pending.
 */
function timesAsked(): number {
  return bus
    .eventsAfter(0, taskId)
    .filter(
      (e) => e.payload.type === "approval.requested" && e.payload.approval.status === "pending",
    ).length;
}

describe("the happy path", () => {
  it("runs tools, then closes on finish_report with the report as the full text", async () => {
    writeFileSync(join(workspace.root, "notes.txt"), "one\nTODO: two\n");
    const router = scriptedRouter([
      toolCall("read_file", { path: "notes.txt" }),
      report("success", "one TODO, on line 2", { details: "line 2: TODO: two" }),
    ]);
    const ctx = makeContext(router);

    const outcome = await runTier2Worker(ctx, options());

    expect(outcome.status).toBe("succeeded");
    expect(outcome.summary).toBe("one TODO, on line 2");
    expect(outcome.fullText).toContain("status: success");
    expect(outcome.fullText).toContain("line 2: TODO: two");
    expect(outcome.error).toBeNull();

    const run = repos.getWorkerRun(outcome.workerRunId);
    expect(run?.status).toBe("succeeded");
    expect(run?.resultText).toContain("one TODO, on line 2");
    expect(run?.tier).toBe(2);
  });

  it("feeds each tool result back as a tool turn addressed to its call", async () => {
    writeFileSync(join(workspace.root, "a.txt"), "hello\n");
    const router = scriptedRouter([
      toolCall("read_file", { path: "a.txt" }, "call_1"),
      report("success", "read it"),
    ]);

    await runTier2Worker(makeContext(router), options());

    // The second request is the one that shows what the model was told.
    const second = router.requests[1]?.messages ?? [];
    const toolTurn = second.find((m) => m.role === "tool");
    expect(toolTurn?.toolCallId).toBe("call_1");
    expect(toolTurn?.name).toBe("read_file");
    expect(toolTurn?.content).toContain("hello");
    // And the assistant turn that asked for it has to be there, or a provider
    // rejects the tool turn as unsolicited.
    expect(second.some((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0)).toBe(true);
  });

  it("declares the tools on every turn, and never the orchestrator's", async () => {
    const router = scriptedRouter([report("success", "nothing to do")]);
    await runTier2Worker(makeContext(router), options());

    const names = (router.requests[0]?.tools ?? []).map((t) => t.name);
    expect(names).toContain("shell");
    expect(names).toContain("finish_report");
    expect(names).not.toContain("spawn_worker");
  });

  it("puts the workspace in the prompt so relative paths mean something", async () => {
    const router = scriptedRouter([report("success", "ok")]);
    await runTier2Worker(makeContext(router), options());

    const system = router.requests[0]?.messages[0];
    expect(system?.role).toBe("system");
    expect(router.requests[0]?.messages[1]?.content).toContain(workspace.cwd);
  });

  it("routes a report_progress note to the user's feed and keeps going", async () => {
    const router = scriptedRouter([
      toolCall("report_progress", { note: "cloning the repo" }),
      report("success", "done"),
    ]);

    const outcome = await runTier2Worker(makeContext(router), options());

    expect(progress).toEqual(["cloning the repo"]);
    expect(outcome.status).toBe("succeeded");
  });

  it("lists the files it wrote as artifacts, and only the ones that landed", async () => {
    const router = scriptedRouter([
      toolCall("write_file", { path: "out.txt", content: "x" }),
      report("success", "wrote it"),
    ]);

    const outcome = await runTier2Worker(makeContext(router), options());

    expect(outcome.fullText).toContain("out.txt");
    expect(readFileSync(join(workspace.root, "out.txt"), "utf8")).toBe("x");
  });

  it("executes several calls from one turn in order", async () => {
    // Providers routinely return two calls in one message; dropping the second
    // would silently lose work.
    const router = scriptedRouter([
      {
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "a",
              name: "write_file",
              arguments: JSON.stringify({ path: "1.txt", content: "1" }),
            },
            {
              id: "b",
              name: "write_file",
              arguments: JSON.stringify({ path: "2.txt", content: "2" }),
            },
          ],
        },
        finishReason: "tool_calls",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      report("success", "wrote both"),
    ]);

    await runTier2Worker(makeContext(router), options());

    expect(readFileSync(join(workspace.root, "1.txt"), "utf8")).toBe("1");
    expect(readFileSync(join(workspace.root, "2.txt"), "utf8")).toBe("2");
  });
});

describe("report statuses", () => {
  it("treats a failure report as a failed run without losing the reason", async () => {
    const router = scriptedRouter([report("failure", "the repo has no test script")]);

    const outcome = await runTier2Worker(makeContext(router), options());

    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("the repo has no test script");
    expect(outcome.error).toBe("the repo has no test script");
    // The report text is still worth keeping: it says what was tried.
    expect(repos.getWorkerRun(outcome.workerRunId)?.resultText).toContain("status: failure");
    expect(repos.getWorkerRun(outcome.workerRunId)?.status).toBe("failed");
  });

  it("counts a partial report as a success, but labels it", async () => {
    // The initiator can use two of three findings; calling that a failure would
    // throw away work the user paid for.
    const router = scriptedRouter([report("partial", "found two of three configs")]);

    const outcome = await runTier2Worker(makeContext(router), options());

    expect(outcome.status).toBe("succeeded");
    expect(outcome.summary.startsWith("partial:")).toBe(true);
    expect(outcome.summary).toContain("found two of three configs");
    expect(outcome.error).toBeNull();
  });

  it("lets the model refile a malformed report rather than losing the run", async () => {
    const router = scriptedRouter([
      toolCall("finish_report", { status: "done", summary: "x" }),
      report("success", "second attempt"),
    ]);

    const outcome = await runTier2Worker(makeContext(router), options());

    expect(outcome.status).toBe("succeeded");
    expect(outcome.summary).toBe("second attempt");
    const retryTurn = router.requests[1]?.messages.find((m) => m.role === "tool");
    expect(retryTurn?.content).toContain("invalid arguments for finish_report");
  });
});

describe("a model that will not use the tools", () => {
  it("nudges prose once", async () => {
    const router = scriptedRouter([
      prose("I think there are two TODOs."),
      report("success", "two"),
    ]);

    const outcome = await runTier2Worker(makeContext(router), options());

    expect(outcome.status).toBe("succeeded");
    const nudge = router.requests[1]?.messages.at(-1);
    expect(nudge?.role).toBe("user");
    expect(nudge?.content).toContain("finish_report");
  });

  it("takes the prose as the report on the second refusal rather than failing", async () => {
    // The work is probably done and already billed; discarding it would be the
    // expensive choice.
    const router = scriptedRouter([prose("first pass"), prose("There are two TODOs.")]);

    const outcome = await runTier2Worker(makeContext(router), options());

    expect(outcome.status).toBe("succeeded");
    expect(outcome.summary).toContain("no report filed");
    expect(outcome.summary).toContain("There are two TODOs.");
    expect(repos.getWorkerRun(outcome.workerRunId)?.status).toBe("succeeded");
  });

  it("fails the run when it never files a report and never says anything", async () => {
    const router = scriptedRouter([
      toolCall("list_dir", { path: "." }),
      toolCall("list_dir", { path: "." }),
      toolCall("list_dir", { path: "." }),
    ]);

    const outcome = await runTier2Worker(makeContext(router), options({ maxTurns: 3 }));

    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("3 turns");
    expect(outcome.error).toContain("no finish_report");
    expect(repos.getWorkerRun(outcome.workerRunId)?.status).toBe("failed");
    // Exactly the turn budget, not one more.
    expect(router.turns).toBe(3);
  });
});

describe("bad tool calls come back as turns", () => {
  it("names the offending field instead of throwing", async () => {
    const router = scriptedRouter([
      toolCall("read_file", { path: 42 }),
      report("success", "recovered"),
    ]);

    const outcome = await runTier2Worker(makeContext(router), options());

    expect(outcome.status).toBe("succeeded");
    expect(router.requests[1]?.messages.find((m) => m.role === "tool")?.content).toContain("path");
  });

  it("lists the real tools when the model invents one", async () => {
    const router = scriptedRouter([
      toolCall("bash", { cmd: "ls" }),
      report("success", "recovered"),
    ]);

    await runTier2Worker(makeContext(router), options());

    const told = router.requests[1]?.messages.find((m) => m.role === "tool")?.content ?? "";
    expect(told).toContain('no such tool "bash"');
    expect(told).toContain("shell");
  });

  it("survives arguments that are not JSON at all", async () => {
    const router = scriptedRouter([
      toolCall("read_file", '{"path": "unterminated'),
      report("success", "recovered"),
    ]);

    const outcome = await runTier2Worker(makeContext(router), options());

    expect(outcome.status).toBe("succeeded");
    expect(router.requests[1]?.messages.find((m) => m.role === "tool")?.content).toContain(
      "not valid JSON",
    );
  });
});

describe("approvals", () => {
  it("asks once for a gated write and proceeds when approved", async () => {
    const outside = join(project, "out.txt");
    const router = scriptedRouter([
      toolCall("write_file", { path: outside, content: "hi" }),
      report("success", "wrote it"),
    ]);
    autoResolve(true);

    const outcome = await runTier2Worker(makeContext(router), options());

    expect(outcome.status).toBe("succeeded");
    expect(readFileSync(outside, "utf8")).toBe("hi");
    expect(timesAsked()).toBe(1);
  });

  it("hands the denial reason to the model, which can then adapt", async () => {
    const outside = join(project, "nope.txt");
    const router = scriptedRouter([
      toolCall("write_file", { path: outside, content: "hi" }),
      toolCall("write_file", { path: "fixture.txt", content: "hi" }),
      report("partial", "wrote to the fixture instead"),
    ]);
    autoResolve(false, "use the test fixture instead");

    const outcome = await runTier2Worker(makeContext(router), options());

    expect(outcome.status).toBe("succeeded");
    const told = router.requests[1]?.messages.find((m) => m.role === "tool")?.content ?? "";
    expect(told).toContain("use the test fixture instead");
    expect(readFileSync(join(workspace.root, "fixture.txt"), "utf8")).toBe("hi");
  });

  it("does not ask the user twice about the identical denied call", async () => {
    // The prompt says do not retry; prompts are advisory. Asking again would
    // train the user to click through the gate.
    const outside = join(project, "nope.txt");
    const call = toolCall("write_file", { path: outside, content: "hi" }, "same");
    const router = scriptedRouter([call, call, report("failure", "could not write")]);
    autoResolve(false, "no");

    const outcome = await runTier2Worker(makeContext(router), options());

    expect(outcome.status).toBe("failed");
    expect(timesAsked()).toBe(1);
    const second = router.requests[2]?.messages.filter((m) => m.role === "tool").at(-1);
    expect(second?.content).toContain("already tried this exact call");
    // The remembered answer still carries the user's note, not just a refusal.
    expect(second?.content).toContain("no");
  });

  it("still asks when the retry differs, since that is a different request", async () => {
    const first = toolCall("write_file", { path: join(project, "a.txt"), content: "1" }, "x1");
    const second = toolCall("write_file", { path: join(project, "b.txt"), content: "2" }, "x2");
    const router = scriptedRouter([first, second, report("failure", "both refused")]);
    autoResolve(false, "no");

    await runTier2Worker(makeContext(router), options());

    expect(timesAsked()).toBe(2);
  });

  it("needs no approval at all inside the workspace", async () => {
    // Nothing resolves approvals here: if this parked, the test would time out.
    const router = scriptedRouter([
      toolCall("write_file", { path: "in.txt", content: "x" }),
      report("success", "ok"),
    ]);

    const outcome = await runTier2Worker(makeContext(router), options());

    expect(outcome.status).toBe("succeeded");
    expect(timesAsked()).toBe(0);
    expect(approvals.pending()).toHaveLength(0);
  });
});

describe("provider failure and cancellation", () => {
  it("closes the run as failed when the provider throws", async () => {
    const router: WorkerRouter = {
      async complete() {
        throw new Error("upstream 500");
      },
      resolve: () => ({ model: model(MODEL_ID) }),
    };

    const outcome = await runTier2Worker(makeContext(router), options());

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("upstream 500");
    expect(repos.getWorkerRun(outcome.workerRunId)?.status).toBe("failed");
  });

  it("treats an error finish reason as a failure, not an empty success", async () => {
    const router = scriptedRouter([
      {
        message: { role: "assistant", content: "context length exceeded" },
        finishReason: "error",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);

    const outcome = await runTier2Worker(makeContext(router), options());

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("context length exceeded");
  });

  it("stops at a truncated turn instead of burning the turn budget on it", async () => {
    // A tool call cut off at the ceiling arrives with unclosed JSON, which the
    // loop answers as "malformed arguments" — so the model retries the same
    // too-long call until the turns run out and the run dies naming the turn
    // budget. The ceiling is the cause and the only actionable part, so the run
    // ends here, on the first truncated turn, saying so.
    const truncated: ChatResponse = {
      message: { role: "assistant", content: "I'll start by reading the fi" },
      finishReason: "length",
      usage: { inputTokens: 10, outputTokens: 4000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    const router = scriptedRouter([truncated, report("success", "unreachable")]);

    const outcome = await runTier2Worker(makeContext(router), options());

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("truncated");
    expect(outcome.error).toContain("turn 1");
    expect(outcome.error).toContain("4000-token");
    // One turn, not sixteen: the script's second reply is never reached.
    expect(router.turns).toBe(1);
    // Whatever it managed to say is kept — the initiator can still read it.
    expect(outcome.fullText).toBe("I'll start by reading the fi");
    expect(repos.getWorkerRun(outcome.workerRunId)?.status).toBe("failed");
  });

  it("reports the ceiling actually in force, not the default", async () => {
    const router = scriptedRouter([
      {
        message: { role: "assistant", content: "" },
        finishReason: "length",
        usage: { inputTokens: 10, outputTokens: 512, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);

    const outcome = await runTier2Worker(makeContext(router), options({ maxTokens: 512 }));

    expect(outcome.error).toContain("512-token");
    expect(outcome.error).not.toContain("4000");
    expect(outcome.fullText).toBeNull();
  });

  it("counts a truncation during an abort as cancelled, not failed", async () => {
    // Same rule as a throw: what the user did outranks what the model did.
    const controller = new AbortController();
    const router: WorkerRouter = {
      async complete() {
        controller.abort();
        return {
          message: { role: "assistant", content: "partial" },
          finishReason: "length",
          usage: { inputTokens: 10, outputTokens: 4000, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
      resolve: () => ({ model: model(MODEL_ID) }),
    };

    const outcome = await runTier2Worker(
      makeContext(router, { signal: controller.signal }),
      options(),
    );

    expect(outcome.status).toBe("cancelled");
    expect(repos.getWorkerRun(outcome.workerRunId)?.status).toBe("cancelled");
  });

  it("closes the run when cancelled before it starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const router = scriptedRouter([report("success", "never runs")]);

    const outcome = await runTier2Worker(
      makeContext(router, { signal: controller.signal }),
      options(),
    );

    expect(outcome.status).toBe("cancelled");
    expect(repos.getWorkerRun(outcome.workerRunId)?.status).toBe("cancelled");
    expect(router.turns).toBe(0);
  });

  it("stops between turns when cancelled mid-flight", async () => {
    const controller = new AbortController();
    const router: WorkerRouter = {
      async complete() {
        controller.abort();
        return toolCall("list_dir", { path: "." });
      },
      resolve: () => ({ model: model(MODEL_ID) }),
    };

    const outcome = await runTier2Worker(
      makeContext(router, { signal: controller.signal }),
      options(),
    );

    expect(outcome.status).toBe("cancelled");
    expect(repos.getWorkerRun(outcome.workerRunId)?.status).toBe("cancelled");
  });
});

describe("mid-run messages from the orchestrator", () => {
  /** A queue that drains destructively, exactly as the engine's inbox does. */
  function inboxOf(...messages: string[]): { inbox: () => string[]; drains: number } {
    const queue = [...messages];
    const state = {
      drains: 0,
      inbox: (): string[] => {
        state.drains += 1;
        return queue.splice(0);
      },
    };
    return state;
  }

  it("delivers a queued message at the next turn, marked as the orchestrator's", async () => {
    const router = scriptedRouter([
      toolCall("list_dir", { path: "." }),
      report("success", "did it the new way"),
    ]);
    const { inbox } = inboxOf("stop counting TODOs; count FIXMEs instead");

    const outcome = await runTier2Worker({ ...makeContext(router), inbox }, options());

    expect(outcome.status).toBe("succeeded");
    // Turn 2 is the one that sees it: the message is queued before the run, but a
    // drain mid-turn would leave the model an unanswered tool call.
    const second = router.requests[1]?.messages ?? [];
    const injected = second.filter((m) => (m.content ?? "").startsWith("[FROM THE ORCHESTRATOR]"));
    expect(injected).toHaveLength(1);
    expect(injected[0]?.role).toBe("user");
    expect(injected[0]?.content).toContain("count FIXMEs instead");
  });

  it("does not deliver the same message twice, however many turns follow", async () => {
    const router = scriptedRouter([
      toolCall("list_dir", { path: "." }),
      toolCall("list_dir", { path: "." }),
      report("success", "done"),
    ]);
    const { inbox } = inboxOf("use the fixture");

    await runTier2Worker({ ...makeContext(router), inbox }, options());

    // A message re-read every turn is a worker nagged, and the nag grows the
    // transcript it is billed for on each pass.
    const last = router.requests[2]?.messages ?? [];
    expect(last.filter((m) => (m.content ?? "").includes("use the fixture"))).toHaveLength(1);
  });

  it("delivers several queued messages in the order they were sent", async () => {
    const router = scriptedRouter([toolCall("list_dir", { path: "." }), report("success", "ok")]);
    const { inbox } = inboxOf("first", "second");

    await runTier2Worker({ ...makeContext(router), inbox }, options());

    const injected = (router.requests[1]?.messages ?? [])
      .map((m) => m.content ?? "")
      .filter((c) => c.startsWith("[FROM THE ORCHESTRATOR]"));
    expect(injected).toEqual(["[FROM THE ORCHESTRATOR] first", "[FROM THE ORCHESTRATOR] second"]);
  });

  it("asks the inbox on every turn, so a message sent mid-run still lands", async () => {
    // The engine can post to a worker at any moment, including after it has
    // started. A loop that drained once at the top would deliver nothing.
    const router = scriptedRouter([
      toolCall("list_dir", { path: "." }),
      toolCall("list_dir", { path: "." }),
      report("success", "ok"),
    ]);
    const state = inboxOf();

    await runTier2Worker({ ...makeContext(router), inbox: state.inbox }, options());

    expect(state.drains).toBe(3);
  });

  it("runs unchanged with no inbox at all, since tier 1 never provides one", async () => {
    const router = scriptedRouter([report("success", "ok")]);

    const outcome = await runTier2Worker(makeContext(router), options());

    expect(outcome.status).toBe("succeeded");
  });
});

describe("createTier2Runner", () => {
  it("produces a WorkerRunner the engine can call with nothing extra", async () => {
    // The whole reason the factory exists: workspace and approvals are per-task,
    // `WorkerRunner` is per-work-item, and the engine only has the latter.
    const runner = createTier2Runner(options());
    const router = scriptedRouter([report("success", "ok")]);

    const outcome = await runner(makeContext(router));

    expect(outcome.status).toBe("succeeded");
    expect(outcome.summary).toBe("ok");
  });
});
