import { describe, expect, it } from "vitest";
import {
  ApprovalSchema,
  CapabilityCardSchema,
  CostRecordSchema,
  ModelSchema,
  ModelStatSchema,
  ProviderSchema,
  TaskSchema,
  TaskSettingsSchema,
  WorkItemSchema,
  WorkerRunSchema,
} from "./entities.js";
import { EventEnvelopeSchema, NewEventSchema } from "./events.js";
import {
  ModelIdSchema,
  newApprovalId,
  newCostRecordId,
  newProviderId,
  newTaskId,
  newWorkItemId,
  newWorkerRunId,
} from "./ids.js";

const now = 1_724_800_000_000;
const mdl = ModelIdSchema.parse("anthropic/claude-sonnet-5");

function fixtureTask() {
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
  });
}

describe("entity schemas", () => {
  it("Provider round-trips and never carries a raw key", () => {
    const p = ProviderSchema.parse({
      id: newProviderId(),
      name: "Anthropic",
      kind: "anthropic",
      baseUrl: null,
      apiKeyRef: "ANTHROPIC_API_KEY",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    expect(p.apiKeyRef).toBe("ANTHROPIC_API_KEY");
    expect(ProviderSchema.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it("Model validates pricing/supports and rejects bad modality", () => {
    const base = {
      id: mdl,
      providerId: newProviderId(),
      upstreamId: "claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      pricing: {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
      },
      modalities: ["text", "image"],
      supports: { tools: true, streaming: true, vision: true, caching: true },
      source: "synced",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    expect(ModelSchema.parse(base).contextWindow).toBe(200_000);
    expect(() => ModelSchema.parse({ ...base, modalities: ["telepathy"] })).toThrow();
  });

  it("CapabilityCard tags come from the fixed vocabulary", () => {
    const card = {
      modelId: mdl,
      summary: "strong generalist",
      strengths: ["coding", "reasoning"],
      weaknesses: ["ocr"],
      bestAt: ["planning"],
      notes: null,
      userOverrides: { summary: "user-tweaked" },
      generatedBy: mdl,
      generatedAt: now,
      updatedAt: now,
    };
    expect(CapabilityCardSchema.parse(card).bestAt).toEqual(["planning"]);
    expect(() => CapabilityCardSchema.parse({ ...card, strengths: ["vibes"] })).toThrow();
  });

  it("TaskSettings applies defaults", () => {
    const s = TaskSettingsSchema.parse({});
    expect(s).toEqual({
      autoApprove: false,
      maxSpendUsd: null,
      workspaceDir: null,
      concurrency: 4,
    });
    expect(() => TaskSettingsSchema.parse({ concurrency: 99 })).toThrow();
  });

  it("Task / WorkItem / WorkerRun round-trip through JSON", () => {
    const task = fixtureTask();
    const wi = WorkItemSchema.parse({
      id: newWorkItemId(),
      taskId: task.id,
      parentWorkItemId: null,
      status: "pending",
      title: "fetch url 1",
      instructions: "fetch and summarize",
      modelId: mdl,
      tier: 1,
      resultSummary: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    });
    const run = WorkerRunSchema.parse({
      id: newWorkerRunId(),
      workItemId: wi.id,
      taskId: task.id,
      status: "created",
      modelId: mdl,
      tier: 1,
      attempt: 1,
      harnessSessionId: null,
      resultText: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    });
    for (const [schema, value] of [
      [TaskSchema, task],
      [WorkItemSchema, wi],
      [WorkerRunSchema, run],
    ] as const) {
      expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    }
    expect(() => WorkItemSchema.parse({ ...wi, tier: 4 })).toThrow();
    // An absent tag is "the initiator did not say", and only the card vocabulary counts.
    expect(wi.taskTag).toBeNull();
    expect(WorkItemSchema.parse({ ...wi, taskTag: "ocr" }).taskTag).toBe("ocr");
    expect(() => WorkItemSchema.parse({ ...wi, taskTag: "vibes" })).toThrow();
  });

  it("Approval and CostRecord validate", () => {
    const task = fixtureTask();
    const apr = ApprovalSchema.parse({
      id: newApprovalId(),
      taskId: task.id,
      workItemId: null,
      workerRunId: null,
      status: "pending",
      kind: "shell",
      summary: "run `pnpm build`",
      detail: { command: "pnpm build", cwd: "/tmp/ws" },
      resolvedBy: null,
      resolutionNote: null,
      createdAt: now,
      resolvedAt: null,
    });
    expect(apr.kind).toBe("shell");

    const cost = CostRecordSchema.parse({
      id: newCostRecordId(),
      taskId: task.id,
      workerRunId: null,
      modelId: mdl,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.006,
      pricingSnapshot: {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
      },
      createdAt: now,
    });
    expect(cost.costUsd).toBeCloseTo(0.006);
    expect(() => CostRecordSchema.parse({ ...cost, inputTokens: -1 })).toThrow();
  });

  it("ModelStat keys on the capability-tag vocabulary", () => {
    const stat = ModelStatSchema.parse({
      modelId: mdl,
      taskTag: "coding",
      attempts: 10,
      successes: 9,
      avgCostUsd: 0.01,
      avgLatencyMs: 1200,
      updatedAt: now,
    });
    expect(stat.taskTag).toBe("coding");
    expect(() => ModelStatSchema.parse({ ...stat, taskTag: "everything" })).toThrow();
  });
});

describe("event envelope", () => {
  it("parses each payload variant and rejects unknown types", () => {
    const task = fixtureTask();
    const envelope = EventEnvelopeSchema.parse({
      seq: 1,
      ts: now,
      taskId: task.id,
      payload: { type: "task.created", task },
    });
    expect(envelope.payload.type).toBe("task.created");

    expect(
      NewEventSchema.parse({
        taskId: task.id,
        payload: { type: "task.plan_note", taskId: task.id, note: "3-way fan-out" },
      }).payload.type,
    ).toBe("task.plan_note");

    expect(() =>
      EventEnvelopeSchema.parse({
        seq: 2,
        ts: now,
        taskId: null,
        payload: { type: "task.exploded" },
      }),
    ).toThrow();
  });

  it("status_changed payloads validate against the lifecycle enums", () => {
    const task = fixtureTask();
    expect(() =>
      EventEnvelopeSchema.parse({
        seq: 3,
        ts: now,
        taskId: task.id,
        payload: { type: "task.status_changed", taskId: task.id, from: "pending", to: "sideways" },
      }),
    ).toThrow();
  });
});
