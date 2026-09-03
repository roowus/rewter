/**
 * The drafter's trigger against a real in-memory bus + repos, with only the
 * LLM scripted. What differs from the skills watcher is pinned: every terminal
 * state fires, and a task with no corrections costs nothing — not a chain link.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ChatResponse, Task } from "@rewter/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PracticesConfigSchema } from "../config/config.js";
import { openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { model } from "../testing/registry.js";
import { task } from "../testing/tasks.js";
import { wirePracticesDrafter } from "./watch.js";

let db: ReturnType<typeof openDb>;
let bus: EventBus;
let repos: Repos;
let root: string;
let logs: { level: "info" | "warn"; msg: string; obj: object }[];

beforeEach(() => {
  db = openDb(":memory:");
  bus = new EventBus(db);
  repos = new Repos(db, bus);
  root = mkdtempSync(join(tmpdir(), "rewter-practices-watch-"));
  logs = [];
});

afterEach(() => {
  db.$client.close();
  rmSync(root, { recursive: true, force: true });
});

const log = {
  info: (obj: object, msg: string) => logs.push({ level: "info", msg, obj }),
  warn: (obj: object, msg: string) => logs.push({ level: "warn", msg, obj }),
};

function scripted(replies: string[]) {
  const calls: { model: string; messages: ChatMessage[] }[] = [];
  let n = 0;
  return {
    calls,
    resolve: (id: string) => ({ model: model(id) }),
    async complete(req: { model: string; messages: ChatMessage[] }): Promise<ChatResponse> {
      calls.push(req);
      const content = replies[n] ?? replies[replies.length - 1] ?? "";
      n += 1;
      return {
        message: { role: "assistant", content },
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

/** A running task in the repos, steered `corrections` times. */
function seedTask(corrections = 1): Task {
  const t = repos.createTask(task({ status: "pending" }));
  repos.transitionTask(t.id, "running");
  for (let i = 0; i < corrections; i++) {
    bus.append({
      taskId: t.id,
      payload: { type: "steering.received", taskId: t.id, text: `correction ${i}` },
    });
  }
  return t;
}

type Generator = Parameters<typeof wirePracticesDrafter>[0]["generator"];

function wire(generator: Generator, config = PracticesConfigSchema.parse({}), models = 1) {
  return wirePracticesDrafter({
    bus,
    generator,
    source: {
      eventsAfter: (afterSeq, taskId) => bus.eventsAfter(afterSeq, taskId),
      listWorkItems: (taskId) => repos.listWorkItems(taskId),
      getProject: (id) => repos.getProject(id),
      listPractices: () => repos.listPractices(),
      getTask: (id) => repos.getTask(id),
    },
    repos,
    listModels: () => (models === 0 ? [] : [model("zai/glm-5.3")]),
    practicesRoot: root,
    config,
    log,
  });
}

const DRAFT = JSON.stringify({
  practices: [{ name: "a-learned-rule", fact: "Do it this way from now on.", scope: "global" }],
});

describe("wirePracticesDrafter", () => {
  it("drafts on task success and reindexes, so the pending practice is queryable", async () => {
    const gen = scripted([DRAFT]);
    const d = wire(gen);
    const t = seedTask();

    repos.transitionTask(t.id, "succeeded", { resultSummary: "done" });
    await d.idle();

    expect(gen.calls).toHaveLength(1);
    expect(existsSync(join(root, "pending", "a-learned-rule", "PRACTICE.md"))).toBe(true);
    expect(repos.listPractices()).toMatchObject([{ slug: "a-learned-rule", status: "pending" }]);
    expect(logs.some((l) => l.msg === "practice drafted — pending review")).toBe(true);
    d.unsubscribe();
  });

  it("fires on failed and cancelled too — a correction is a correction", async () => {
    const gen = scripted([`{"skip": true, "reason": "test"}`]);
    const d = wire(gen);
    const t1 = seedTask();
    const t2 = seedTask();

    repos.transitionTask(t1.id, "failed", { error: "nope" });
    repos.transitionTask(t2.id, "cancelled");
    await d.idle();
    expect(gen.calls).toHaveLength(2);
    d.unsubscribe();
  });

  it("a task with no corrections queues nothing and spends nothing", async () => {
    const gen = scripted([DRAFT]);
    const d = wire(gen);
    const t = seedTask(0);

    repos.transitionTask(t.id, "succeeded");
    await d.idle();
    expect(gen.calls).toHaveLength(0);
    expect(logs).toEqual([]);
    d.unsubscribe();
  });

  it("does nothing when config.distill is off", async () => {
    const gen = scripted([DRAFT]);
    const d = wire(gen, PracticesConfigSchema.parse({ distill: false }));
    const t = seedTask();

    repos.transitionTask(t.id, "succeeded");
    await d.idle();
    expect(gen.calls).toHaveLength(0);
    d.unsubscribe();
  });

  it("stops reacting after unsubscribe", async () => {
    const gen = scripted([DRAFT]);
    const d = wire(gen);
    const t = seedTask();

    d.unsubscribe();
    repos.transitionTask(t.id, "succeeded");
    await d.idle();
    expect(gen.calls).toHaveLength(0);
  });

  it("queues drafts rather than interleaving them", async () => {
    const order: string[] = [];
    const gen = {
      calls: [] as { model: string; messages: ChatMessage[] }[],
      resolve: (id: string) => ({ model: model(id) }),
      async complete(req: { model: string; messages: ChatMessage[] }): Promise<ChatResponse> {
        gen.calls.push(req);
        order.push("start");
        await new Promise((r) => setTimeout(r, 0));
        order.push("end");
        return {
          message: { role: "assistant", content: `{"skip": true, "reason": "test"}` },
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    const d = wire(gen);
    const t1 = seedTask();
    const t2 = seedTask();

    repos.transitionTask(t1.id, "succeeded");
    repos.transitionTask(t2.id, "succeeded");
    await d.idle();

    expect(order).toEqual(["start", "end", "start", "end"]);
    d.unsubscribe();
  });

  it("logs a draft failure without breaking the bus or the chain", async () => {
    const gen = {
      calls: [] as unknown[],
      resolve: (id: string) => ({ model: model(id) }),
      complete: async (): Promise<ChatResponse> => {
        throw new Error("upstream down");
      },
    };
    const d = wire(gen);
    const t1 = seedTask();
    const t2 = seedTask();

    repos.transitionTask(t1.id, "succeeded");
    await d.idle();
    expect(logs.some((l) => l.level === "warn" && l.msg === "practices draft failed")).toBe(true);

    const gen2 = scripted([DRAFT]);
    d.unsubscribe();
    const d2 = wire(gen2);
    repos.transitionTask(t2.id, "succeeded");
    await d2.idle();
    expect(gen2.calls).toHaveLength(1);
    d2.unsubscribe();
  });

  it("warns and skips when no model is available to draft with", async () => {
    const gen = scripted([DRAFT]);
    const d = wire(gen, PracticesConfigSchema.parse({}), 0);
    const t = seedTask();

    repos.transitionTask(t.id, "succeeded");
    await d.idle();
    expect(gen.calls).toHaveLength(0);
    expect(logs.some((l) => l.msg.includes("no enabled model"))).toBe(true);
    d.unsubscribe();
  });
});
