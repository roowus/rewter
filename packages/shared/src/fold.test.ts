import { describe, expect, it } from "vitest";
import {
  ApprovalSchema,
  CostRecordSchema,
  TaskSchema,
  TaskSettingsSchema,
  WorkItemSchema,
  WorkerRunSchema,
} from "./entities.js";
import { type EventEnvelope, EventEnvelopeSchema, type EventPayload } from "./events.js";
import {
  applyEvent,
  emptyFoldState,
  foldEvents,
  foldTask,
  pendingApprovals,
  tasksInOrder,
} from "./fold.js";
import {
  ModelIdSchema,
  newApprovalId,
  newCostRecordId,
  newTaskId,
  newWorkItemId,
  newWorkerRunId,
} from "./ids.js";

const now = 1_724_800_000_000;
const mdl = ModelIdSchema.parse("anthropic/claude-sonnet-5");
const cheap = ModelIdSchema.parse("zai/glm-5.3");

/**
 * A stream builder rather than hand-numbered fixtures: `seq` is the fold's whole
 * ordering contract, and a test that assigned it by hand would drift the moment
 * an event was inserted in the middle.
 */
class Stream {
  private seq = 0;
  private t = now;
  readonly events: EventEnvelope[] = [];

  push(taskId: string | null, payload: EventPayload, tsStep = 1000): EventEnvelope {
    this.seq += 1;
    this.t += tsStep;
    const ev = EventEnvelopeSchema.parse({ seq: this.seq, ts: this.t, taskId, payload });
    this.events.push(ev);
    return ev;
  }
}

function task(overrides: Partial<Record<string, unknown>> = {}) {
  return TaskSchema.parse({
    id: newTaskId(),
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
    ...overrides,
  });
}

function workItem(taskId: string, title: string) {
  return WorkItemSchema.parse({
    id: newWorkItemId(),
    taskId,
    parentWorkItemId: null,
    status: "pending",
    title,
    instructions: `do: ${title}`,
    modelId: cheap,
    tier: 1,
    resultSummary: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  });
}

function workerRun(taskId: string, workItemId: string) {
  return WorkerRunSchema.parse({
    id: newWorkerRunId(),
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
}

function approval(taskId: string, summary: string) {
  return ApprovalSchema.parse({
    id: newApprovalId(),
    taskId,
    workItemId: null,
    workerRunId: null,
    status: "pending",
    kind: "shell",
    summary,
    detail: null,
    resolvedBy: null,
    resolutionNote: null,
    createdAt: now,
    resolvedAt: null,
  });
}

function cost(taskId: string, workerRunId: string | null, costUsd: number) {
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
    createdAt: now,
  });
}

/** A three-way fan-out that finishes: the shape the fold exists to render. */
function fanOutStream() {
  const s = new Stream();
  const t = task();
  s.push(t.id, { type: "task.created", task: t });
  s.push(t.id, { type: "task.status_changed", taskId: t.id, from: "pending", to: "running" });
  s.push(t.id, { type: "task.plan_note", taskId: t.id, note: "fetch each page, then compare" });

  const items = ["url 1", "url 2", "url 3"].map((title) => {
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
    return run;
  });
  for (const [i, run] of runs.entries()) {
    s.push(t.id, {
      type: "worker_run.status_changed",
      workerRunId: run.id,
      from: "created",
      to: "streaming",
    });
    s.push(t.id, { type: "cost.recorded", cost: cost(t.id, run.id, 0.001 * (i + 1)) });
    s.push(t.id, {
      type: "worker_run.status_changed",
      workerRunId: run.id,
      from: "streaming",
      to: "succeeded",
    });
    s.push(t.id, {
      type: "work_item.status_changed",
      workItemId: run.workItemId,
      from: "running",
      to: "succeeded",
    });
  }
  s.push(t.id, { type: "cost.recorded", cost: cost(t.id, null, 0.02) });
  s.push(t.id, { type: "task.status_changed", taskId: t.id, from: "running", to: "succeeded" });
  return { stream: s, task: t, items, runs };
}

describe("foldEvents", () => {
  it("builds the task → work item → run tree from a fan-out", () => {
    const { stream, task: t, items } = fanOutStream();
    const folded = foldTask(stream.events, t.id);

    expect(folded).toBeDefined();
    expect(folded?.task.status).toBe("succeeded");
    expect(folded?.workItems).toHaveLength(3);
    expect(folded?.workItems.map((w) => w.workItem.title)).toEqual(items.map((i) => i.title));
    expect(folded?.workItems.every((w) => w.runs.length === 1)).toBe(true);
    expect(folded?.planNotes.map((n) => n.text)).toEqual(["fetch each page, then compare"]);
  });

  it("labels work items w1, w2, w3 in creation order", () => {
    const { stream, task: t } = fanOutStream();
    expect(foldTask(stream.events, t.id)?.workItems.map((w) => w.label)).toEqual([
      "w1",
      "w2",
      "w3",
    ]);
  });

  it("attributes cost to runs, rolls it up, and splits out the initiator's own", () => {
    const { stream, task: t } = fanOutStream();
    const folded = foldTask(stream.events, t.id);

    // 0.001 + 0.002 + 0.003 worker + 0.02 initiator.
    expect(folded?.costUsd).toBeCloseTo(0.026, 10);
    expect(folded?.initiatorCostUsd).toBeCloseTo(0.02, 10);
    expect(folded?.workItems.map((w) => w.costUsd)).toEqual([0.001, 0.002, 0.003]);
    expect(folded?.workItems[0]?.runs[0]?.costUsd).toBe(0.001);
  });

  it("keeps unattributed spend in the task total when the run is unknown", () => {
    // The fold started after the run was created — the money is still real.
    const s = new Stream();
    const t = task();
    s.push(t.id, { type: "task.created", task: t });
    s.push(t.id, { type: "cost.recorded", cost: cost(t.id, newWorkerRunId(), 0.5) });

    const folded = foldTask(s.events, t.id);
    expect(folded?.costUsd).toBe(0.5);
    // Not the initiator's: it named a run, we just never saw that run.
    expect(folded?.initiatorCostUsd).toBe(0);
  });

  it("stamps finishedAt on terminal transitions only", () => {
    const { stream, task: t, items } = fanOutStream();
    const folded = foldTask(stream.events, t.id);
    const first = folded?.workItems[0];

    expect(first?.workItem.status).toBe("succeeded");
    expect(first?.workItem.finishedAt).not.toBeNull();
    expect(first?.workItem.updatedAt).toBeGreaterThan(items[0]?.createdAt ?? 0);
    expect(folded?.task.finishedAt).not.toBeNull();
  });

  it("leaves a still-running entity without a finishedAt", () => {
    const s = new Stream();
    const t = task();
    s.push(t.id, { type: "task.created", task: t });
    s.push(t.id, { type: "task.status_changed", taskId: t.id, from: "pending", to: "running" });

    const folded = foldTask(s.events, t.id);
    expect(folded?.task.status).toBe("running");
    expect(folded?.task.finishedAt).toBeNull();
  });

  it("records approvals and applies their resolution", () => {
    const s = new Stream();
    const t = task();
    s.push(t.id, { type: "task.created", task: t });
    const a = approval(t.id, "run `uname -a`");
    s.push(t.id, { type: "approval.requested", approval: a });

    const parked = foldTask(s.events, t.id);
    expect(pendingApprovals(parked as never)).toHaveLength(1);

    s.push(t.id, {
      type: "approval.resolved",
      approvalId: a.id,
      status: "denied",
      resolvedBy: "in_band",
      note: "use the fixture instead",
    });

    const folded = foldTask(s.events, t.id);
    const resolved = folded?.approvals[0];
    expect(resolved?.status).toBe("denied");
    expect(resolved?.resolvedBy).toBe("in_band");
    expect(resolved?.resolutionNote).toBe("use the fixture instead");
    expect(resolved?.resolvedAt).not.toBeNull();
    expect(pendingApprovals(folded as never)).toHaveLength(0);
  });

  it("collects worker progress notes under their run, in order", () => {
    const s = new Stream();
    const t = task();
    s.push(t.id, { type: "task.created", task: t });
    const wi = workItem(t.id, "read the file");
    s.push(t.id, { type: "work_item.created", workItem: wi });
    const run = workerRun(t.id, wi.id);
    s.push(t.id, { type: "worker_run.created", workerRun: run });
    s.push(t.id, { type: "worker_run.progress", workerRunId: run.id, text: "read src/foo.ts" });
    s.push(t.id, {
      type: "worker_run.progress",
      workerRunId: run.id,
      text: "found the off-by-one",
    });

    const notes = foldTask(s.events, t.id)?.workItems[0]?.runs[0]?.notes;
    expect(notes?.map((n) => n.text)).toEqual(["read src/foo.ts", "found the off-by-one"]);
    expect(notes?.[0]?.seq).toBeLessThan(notes?.[1]?.seq ?? 0);
  });

  it("records steering turns and handoffs", () => {
    const s = new Stream();
    const t = task();
    s.push(t.id, { type: "task.created", task: t });
    s.push(t.id, { type: "steering.received", taskId: t.id, text: "also check the third URL" });
    s.push(t.id, {
      type: "handoff.initiated",
      taskId: t.id,
      fromWorkItemId: null,
      toModelId: "anthropic/claude-opus-5",
      reason: "this needs deeper reasoning",
    });

    const folded = foldTask(s.events, t.id);
    expect(folded?.steering.map((n) => n.text)).toEqual(["also check the third URL"]);
    expect(folded?.handoffs[0]?.toModelId).toBe("anthropic/claude-opus-5");
    expect(folded?.handoffs[0]?.reason).toBe("this needs deeper reasoning");
  });

  it("adopts a settings change wholesale, so the folded task equals the row", () => {
    // The dashboard reads the cap out of the folded `Task`, and the daemon reads
    // it out of the row. A fold that merged toward `to` instead of taking it
    // would let those two answers drift.
    const s = new Stream();
    const t = task({ settings: TaskSettingsSchema.parse({ maxSpendUsd: 1 }) });
    s.push(t.id, { type: "task.created", task: t });
    expect(foldTask(s.events, t.id)?.task.settings.maxSpendUsd).toBe(1);

    const raised = TaskSettingsSchema.parse({ ...t.settings, maxSpendUsd: 5 });
    const ev = s.push(t.id, {
      type: "task.settings_changed",
      taskId: t.id,
      from: t.settings,
      to: raised,
    });

    const folded = foldTask(s.events, t.id);
    expect(folded?.task.settings).toEqual(raised);
    // The whole object, not just the field that moved — the other three are
    // still what the task was created with.
    expect(folded?.task.settings.concurrency).toBe(t.settings.concurrency);
    expect(folded?.task.updatedAt).toBe(ev.ts);
    // A settings change is not a status change; nothing about the lifecycle moved.
    expect(folded?.task.status).toBe("pending");
  });

  it("carries a cap removal, which is not the same as a cap of zero", () => {
    const s = new Stream();
    const t = task({ settings: TaskSettingsSchema.parse({ maxSpendUsd: 2 }) });
    s.push(t.id, { type: "task.created", task: t });
    s.push(t.id, {
      type: "task.settings_changed",
      taskId: t.id,
      from: t.settings,
      to: TaskSettingsSchema.parse({ ...t.settings, maxSpendUsd: null }),
    });

    expect(foldTask(s.events, t.id)?.task.settings.maxSpendUsd).toBeNull();
  });

  it("keeps two concurrent tasks apart", () => {
    const s = new Stream();
    const a = task({ title: "task a" });
    const b = task({ title: "task b" });
    s.push(a.id, { type: "task.created", task: a });
    s.push(b.id, { type: "task.created", task: b });
    const wiA = workItem(a.id, "a1");
    const wiB = workItem(b.id, "b1");
    s.push(a.id, { type: "work_item.created", workItem: wiA });
    s.push(b.id, { type: "work_item.created", workItem: wiB });
    s.push(b.id, { type: "cost.recorded", cost: cost(b.id, null, 0.03) });

    const state = foldEvents(s.events);
    expect(Object.keys(state.tasks)).toHaveLength(2);
    // Both are w1: labels are per task, not global.
    expect(state.tasks[a.id]?.workItems.map((w) => w.label)).toEqual(["w1"]);
    expect(state.tasks[b.id]?.workItems.map((w) => w.label)).toEqual(["w1"]);
    expect(state.tasks[a.id]?.costUsd).toBe(0);
    expect(state.tasks[b.id]?.costUsd).toBe(0.03);
    expect(tasksInOrder(state).map((t) => t.task.title)).toEqual(["task a", "task b"]);
  });
});

describe("applyEvent", () => {
  it("folding in two batches equals folding in one", () => {
    // Replay-then-live is exactly this split, so the two must agree.
    const { stream, task: t } = fanOutStream();
    const all = foldEvents(stream.events);
    const split = foldEvents(stream.events.slice(6), foldEvents(stream.events.slice(0, 6)));

    expect(split.tasks[t.id]).toEqual(all.tasks[t.id]);
    expect(split.lastSeq).toBe(all.lastSeq);
  });

  it("ignores an event at or below lastSeq", () => {
    // Replay and the live subscription overlap; a re-delivered cost must not
    // bill twice.
    const s = new Stream();
    const t = task();
    s.push(t.id, { type: "task.created", task: t });
    const costEvent = s.push(t.id, { type: "cost.recorded", cost: cost(t.id, null, 0.01) });

    const state = foldEvents(s.events);
    const again = applyEvent(state, costEvent);

    expect(again).toBe(state);
    expect(again.tasks[t.id]?.costUsd).toBe(0.01);
  });

  it("returns the same state object when nothing changed", () => {
    const s = new Stream();
    const t = task();
    s.push(t.id, { type: "task.created", task: t });
    const state = foldEvents(s.events);

    // A duplicate work_item.created at a *higher* seq: seen, but not new.
    const wi = workItem(t.id, "only once");
    const first = applyEvent(state, {
      ...s.push(t.id, { type: "work_item.created", workItem: wi }),
    });
    const second = applyEvent(first, {
      ...s.push(t.id, { type: "work_item.created", workItem: wi }),
    });

    expect(first.tasks[t.id]?.workItems).toHaveLength(1);
    expect(second.tasks[t.id]?.workItems).toHaveLength(1);
    expect(second.orphanedEvents).toBe(1);
  });

  it("counts events for a task it never saw created, and still advances lastSeq", () => {
    // A fold that starts mid-stream is legitimate — but it must say so, or a UI
    // reads an incomplete tree as a complete one.
    const s = new Stream();
    const t = task();
    s.push(t.id, { type: "task.created", task: t });
    const orphanTaskId = newTaskId();
    const orphan = s.push(orphanTaskId, {
      type: "task.plan_note",
      taskId: orphanTaskId,
      note: "from a task we joined late",
    });

    const state = foldEvents(s.events);
    expect(state.orphanedEvents).toBe(1);
    expect(state.lastSeq).toBe(orphan.seq);
    expect(Object.keys(state.tasks)).toEqual([t.id]);
  });

  it("counts a status change for an unknown work item as orphaned", () => {
    const s = new Stream();
    const t = task();
    s.push(t.id, { type: "task.created", task: t });
    s.push(t.id, {
      type: "work_item.status_changed",
      workItemId: newWorkItemId(),
      from: "pending",
      to: "running",
    });

    const state = foldEvents(s.events);
    expect(state.orphanedEvents).toBe(1);
    expect(state.tasks[t.id]?.workItems).toHaveLength(0);
  });

  it("starts from an empty state that folds to nothing", () => {
    const state = emptyFoldState();
    expect(foldEvents([], state)).toBe(state);
    expect(tasksInOrder(state)).toEqual([]);
  });

  it("uses the payload's taskId when the envelope's is null", () => {
    // The envelope's taskId is nullable; a plan note still knows its task.
    const s = new Stream();
    const t = task();
    s.push(t.id, { type: "task.created", task: t });
    s.push(null, { type: "task.plan_note", taskId: t.id, note: "routed by payload" });

    const state = foldEvents(s.events);
    expect(state.orphanedEvents).toBe(0);
    expect(state.tasks[t.id]?.planNotes.map((n) => n.text)).toEqual(["routed by payload"]);
  });

  it("tracks lastSeq per task as well as globally", () => {
    const s = new Stream();
    const a = task({ title: "a" });
    const b = task({ title: "b" });
    s.push(a.id, { type: "task.created", task: a });
    s.push(b.id, { type: "task.created", task: b });
    s.push(a.id, { type: "task.plan_note", taskId: a.id, note: "later" });

    const state = foldEvents(s.events);
    expect(state.tasks[a.id]?.lastSeq).toBe(3);
    expect(state.tasks[b.id]?.lastSeq).toBe(2);
    expect(state.lastSeq).toBe(3);
  });
});
