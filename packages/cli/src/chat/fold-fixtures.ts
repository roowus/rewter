/**
 * Event-stream builders for the chat tests — the same shapes `shared/fold.test.ts`
 * uses, so a task the CLI renders is a task the fold has already been proven on.
 *
 * Test-only module (imported by `*.test.ts`); it ships in `dist` because the
 * package has one tsconfig, but nothing at runtime imports it.
 */
import {
  ApprovalSchema,
  CostRecordSchema,
  type EventEnvelope,
  EventEnvelopeSchema,
  type EventPayload,
  ModelIdSchema,
  type Task,
  TaskSchema,
  TaskSettingsSchema,
  type WorkItem,
  WorkItemSchema,
  type WorkerRun,
  WorkerRunSchema,
  newApprovalId,
  newCostRecordId,
  newWorkItemId,
  newWorkerRunId,
} from "@rewter/shared";

export const T0 = 1_724_800_000_000;
const initiator = ModelIdSchema.parse("anthropic/claude-sonnet-5");
const cheap = ModelIdSchema.parse("zai/glm-5.3");

/** Auto-numbered `seq`, auto-stepped `ts` — hand-numbered fixtures drift. */
export class Stream {
  private seq = 0;
  private t = T0;
  readonly events: EventEnvelope[] = [];

  push(taskId: string | null, payload: EventPayload, tsStep = 1000): EventEnvelope {
    this.seq += 1;
    this.t += tsStep;
    const ev = EventEnvelopeSchema.parse({ seq: this.seq, ts: this.t, taskId, payload });
    this.events.push(ev);
    return ev;
  }
}

export function task(id: string, title = "summarize three urls"): Task {
  return TaskSchema.parse({
    id,
    status: "pending",
    title,
    initiatorModelId: initiator,
    conversationFingerprint: null,
    settings: TaskSettingsSchema.parse({}),
    resultSummary: null,
    error: null,
    createdAt: T0,
    updatedAt: T0,
    finishedAt: null,
  });
}

export function workItem(taskId: string, title: string, tier: 1 | 2 | 3 = 1): WorkItem {
  return WorkItemSchema.parse({
    id: newWorkItemId(),
    taskId,
    parentWorkItemId: null,
    status: "pending",
    title,
    instructions: `do: ${title}`,
    modelId: cheap,
    tier,
    resultSummary: null,
    error: null,
    createdAt: T0,
    updatedAt: T0,
    finishedAt: null,
  });
}

export function workerRun(taskId: string, workItemId: string, attempt = 1): WorkerRun {
  return WorkerRunSchema.parse({
    id: newWorkerRunId(),
    workItemId,
    taskId,
    status: "created",
    modelId: cheap,
    tier: 1,
    attempt,
    harnessSessionId: null,
    resultText: null,
    error: null,
    createdAt: T0,
    updatedAt: T0,
    finishedAt: null,
  });
}

export function approval(taskId: string, workItemId: string | null, summary: string) {
  return ApprovalSchema.parse({
    id: newApprovalId(),
    taskId,
    workItemId,
    workerRunId: null,
    status: "pending",
    kind: "shell",
    summary,
    detail: null,
    resolvedBy: null,
    resolutionNote: null,
    createdAt: T0,
    resolvedAt: null,
  });
}

export function cost(taskId: string, workerRunId: string | null, costUsd: number) {
  return CostRecordSchema.parse({
    id: newCostRecordId(),
    taskId,
    workerRunId,
    modelId: cheap,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
    pricingSnapshot: {
      inputPerMTok: 0.6,
      outputPerMTok: 2.2,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    },
    createdAt: T0,
  });
}

/**
 * A two-worker fan-out, paused before the end: w1 succeeded ($0.001), w2 still
 * running, initiator spent $0.02. `finish()` settles w2 and the task.
 */
export function fanOut(taskId: string): {
  stream: Stream;
  task: Task;
  items: WorkItem[];
  finish: () => void;
} {
  const s = new Stream();
  const t = task(taskId);
  s.push(t.id, { type: "task.created", task: t });
  s.push(t.id, { type: "task.status_changed", taskId: t.id, from: "pending", to: "running" });
  const items = ["url 1", "url 2"].map((title) => {
    const wi = workItem(t.id, title);
    s.push(t.id, { type: "work_item.created", workItem: wi });
    return wi;
  });
  const runs = items.map((wi) => {
    const run = workerRun(t.id, wi.id);
    s.push(t.id, { type: "worker_run.created", workerRun: run });
    s.push(t.id, {
      type: "work_item.status_changed",
      workItemId: wi.id,
      from: "pending",
      to: "running",
    });
    s.push(t.id, {
      type: "worker_run.status_changed",
      workerRunId: run.id,
      from: "created",
      to: "streaming",
    });
    return run;
  });
  const settle = (i: number, usd: number): void => {
    const run = runs[i] as WorkerRun;
    const wi = items[i] as WorkItem;
    s.push(t.id, { type: "cost.recorded", cost: cost(t.id, run.id, usd) });
    s.push(t.id, {
      type: "worker_run.status_changed",
      workerRunId: run.id,
      from: "streaming",
      to: "succeeded",
    });
    s.push(t.id, {
      type: "work_item.status_changed",
      workItemId: wi.id,
      from: "running",
      to: "succeeded",
    });
  };
  settle(0, 0.001);
  s.push(t.id, { type: "cost.recorded", cost: cost(t.id, null, 0.02) });
  return {
    stream: s,
    task: t,
    items,
    finish: () => {
      settle(1, 0.002);
      s.push(t.id, { type: "task.status_changed", taskId: t.id, from: "running", to: "succeeded" });
    },
  };
}
