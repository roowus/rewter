import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChatMessage,
  type ChatResponse,
  type CostRecord,
  type Task,
  newCostRecordId,
  newWorkerRunId,
} from "@rewter/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillsConfigSchema } from "../config/config.js";
import { openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { TS, model } from "../testing/registry.js";
import { task } from "../testing/tasks.js";
import { wireDistiller } from "./watch.js";

// ── Harness ──────────────────────────────────────────────────────────────────
//
// A real in-memory bus + repos, because the distiller's whole job is reacting
// to the bus and reindexing through the repos — faking either would test the
// fake. Only the LLM is scripted.

let db: ReturnType<typeof openDb>;
let bus: EventBus;
let repos: Repos;
let root: string;
let logs: { level: "info" | "warn"; msg: string; obj: object }[];

beforeEach(() => {
  db = openDb(":memory:");
  bus = new EventBus(db);
  repos = new Repos(db, bus);
  root = mkdtempSync(join(tmpdir(), "rewter-watch-"));
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

/** A succeeded task in the repos, with enough worker turns on the log to clear the floor. */
function seedTask(turns = 6): Task {
  const t = repos.createTask(task({ status: "pending" }));
  repos.transitionTask(t.id, "running");
  for (let i = 0; i < turns; i++) {
    const cost: CostRecord = {
      id: newCostRecordId(),
      taskId: t.id,
      workerRunId: newWorkerRunId(),
      modelId: model("zai/glm-5.3").id,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.001,
      pricingSnapshot: {
        inputPerMTok: null,
        outputPerMTok: null,
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
      },
      createdAt: TS,
    };
    bus.append({ taskId: t.id, payload: { type: "cost.recorded", cost } });
  }
  return t;
}

type Generator = Parameters<typeof wireDistiller>[0]["generator"];

function wire(generator: Generator, config = SkillsConfigSchema.parse({})) {
  return wireDistiller({
    bus,
    generator,
    source: {
      eventsAfter: (afterSeq, taskId) => bus.eventsAfter(afterSeq, taskId),
      listWorkItems: (taskId) => repos.listWorkItems(taskId),
      getProject: (id) => repos.getProject(id),
      listSkills: () => repos.listSkills(),
      getTask: (id) => repos.getTask(id),
    },
    repos,
    listModels: () => [model("zai/glm-5.3")],
    skillsRoot: root,
    config,
    log,
  });
}

const DRAFT = JSON.stringify({
  name: "a-learned-skill",
  description: "Use when this exact situation recurs.",
  body: "## Steps\n\n1. do the thing\n\n## Verification\n\ncheck it",
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("wireDistiller", () => {
  it("drafts on task success and reindexes, so the pending skill is queryable", async () => {
    const gen = scripted([DRAFT]);
    const d = wire(gen);
    const t = seedTask();

    repos.transitionTask(t.id, "succeeded", { resultSummary: "done" });
    await d.idle();

    expect(gen.calls).toHaveLength(1);
    expect(existsSync(join(root, "pending", "a-learned-skill", "SKILL.md"))).toBe(true);
    // The reindex ran: the draft is in the index, as pending.
    expect(repos.listSkills()).toMatchObject([{ slug: "a-learned-skill", status: "pending" }]);
    expect(logs.some((l) => l.msg === "skill drafted — pending review")).toBe(true);
    d.unsubscribe();
  });

  it("ignores every event except task.status_changed → succeeded", async () => {
    const gen = scripted([DRAFT]);
    const d = wire(gen);
    const t = seedTask();

    repos.transitionTask(t.id, "failed", { error: "nope" });
    await d.idle();
    expect(gen.calls).toHaveLength(0);
    d.unsubscribe();
  });

  it("does nothing when config.distill is off", async () => {
    const gen = scripted([DRAFT]);
    const d = wire(gen, SkillsConfigSchema.parse({ distill: false }));
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

  it("queues distillations rather than interleaving them", async () => {
    const order: string[] = [];
    const gen = {
      calls: [] as { model: string; messages: ChatMessage[] }[],
      resolve: (id: string) => ({ model: model(id) }),
      async complete(req: { model: string; messages: ChatMessage[] }): Promise<ChatResponse> {
        gen.calls.push(req);
        order.push("start");
        // Yield twice: an interleaved second job would slot its "start" here.
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

  it("logs a distill failure without breaking the bus or the chain", async () => {
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
    expect(logs.some((l) => l.level === "warn" && l.msg === "distill failed")).toBe(true);

    // The chain survives: the next success still gets its turn.
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
    const d = wireDistiller({
      bus,
      generator: gen,
      source: {
        eventsAfter: (afterSeq, taskId) => bus.eventsAfter(afterSeq, taskId),
        listWorkItems: (taskId) => repos.listWorkItems(taskId),
        getProject: (id) => repos.getProject(id),
        listSkills: () => repos.listSkills(),
        getTask: (id) => repos.getTask(id),
      },
      repos,
      listModels: () => [],
      skillsRoot: root,
      config: SkillsConfigSchema.parse({}),
      log,
    });
    const t = seedTask();

    repos.transitionTask(t.id, "succeeded");
    await d.idle();
    expect(gen.calls).toHaveLength(0);
    expect(logs.some((l) => l.msg.includes("no enabled model"))).toBe(true);
    d.unsubscribe();
  });
});
