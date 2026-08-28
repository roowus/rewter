/**
 * The task tree, rendered from a real fold.
 *
 * Everything here is driven through `foldEvents` rather than hand-built
 * `FoldedTask` literals: a hand-built one is a second opinion about what the
 * fold produces, and this file would keep passing after the fold changed shape.
 */
import {
  CostRecordSchema,
  type EventEnvelope,
  EventEnvelopeSchema,
  type EventPayload,
  ModelIdSchema,
  TaskSchema,
  TaskSettingsSchema,
  WorkItemSchema,
  WorkerRunSchema,
  foldEvents,
  newCostRecordId,
  newTaskId,
  newWorkItemId,
  newWorkerRunId,
} from "@rewter/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskTree } from "./TaskTree.js";

const now = 1_756_252_800_000;
const mdl = ModelIdSchema.parse("anthropic/claude-sonnet-5");
const cheap = ModelIdSchema.parse("zai/glm-5.3");
const taskId = newTaskId();

let seq = 0;
const envelope = (payload: EventPayload): EventEnvelope =>
  EventEnvelopeSchema.parse({ seq: ++seq, ts: now + seq, taskId, payload });

const pricing = { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0, cacheWritePerMTok: 0 };

/** A task with one worker: created, run, a progress note, and a cost record. */
function scenario(): EventEnvelope[] {
  const workItemId = newWorkItemId();
  const workerRunId = newWorkerRunId();

  const task = TaskSchema.parse({
    id: taskId,
    status: "pending",
    title: "summarize three urls",
    initiatorModelId: mdl,
    conversationFingerprint: null,
    settings: TaskSettingsSchema.parse({}),
    resultSummary: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  });

  const workItem = WorkItemSchema.parse({
    id: workItemId,
    taskId,
    parentWorkItemId: null,
    status: "pending",
    title: "fetch and summarize url 1",
    instructions: "…",
    modelId: cheap,
    tier: 1,
    resultSummary: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  });

  const workerRun = WorkerRunSchema.parse({
    id: workerRunId,
    workItemId,
    taskId,
    status: "created",
    modelId: cheap,
    tier: 1,
    attempt: 1,
    harnessSessionId: null,
    resultText: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  });

  return [
    envelope({ type: "task.created", task }),
    envelope({ type: "task.status_changed", taskId, from: "pending", to: "running" }),
    envelope({ type: "task.plan_note", taskId, note: "three urls, one worker each" }),
    envelope({ type: "work_item.created", workItem }),
    envelope({ type: "worker_run.created", workerRun }),
    envelope({ type: "worker_run.progress", workerRunId, text: "fetched, 4kb" }),
    envelope({
      type: "cost.recorded",
      cost: CostRecordSchema.parse({
        id: newCostRecordId(),
        taskId,
        workerRunId,
        modelId: cheap,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0021,
        pricingSnapshot: pricing,
        createdAt: now,
      }),
    }),
    envelope({
      type: "cost.recorded",
      cost: CostRecordSchema.parse({
        id: newCostRecordId(),
        // No `workerRunId`: the initiator's own planning tokens.
        taskId,
        workerRunId: null,
        modelId: mdl,
        inputTokens: 8000,
        outputTokens: 300,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0049,
        pricingSnapshot: pricing,
        createdAt: now,
      }),
    }),
  ];
}

const foldOne = (events: EventEnvelope[]) => {
  const task = foldEvents(events).tasks[taskId];
  if (task === undefined) throw new Error("fold produced no task");
  return task;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("TaskTree", () => {
  it("renders the task, its worker, and the worker's own progress note", () => {
    render(<TaskTree task={foldOne(scenario())} now={now + 5000} />);

    expect(screen.getByText("summarize three urls")).toBeDefined();
    expect(screen.getByText("fetch and summarize url 1")).toBeDefined();
    expect(screen.getByText("fetched, 4kb")).toBeDefined();
    expect(screen.getByText("three urls, one worker each")).toBeDefined();
  });

  it("labels workers the way the engine does", () => {
    // `w1` is engine-local state that never enters an event — the fold rebuilds
    // it from creation order so the dashboard and the CLI feed agree.
    render(<TaskTree task={foldOne(scenario())} now={now} />);
    expect(screen.getByText("w1")).toBeDefined();
  });

  it("splits planning spend out of the total", () => {
    // "The planner cost more than the work" is the question this whole design
    // exists to answer, and one total hides it. Here it is over 2× the worker.
    render(<TaskTree task={foldOne(scenario())} now={now} />);

    expect(screen.getByText("$0.0070")).toBeDefined();
    expect(screen.getByText("$0.0049 planning")).toBeDefined();
  });

  it("shows the folded status, not the status the task was created with", () => {
    // `task.created` carries `pending`; the transition to `running` arrives
    // separately, and a tree that rendered the creation row would be stuck.
    render(<TaskTree task={foldOne(scenario())} now={now} />);
    expect(screen.getByText("running")).toBeDefined();
  });

  it("measures a running task against the clock it was handed", () => {
    // Task and worker both started at `now`, so both tick — which is the point:
    // a running row that showed a frozen duration would look finished.
    render(<TaskTree task={foldOne(scenario())} now={now + 12_000} />);
    expect(screen.getAllByText("12s")).toHaveLength(2);
  });

  it("announces a handoff rather than leaving it in the noise", () => {
    // The initiator judging itself unfit is the headline event in this system.
    const events = [
      ...scenario(),
      envelope({
        type: "handoff.initiated",
        taskId,
        fromWorkItemId: null,
        toModelId: "anthropic/claude-opus-5",
        reason: "needs deeper reasoning",
      }),
    ];
    render(<TaskTree task={foldOne(events)} now={now} />);

    expect(screen.getByText("claude-opus-5")).toBeDefined();
    expect(screen.getByText(/needs deeper reasoning/)).toBeDefined();
  });

  it("counts attempts when a work item was retried", () => {
    const events = scenario();
    const first = events.find((e) => e.payload.type === "worker_run.created");
    if (first === undefined || first.payload.type !== "worker_run.created") throw new Error("bad");
    const retry = WorkerRunSchema.parse({
      ...first.payload.workerRun,
      id: newWorkerRunId(),
      modelId: mdl,
      attempt: 2,
    });
    render(
      <TaskTree
        task={foldOne([...events, envelope({ type: "worker_run.created", workerRun: retry })])}
        now={now}
      />,
    );

    expect(screen.getByText("2 attempts")).toBeDefined();
  });
});

describe("TaskTree — the kill button", () => {
  /** The same scenario, taken to a terminal status through the real fold. */
  const finished = (): EventEnvelope[] => [
    ...scenario(),
    envelope({ type: "task.status_changed", taskId, from: "running", to: "succeeded" }),
  ];

  it("posts a cancel for the task it is rendered inside", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ aborted: true }));
    vi.stubGlobal("fetch", fetchImpl);

    render(<TaskTree task={foldOne(scenario())} now={now} />);
    fireEvent.click(screen.getByText("Kill"));

    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/internal/tasks/${taskId}/cancel`);
    expect(init.method).toBe("POST");
  });

  it("is absent on a task that has already finished", () => {
    // Offering it would be offering the 409, and the status beside it already
    // says the task is over.
    render(<TaskTree task={foldOne(finished())} now={now} />);
    expect(screen.queryByText("Kill")).toBeNull();
    expect(screen.getByText("succeeded")).toBeDefined();
  });

  it("leaves the task showing running until the fold says otherwise", async () => {
    // Same rule as the approval card: the click does not recolour the status.
    // A kill the daemon refused must not leave the UI claiming a dead task.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ aborted: true })),
    );

    render(<TaskTree task={foldOne(scenario())} now={now} />);
    fireEvent.click(screen.getByText("Kill"));

    await screen.findByText("cancelling");
    expect(screen.getByText("running")).toBeDefined();
  });

  it("says when the row was settled but nothing was actually running", async () => {
    // A task from before a restart: the row said running, but no session
    // existed. Reported rather than flattened into "cancelled" — they are
    // different things to have done.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ aborted: false })),
    );

    render(<TaskTree task={foldOne(scenario())} now={now} />);
    fireEvent.click(screen.getByText("Kill"));

    await screen.findByText("recorded — nothing was running");
  });

  it("re-enables itself when the daemon could not be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    render(<TaskTree task={foldOne(scenario())} now={now} />);
    const kill = screen.getByText("Kill") as HTMLButtonElement;
    fireEvent.click(kill);

    await screen.findByText("daemon unreachable");
    expect(kill.disabled).toBe(false);
  });

  it("stays disabled once a kill landed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ aborted: true })),
    );

    render(<TaskTree task={foldOne(scenario())} now={now} />);
    const kill = screen.getByText("Kill") as HTMLButtonElement;
    fireEvent.click(kill);

    await screen.findByText("cancelling");
    expect(kill.disabled).toBe(true);
  });
});
