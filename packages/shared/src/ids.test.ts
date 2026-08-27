import { describe, expect, it } from "vitest";
import {
  ApprovalIdSchema,
  ModelIdSchema,
  TaskIdSchema,
  WorkItemIdSchema,
  WorkerRunIdSchema,
  newApprovalId,
  newEventId,
  newTaskId,
  newWorkItemId,
  newWorkerRunId,
} from "./ids.js";

describe("branded IDs", () => {
  it("generates prefixed ids that parse under their own schema", () => {
    expect(TaskIdSchema.parse(newTaskId())).toMatch(/^task_[0-9a-z]{12}$/);
    expect(WorkItemIdSchema.parse(newWorkItemId())).toMatch(/^wi_[0-9a-z]{12}$/);
    expect(WorkerRunIdSchema.parse(newWorkerRunId())).toMatch(/^run_[0-9a-z]{12}$/);
    expect(ApprovalIdSchema.parse(newApprovalId())).toMatch(/^apr_[0-9a-z]{12}$/);
    expect(newEventId()).toMatch(/^evt_[0-9a-z]{12}$/);
  });

  it("rejects cross-prefix values", () => {
    const task = newTaskId();
    expect(() => WorkItemIdSchema.parse(task)).toThrow();
    expect(() => ApprovalIdSchema.parse("apr_TOOSHORT")).toThrow();
    expect(() => TaskIdSchema.parse("task_")).toThrow();
  });

  it("generates unique ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newTaskId()));
    expect(ids.size).toBe(500);
  });
});

describe("ModelIdSchema", () => {
  it("accepts provider/model slugs", () => {
    expect(ModelIdSchema.parse("anthropic/claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
    expect(ModelIdSchema.parse("zai/glm-5.3")).toBe("zai/glm-5.3");
    expect(ModelIdSchema.parse("auto/orchestrator:gpt-6")).toBeTruthy();
  });

  it("rejects empty and leading-symbol slugs", () => {
    expect(() => ModelIdSchema.parse("")).toThrow();
    expect(() => ModelIdSchema.parse("/leading-slash")).toThrow();
    expect(() => ModelIdSchema.parse("has spaces")).toThrow();
  });
});
