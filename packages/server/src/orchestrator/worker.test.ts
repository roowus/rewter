/**
 * Tier-1 worker tests.
 *
 * Two things here are worth a test and the rest follows from them:
 *
 *  - Every exit path writes the lifecycle. `WORKER_RUN_TRANSITIONS` has no
 *    `created → succeeded` edge, so a path that forgets `streaming` throws at the
 *    repo write and takes the whole task down. These tests walk all five exits
 *    (pre-aborted, throw, error-finish, success, mid-flight abort) against a real
 *    in-memory database, so a missing transition fails here rather than in
 *    production.
 *  - `splitSummary` scans from the *end*. A worker summarizing a document that
 *    itself contains "SUMMARY:" would otherwise hand back a line of its own input.
 */
import {
  type ChatResponse,
  ModelIdSchema,
  type TaskId,
  TaskSettingsSchema,
  type WorkItem,
  newTaskId,
  newWorkItemId,
} from "@rewter/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import type { RouteRequest } from "../router/router.js";
import { model } from "../testing/registry.js";
import { type WorkerContext, type WorkerRouter, runTier1Worker, splitSummary } from "./worker.js";

const MODEL_ID = "anthropic/claude-sonnet-5";

let db: Db;
let repos: Repos;
let tick: number;

beforeEach(() => {
  db = openDb(":memory:");
  tick = 1_756_252_800_000;
  const clock = () => ++tick;
  repos = new Repos(db, new EventBus(db, clock), clock);
});

/** A router stub that answers with whatever the test hands it. */
function stubRouter(
  respond: (req: RouteRequest, signal?: AbortSignal) => Promise<ChatResponse>,
): WorkerRouter & { requests: RouteRequest[] } {
  const requests: RouteRequest[] = [];
  return {
    requests,
    async complete(req, signal) {
      requests.push(req);
      return respond(req, signal);
    },
    resolve: () => ({ model: model(MODEL_ID) }),
  };
}

function reply(
  content: string | null,
  finishReason: ChatResponse["finishReason"] = "stop",
): ChatResponse {
  return {
    message: { role: "assistant", content },
    finishReason,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

function makeContext(
  router: WorkerRouter,
  over: { instructions?: string; signal?: AbortSignal } = {},
): WorkerContext & { taskId: TaskId; workItem: WorkItem } {
  const taskId = newTaskId();
  const now = ++tick;
  repos.createTask({
    id: taskId,
    status: "pending",
    title: "worker lifecycle",
    initiatorModelId: ModelIdSchema.parse(MODEL_ID),
    conversationFingerprint: null,
    settings: TaskSettingsSchema.parse({}),
    resultSummary: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  });
  const workItem = repos.createWorkItem({
    id: newWorkItemId(),
    taskId,
    parentWorkItemId: null,
    status: "pending",
    title: "summarize",
    instructions: over.instructions ?? "summarize the thing",
    modelId: ModelIdSchema.parse(MODEL_ID),
    tier: 1,
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

describe("runTier1Worker", () => {
  it("records the run as succeeded with the full text, and reports the SUMMARY line", async () => {
    const router = stubRouter(async () =>
      reply("The changelog adds two flags.\n\nSUMMARY: two new flags."),
    );
    const ctx = makeContext(router);

    const outcome = await runTier1Worker(ctx);

    expect(outcome.status).toBe("succeeded");
    expect(outcome.summary).toBe("two new flags.");
    expect(outcome.fullText).toContain("The changelog adds two flags.");
    expect(outcome.error).toBeNull();
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);

    const run = repos.getWorkerRun(outcome.workerRunId);
    expect(run?.status).toBe("succeeded");
    // The full text stays in the row; only the one-liner travels back to the initiator.
    expect(run?.resultText).toContain("SUMMARY: two new flags.");
    expect(run?.tier).toBe(1);
    expect(run?.attempt).toBe(1);
  });

  it("sends the work item's instructions and a token ceiling to the router", async () => {
    const router = stubRouter(async () => reply("ok\nSUMMARY: ok."));
    const ctx = makeContext(router, { instructions: "count the vowels in 'orchestrator'" });

    const outcome = await runTier1Worker(ctx);

    const req = router.requests[0];
    expect(req?.model).toBe(MODEL_ID);
    expect(JSON.stringify(req?.messages)).toContain("count the vowels");
    expect(req?.maxTokens).toBeGreaterThan(0);
    // Cost attribution needs both ids, or the spend is unattributable to a worker.
    expect(req?.taskId).toBe(ctx.taskId);
    expect(req?.workerRunId).toBe(outcome.workerRunId);
  });

  it("falls back to the head of the body when the worker ignores the SUMMARY convention", async () => {
    const router = stubRouter(async () => reply("Just prose, no sign-off line at all."));
    const outcome = await runTier1Worker(makeContext(router));

    expect(outcome.status).toBe("succeeded");
    expect(outcome.summary).toBe("Just prose, no sign-off line at all.");
  });

  it("still yields a readable summary when the model returns nothing", async () => {
    const router = stubRouter(async () => reply(""));
    const outcome = await runTier1Worker(makeContext(router));

    expect(outcome.status).toBe("succeeded");
    // Not the empty string — the initiator has to be able to read this.
    expect(outcome.summary).toBe("(the worker returned nothing)");
  });

  it("closes out a run that was cancelled before the call began", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const router = stubRouter(async () => {
      throw new Error("the router must not be called");
    });

    const outcome = await runTier1Worker(makeContext(router, { signal: aborted.signal }));

    expect(outcome.status).toBe("cancelled");
    expect(router.requests).toHaveLength(0);
    // The lifecycle is written even on the path that never ran, or the task waits forever.
    expect(repos.getWorkerRun(outcome.workerRunId)?.status).toBe("cancelled");
  });

  it("turns a thrown provider error into a failed run rather than propagating it", async () => {
    const router = stubRouter(async () => {
      throw new Error("socket hang up");
    });

    const outcome = await runTier1Worker(makeContext(router));

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toBe("socket hang up");
    expect(outcome.summary).toContain("socket hang up");
    expect(outcome.fullText).toBeNull();
    const run = repos.getWorkerRun(outcome.workerRunId);
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("socket hang up");
  });

  it("counts a throw during an abort as cancelled, not failed", async () => {
    // The router aborts by throwing, so "did it fail or was it killed?" is only
    // answerable from the signal — and the two mean different things to the user.
    const controller = new AbortController();
    const router = stubRouter(async () => {
      controller.abort();
      throw new Error("aborted");
    });

    const outcome = await runTier1Worker(makeContext(router, { signal: controller.signal }));

    expect(outcome.status).toBe("cancelled");
    expect(repos.getWorkerRun(outcome.workerRunId)?.status).toBe("cancelled");
  });

  it("treats an error finish reason as a failure even though nothing threw", async () => {
    // The router normalizes upstream failures into a finish reason, so success is
    // not the absence of an exception.
    const router = stubRouter(async () => reply("429 rate limited", "error"));

    const outcome = await runTier1Worker(makeContext(router));

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toBe("429 rate limited");
    expect(repos.getWorkerRun(outcome.workerRunId)?.status).toBe("failed");
  });

  it("describes an error finish that carried no message", async () => {
    const router = stubRouter(async () => reply(null, "error"));
    const outcome = await runTier1Worker(makeContext(router));

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toBe("the model returned an error");
  });
});

describe("splitSummary", () => {
  it("takes the last SUMMARY line, not one quoted from the worker's input", () => {
    const text = [
      "The document I was given begins:",
      "SUMMARY: (this line belongs to the input document)",
      "and it goes on for a while.",
      "",
      "SUMMARY: the document is about flags.",
    ].join("\n");

    const { summary, body } = splitSummary(text);
    expect(summary).toBe("the document is about flags.");
    expect(body).toContain("belongs to the input document");
    expect(body).not.toContain("the document is about flags.");
  });

  it("tolerates the markdown bolding models add unprompted", () => {
    // Both placements of the closing `**` occur in the wild.
    expect(splitSummary("work\n**SUMMARY:** it worked").summary).toBe("it worked");
    expect(splitSummary("work\n**SUMMARY**: it worked").summary).toBe("it worked");
    expect(splitSummary("work\nsummary:  it worked").summary).toBe("it worked");
  });

  it("ignores trailing blank lines before the sign-off", () => {
    expect(splitSummary("body\nSUMMARY: done\n\n   \n").summary).toBe("done");
  });

  it("returns no summary when the last line is ordinary prose", () => {
    const { summary, body } = splitSummary("SUMMARY: quoted from input\nbut then I kept talking.");
    expect(summary).toBeNull();
    expect(body).toContain("but then I kept talking.");
  });

  it("collapses a summary that runs onto several visual lines and clamps a long one", () => {
    expect(splitSummary("b\nSUMMARY:   lots    of   space  ").summary).toBe("lots of space");

    const long = splitSummary(`b\nSUMMARY: ${"x".repeat(600)}`).summary ?? "";
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long.endsWith("…")).toBe(true);
  });

  it("treats an empty SUMMARY as no summary at all", () => {
    expect(splitSummary("body\nSUMMARY:").summary).toBeNull();
  });

  it("handles text with no lines at all", () => {
    expect(splitSummary("")).toEqual({ summary: null, body: "" });
  });
});
