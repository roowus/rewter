/**
 * Task-tree fixtures: entities built with sane defaults so a test states only
 * the field it cares about.
 *
 * Test-only module; nothing here is exported from the package entrypoint.
 */
import {
  ModelIdSchema,
  type Task,
  TaskSchema,
  TaskSettingsSchema,
  type WorkItem,
  WorkItemSchema,
  newTaskId,
  newWorkItemId,
} from "@rewter/shared";
import { TS } from "./registry.js";

const MDL = ModelIdSchema.parse("anthropic/claude-sonnet-5");
const CHEAP = ModelIdSchema.parse("zai/glm-5.3");

export function task(overrides: Partial<Task> = {}): Task {
  return TaskSchema.parse({
    id: newTaskId(),
    status: "pending",
    title: "test task",
    initiatorModelId: MDL,
    conversationFingerprint: null,
    settings: TaskSettingsSchema.parse({}),
    resultSummary: null,
    error: null,
    createdAt: TS,
    updatedAt: TS,
    finishedAt: null,
    ...overrides,
  });
}

export function workItem(
  taskId: string,
  title = "a subtask",
  overrides: Partial<WorkItem> = {},
): WorkItem {
  return WorkItemSchema.parse({
    id: newWorkItemId(),
    taskId,
    parentWorkItemId: null,
    status: "pending",
    title,
    instructions: `do: ${title}`,
    modelId: CHEAP,
    tier: 1,
    resultSummary: null,
    error: null,
    createdAt: TS,
    updatedAt: TS,
    finishedAt: null,
    ...overrides,
  });
}
