import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChatMessage,
  type ChatResponse,
  type CostRecord,
  type EventEnvelope,
  type EventPayload,
  type Model,
  type Skill,
  type Task,
  type TaskId,
  type WorkItem,
  type WorkerRunId,
  newCostRecordId,
  newWorkerRunId,
} from "@rewter/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TS, model } from "../testing/registry.js";
import { task, workItem } from "../testing/tasks.js";
import {
  DEFAULT_MIN_WORKER_TURNS,
  DISTILL_SYSTEM_PROMPT,
  DistillError,
  buildDistillMessages,
  composeSkillMd,
  condenseTaskLog,
  distillTask,
  parseSkillDraft,
  pickDistillModel,
  shouldDistill,
  slugify,
} from "./distill.js";
import { parseSkillMd, scanSkillsTree } from "./store.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

let seq = 0;
function envelope(taskId: TaskId | null, payload: EventPayload): EventEnvelope {
  return { seq: ++seq, ts: TS + seq, taskId, payload };
}

function costEvent(taskId: TaskId, workerRunId: WorkerRunId | null): EventEnvelope {
  const cost: CostRecord = {
    id: newCostRecordId(),
    taskId,
    workerRunId,
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
  return envelope(taskId, { type: "cost.recorded", cost });
}

function workerTurns(taskId: TaskId, n: number): EventEnvelope[] {
  return Array.from({ length: n }, () => costEvent(taskId, newWorkerRunId()));
}

function scripted(replies: string[]) {
  const calls: { model: string; messages: ChatMessage[]; taskId?: string | null }[] = [];
  let n = 0;
  return {
    calls,
    resolve: (id: string) => ({ model: model(id) }),
    async complete(req: {
      model: string;
      messages: ChatMessage[];
      taskId?: string | null;
    }): Promise<ChatResponse> {
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

function source(opts: {
  events?: EventEnvelope[];
  workItems?: WorkItem[];
  skills?: Skill[];
}) {
  return {
    eventsAfter: (_afterSeq: number, taskId?: string) =>
      (opts.events ?? []).filter((e) => taskId === undefined || e.taskId === taskId),
    listWorkItems: (taskId: string) => (opts.workItems ?? []).filter((w) => w.taskId === taskId),
    getProject: () => undefined,
    listSkills: () => opts.skills ?? [],
  };
}

const GOOD_DRAFT = JSON.stringify({
  name: "compare-three-sources",
  description: "Use when a task asks to fetch several sources and synthesize a comparison.",
  body: "## Procedure\n\n1. Fan out one worker per source.\n2. Compare summaries.\n\n## Verification\n\nCheck each claim against its source.",
});

let root: string;
let succeeded: Task;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rewter-distill-"));
  succeeded = task({ status: "succeeded", resultSummary: "compared three sources" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── Trigger ─────────────────────────────────────────────────────────────────

describe("shouldDistill", () => {
  it("counts only worker-attributed cost events", () => {
    const t = succeeded.id;
    const events = [
      ...workerTurns(t, 3),
      costEvent(t, null), // initiator turn — not a worker turn
      envelope(t, { type: "task.plan_note", taskId: succeeded.id, note: "plan" }),
    ];
    expect(shouldDistill(events)).toEqual({ distill: false, workerTurns: 3 });
    expect(shouldDistill(events, 3).distill).toBe(true);
  });

  it("fires at the default floor exactly", () => {
    const events = workerTurns(succeeded.id, DEFAULT_MIN_WORKER_TURNS);
    expect(shouldDistill(events).distill).toBe(true);
  });
});

// ── Transcript ──────────────────────────────────────────────────────────────

describe("condenseTaskLog", () => {
  it("renders plan, workers, approvals, and outcomes; drops bookkeeping", () => {
    const w = workItem(succeeded.id, "fetch source A", {
      status: "succeeded",
      resultSummary: "got it",
    });
    const events = [
      envelope(succeeded.id, { type: "task.plan_note", taskId: succeeded.id, note: "fan out" }),
      envelope(succeeded.id, { type: "work_item.created", workItem: w }),
      envelope(succeeded.id, {
        type: "work_item.status_changed",
        workItemId: w.id,
        from: "running",
        to: "succeeded",
      }),
      costEvent(succeeded.id, newWorkerRunId()),
    ];
    const out = condenseTaskLog(succeeded, events, [w]);
    expect(out).toContain("plan: fan out");
    expect(out).toContain('worker "fetch source A"');
    expect(out).toContain("succeeded: got it");
    expect(out).toContain("outcome: succeeded — compared three sources");
    expect(out).not.toContain("cost");
  });

  it("elides the middle when over budget, keeping head and tail", () => {
    const events = Array.from({ length: 400 }, (_, i) =>
      envelope(succeeded.id, {
        type: "task.plan_note",
        taskId: succeeded.id,
        note: `step ${i} ${"x".repeat(200)}`,
      }),
    );
    const out = condenseTaskLog(succeeded, events, [], 500);
    expect(out).toContain("step 0");
    expect(out).toContain("step 399");
    expect(out).toMatch(/\[… \d+ lines elided …\]/);
    expect(out).not.toContain("step 200 ");
  });

  it("failed work items carry their error into the transcript", () => {
    const w = workItem(succeeded.id, "broken step", { status: "failed", error: "timed out" });
    const events = [
      envelope(succeeded.id, {
        type: "work_item.status_changed",
        workItemId: w.id,
        from: "running",
        to: "failed",
      }),
    ];
    expect(condenseTaskLog(succeeded, events, [w])).toContain(
      'worker "broken step" failed: timed out',
    );
  });

  it("carries a refused steer into the transcript, so the tier lesson can be distilled", () => {
    const w = workItem(succeeded.id, "quick think", { tier: 1 });
    const events = [
      envelope(succeeded.id, {
        type: "worker.message_refused",
        taskId: succeeded.id,
        workItemId: w.id,
        reason: "tier_1",
        message: "actually compare against the v2 spec",
      }),
    ];
    expect(condenseTaskLog(succeeded, events, [w])).toContain(
      'message to worker "quick think" refused (it is tier 1): actually compare against the v2 spec',
    );
  });
});

// ── Messages ────────────────────────────────────────────────────────────────

describe("buildDistillMessages", () => {
  it("shows existing skills and the project scope hint", () => {
    const skill: Skill = {
      slug: "old-trick",
      status: "approved",
      scope: "global",
      projectSlug: null,
      path: "/skills/global/old-trick/SKILL.md",
      description: "an existing one",
      learnedFrom: null,
      uses: 2,
      updatedAt: TS,
    } as Skill;
    const msgs = buildDistillMessages(succeeded, "the log", [skill], "myproj");
    expect(msgs[0]?.content).toBe(DISTILL_SYSTEM_PROMPT);
    expect(msgs[1]?.content).toContain("- old-trick: an existing one");
    expect(msgs[1]?.content).toContain('project "myproj"');
    expect(msgs[1]?.content).toContain("the log");
  });

  it("bare task reads as global", () => {
    const msgs = buildDistillMessages(succeeded, "log", [], null);
    expect(msgs[1]?.content).toContain("the skill would be global");
  });
});

// ── Parsing ─────────────────────────────────────────────────────────────────

describe("parseSkillDraft", () => {
  it("accepts a draft wrapped in prose and a fence", () => {
    const draft = parseSkillDraft(`Sure! Here it is:\n\`\`\`json\n${GOOD_DRAFT}\n\`\`\``);
    expect(draft).toMatchObject({ skip: false, slug: "compare-three-sources" });
  });

  it("accepts a skip verdict", () => {
    expect(parseSkillDraft(`{"skip": true, "reason": "one-off"}`)).toEqual({
      skip: true,
      reason: "one-off",
    });
  });

  it("repairs a near-miss name into a slug", () => {
    const draft = parseSkillDraft(
      JSON.stringify({ name: "Compare Three Sources!", description: "d", body: "b" }),
    );
    expect(draft).toMatchObject({ skip: false, slug: "compare-three-sources" });
  });

  it("throws DistillError when no JSON, bad JSON, or schema miss", () => {
    expect(() => parseSkillDraft("no json here")).toThrow(DistillError);
    expect(() => parseSkillDraft("{broken")).toThrow(/no JSON object/);
    expect(() => parseSkillDraft(`{"name": "x"}`)).toThrow(/does not fit the schema/);
  });

  it("throws when the name cannot become a slug", () => {
    expect(() =>
      parseSkillDraft(JSON.stringify({ name: "!!!", description: "d", body: "b" })),
    ).toThrow(/cannot make a slug/);
  });
});

describe("slugify", () => {
  it("normalizes case, spaces, and punctuation", () => {
    expect(slugify("My Great Skill (v2)")).toBe("my-great-skill-v2");
  });
  it("returns null when nothing survives", () => {
    expect(slugify("日本語")).toBeNull();
  });
});

// ── Composition ─────────────────────────────────────────────────────────────

describe("composeSkillMd", () => {
  it("round-trips through the skill parser with provenance", () => {
    const text = composeSkillMd(
      { slug: "a-skill", description: "when to use it", body: "## Steps\n\n1. do" },
      succeeded.id,
      "myproj",
    );
    const parsed = parseSkillMd(text);
    expect(parsed.frontmatter.name).toBe("a-skill");
    expect(parsed.frontmatter.learned_from).toBe(succeeded.id);
    expect(parsed.frontmatter.project).toBe("myproj");
    expect(parsed.body).toBe("## Steps\n\n1. do\n");
  });

  it("omits project for a global draft", () => {
    const text = composeSkillMd(
      { slug: "a-skill", description: "d", body: "b" },
      succeeded.id,
      null,
    );
    expect(parseSkillMd(text).frontmatter.project).toBeUndefined();
  });
});

// ── The job ─────────────────────────────────────────────────────────────────

describe("distillTask", () => {
  const opts = { using: "zai/glm-5.3" };

  it("lands a pending draft the scanner accepts, attributed to the task", async () => {
    const gen = scripted([GOOD_DRAFT]);
    const src = source({ events: workerTurns(succeeded.id, 6) });

    const result = await distillTask(gen, src, root, succeeded, opts);
    expect(result).toMatchObject({ outcome: "drafted", slug: "compare-three-sources" });

    const scan = scanSkillsTree(root);
    expect(scan.problems).toEqual([]);
    expect(scan.skills).toHaveLength(1);
    expect(scan.skills[0]).toMatchObject({
      slug: "compare-three-sources",
      status: "pending",
      learnedFrom: succeeded.id,
    });
    // Spend is booked against the task it learned from.
    expect(gen.calls[0]?.taskId).toBe(succeeded.id);
  });

  it("skips below the trigger floor without spending", async () => {
    const gen = scripted([GOOD_DRAFT]);
    const src = source({ events: workerTurns(succeeded.id, 2) });

    const result = await distillTask(gen, src, root, succeeded, opts);
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toContain("below the distill floor");
    expect(gen.calls).toHaveLength(0);
  });

  it("honours the model's skip verdict", async () => {
    const gen = scripted([`{"skip": true, "reason": "answer-shaped task"}`]);
    const src = source({ events: workerTurns(succeeded.id, 6) });

    const result = await distillTask(gen, src, root, succeeded, opts);
    expect(result).toMatchObject({ outcome: "skipped", reason: "answer-shaped task" });
    expect(existsSync(join(root, "pending"))).toBe(false);
  });

  it("refuses to overwrite a pending draft with the same slug", async () => {
    const gen = scripted([GOOD_DRAFT, GOOD_DRAFT]);
    const src = source({ events: workerTurns(succeeded.id, 6) });

    await distillTask(gen, src, root, succeeded, opts);
    const before = readFileSync(join(root, "pending", "compare-three-sources", "SKILL.md"), "utf8");
    const second = await distillTask(gen, src, root, succeeded, opts);
    expect(second.outcome).toBe("skipped");
    expect(second.reason).toContain("already pending review");
    expect(readFileSync(join(root, "pending", "compare-three-sources", "SKILL.md"), "utf8")).toBe(
      before,
    );
  });

  it("reports a garbage reply as failed, not thrown", async () => {
    const gen = scripted(["I could not possibly say."]);
    const src = source({ events: workerTurns(succeeded.id, 6) });

    const result = await distillTask(gen, src, root, succeeded, opts);
    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("no JSON object");
  });

  it("reports a completion error as failed, not thrown", async () => {
    const gen = {
      resolve: (id: string) => ({ model: model(id) }),
      complete: async () => {
        throw new Error("upstream down");
      },
    };
    const src = source({ events: workerTurns(succeeded.id, 6) });

    const result = await distillTask(gen, src, root, succeeded, opts);
    expect(result).toMatchObject({ outcome: "failed", reason: "upstream down" });
  });
});

// ── Model picking ───────────────────────────────────────────────────────────

describe("pickDistillModel", () => {
  const priced = (id: string, out: number | null): Model =>
    model(id, undefined, {
      pricing: {
        inputPerMTok: 1,
        outputPerMTok: out,
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
      },
    });

  it("prefers the cheapest known output price; known beats unknown", () => {
    const picked = pickDistillModel([
      priced("a/pricey", 15),
      priced("b/cheap", 0.5),
      priced("c/mystery", null),
    ]);
    expect(picked).toBe("b/cheap");
  });

  it("falls back to unknown-priced when nothing is priced, and to undefined on empty", () => {
    expect(pickDistillModel([priced("c/mystery", null)])).toBe("c/mystery");
    expect(pickDistillModel([])).toBeUndefined();
  });
});
