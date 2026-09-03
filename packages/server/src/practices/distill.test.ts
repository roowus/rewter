/**
 * The practices drafter reads corrections, not successes. Pinned here: which
 * events count as a correction, that the transcript carries the owner's own
 * words, that the parser is loose on shape but strict on usability, and that
 * the job never throws — every outcome is a return value.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Approval,
  type ChatMessage,
  type ChatResponse,
  type EventEnvelope,
  type EventPayload,
  type Practice,
  type Project,
  ProjectSchema,
  type Task,
  type TaskId,
  type WorkItem,
  newApprovalId,
  newProjectId,
} from "@rewter/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TS, model } from "../testing/registry.js";
import { task, workItem } from "../testing/tasks.js";
import {
  MAX_PRACTICES_PER_TASK,
  PRACTICES_DISTILL_PROMPT_VERSION,
  PRACTICES_DISTILL_SYSTEM_PROMPT,
  PracticeDistillError,
  buildPracticesDistillMessages,
  composePracticeMd,
  condenseCorrections,
  draftPractices,
  parsePracticesDraft,
  shouldDraftPractices,
  slugifyPractice,
} from "./distill.js";
import { parsePracticeMd, scanPracticesTree } from "./store.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

let seq = 0;
function envelope(taskId: TaskId | null, payload: EventPayload): EventEnvelope {
  return { seq: ++seq, ts: TS + seq, taskId, payload };
}

function steer(taskId: TaskId, text: string): EventEnvelope {
  return envelope(taskId, { type: "steering.received", taskId, text });
}

function approval(taskId: TaskId, summary: string): Approval {
  return {
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
    createdAt: TS,
    resolvedAt: null,
  };
}

function denied(taskId: TaskId, note: string | null): EventEnvelope[] {
  const a = approval(taskId, "git push --force origin main");
  return [
    envelope(taskId, { type: "approval.requested", approval: a }),
    envelope(taskId, {
      type: "approval.resolved",
      approvalId: a.id,
      status: "denied",
      resolvedBy: "dashboard",
      note,
    }),
  ];
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
  practices?: Practice[];
  project?: Project;
}) {
  return {
    eventsAfter: (_afterSeq: number, taskId?: string) =>
      (opts.events ?? []).filter((e) => taskId === undefined || e.taskId === taskId),
    listWorkItems: (taskId: string) => (opts.workItems ?? []).filter((w) => w.taskId === taskId),
    getProject: (id: string) => (opts.project?.id === id ? opts.project : undefined),
    listPractices: () => opts.practices ?? [],
  };
}

const GOOD_DRAFT = JSON.stringify({
  practices: [
    {
      name: "no-force-push",
      fact: "Never force-push a shared branch; open a new commit instead.",
      scope: "global",
    },
  ],
});

let root: string;
let done: Task;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rewter-practices-distill-"));
  done = task({ status: "succeeded", resultSummary: "pushed the fix" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── Trigger ─────────────────────────────────────────────────────────────────

describe("shouldDraftPractices", () => {
  it("counts steering and denied approvals, nothing else", () => {
    const t = done.id;
    const a = approval(t, "rm -rf build");
    const events = [
      steer(t, "use pnpm not npm"),
      ...denied(t, "not on this repo"),
      envelope(t, { type: "approval.requested", approval: a }),
      envelope(t, {
        type: "approval.resolved",
        approvalId: a.id,
        status: "approved",
        resolvedBy: "in_band",
        note: null,
      }),
      envelope(t, { type: "task.plan_note", taskId: t, note: "plan" }),
    ];
    expect(shouldDraftPractices(events)).toEqual({ distill: true, corrections: 2 });
  });

  it("is off for a task with no corrections", () => {
    expect(shouldDraftPractices([])).toEqual({ distill: false, corrections: 0 });
  });
});

// ── Transcript ──────────────────────────────────────────────────────────────

describe("condenseCorrections", () => {
  it("renders the corrections in the owner's words with the plan they corrected", () => {
    const w = workItem(done.id, "push the fix", { status: "failed", error: "rejected" });
    const events = [
      envelope(done.id, { type: "task.plan_note", taskId: done.id, note: "push straight to main" }),
      envelope(done.id, { type: "work_item.created", workItem: w }),
      ...denied(done.id, "never force-push here"),
      steer(done.id, "open a PR instead"),
      envelope(done.id, {
        type: "work_item.status_changed",
        workItemId: w.id,
        from: "running",
        to: "failed",
      }),
    ];
    const out = condenseCorrections(done, events, [w]);
    expect(out).toContain("task: ");
    expect(out).toContain("outcome: succeeded — pushed the fix");
    expect(out).toContain("plan: push straight to main");
    expect(out).toContain('worker "push the fix" briefed:');
    expect(out).toContain("approval requested (shell): git push --force origin main");
    expect(out).toContain("USER DENIED: never force-push here");
    expect(out).toContain("USER STEERED: open a PR instead");
    expect(out).toContain('worker "push the fix" failed: rejected');
  });

  it("a denial without a note still shows as a denial", () => {
    const out = condenseCorrections(done, denied(done.id, null), []);
    expect(out).toContain("USER DENIED");
    expect(out).not.toContain("USER DENIED:");
  });

  it("elides the middle when over budget, keeping head and tail", () => {
    const events = Array.from({ length: 300 }, (_, i) =>
      steer(done.id, `steer ${i} ${"x".repeat(200)}`),
    );
    const out = condenseCorrections(done, events, [], 500);
    expect(out).toContain("steer 0 ");
    expect(out).toContain("steer 299 ");
    expect(out).toMatch(/\[… \d+ lines elided …\]/);
    expect(out).not.toContain("steer 150 ");
  });
});

// ── Messages ────────────────────────────────────────────────────────────────

describe("buildPracticesDistillMessages", () => {
  const existing: Practice = {
    slug: "use-pnpm",
    status: "pending",
    scope: "global",
    projectSlug: null,
    path: "/practices/pending/use-pnpm/PRACTICE.md",
    fact: "Use pnpm, never npm.",
    learnedFrom: null,
    updatedAt: TS,
  } as Practice;

  it("shows the existing library (marking drafts) and the project hint", () => {
    const msgs = buildPracticesDistillMessages("the log", [existing], "rewter");
    expect(msgs[0]?.content).toBe(PRACTICES_DISTILL_SYSTEM_PROMPT);
    expect(msgs[1]?.content).toContain("- use-pnpm (pending review): Use pnpm, never npm.");
    expect(msgs[1]?.content).toContain('project "rewter"');
    expect(msgs[1]?.content).toContain("the log");
  });

  it("a bare task reads as global-only", () => {
    const msgs = buildPracticesDistillMessages("log", [], null);
    expect(msgs[1]?.content).toContain("(none yet)");
    expect(msgs[1]?.content).toContain("every practice you draft is global");
  });

  it("the prompt is versioned", () => {
    expect(PRACTICES_DISTILL_PROMPT_VERSION).toBe(1);
    expect(PRACTICES_DISTILL_SYSTEM_PROMPT).toContain(`at most ${MAX_PRACTICES_PER_TASK}`);
  });
});

// ── Parsing ─────────────────────────────────────────────────────────────────

describe("parsePracticesDraft", () => {
  it("accepts a draft wrapped in prose and a fence", () => {
    const draft = parsePracticesDraft(`Here:\n\`\`\`json\n${GOOD_DRAFT}\n\`\`\``);
    expect(draft).toMatchObject({
      skip: false,
      practices: [{ slug: "no-force-push", scope: "global" }],
    });
  });

  it("accepts a skip verdict", () => {
    expect(parsePracticesDraft(`{"skip": true, "reason": "one-off  redirect"}`)).toEqual({
      skip: true,
      reason: "one-off redirect",
    });
  });

  it("slugifies names, clamps facts, caps the count, and dedupes", () => {
    const practices = Array.from({ length: MAX_PRACTICES_PER_TASK + 2 }, (_, i) => ({
      name: i === 1 ? "Use PNPM!" : `Use pnpm ${i}`,
      fact: "f".repeat(1000),
    }));
    practices.push({ name: "use-pnpm-0", fact: "dup" });
    const draft = parsePracticesDraft(JSON.stringify({ practices }));
    if (draft.skip) throw new Error("expected practices");
    expect(draft.practices).toHaveLength(MAX_PRACTICES_PER_TASK);
    expect(draft.practices.map((p) => p.slug)).toEqual(["use-pnpm-0", "use-pnpm", "use-pnpm-2"]);
    expect(draft.practices[0]?.fact.length).toBeLessThanOrEqual(400);
    expect(draft.practices[0]?.scope).toBe("global");
  });

  it("a clamped fact still composes — the ellipsis must fit under the parser's cap", () => {
    const draft = parsePracticesDraft(
      JSON.stringify({ practices: [{ name: "long", fact: "word ".repeat(200) }] }),
    );
    if (draft.skip) throw new Error("expected practices");
    const p = draft.practices[0];
    if (!p) throw new Error("expected one practice");
    expect(p.fact.endsWith("…")).toBe(true);
    expect(parsePracticeMd(composePracticeMd(p, done.id, null)).fact).toBe(p.fact);
  });

  it("throws PracticeDistillError for no JSON, bad JSON, or a schema miss", () => {
    expect(() => parsePracticesDraft("nothing here")).toThrow(PracticeDistillError);
    expect(() => parsePracticesDraft("nothing here")).toThrow(/no JSON object/);
    expect(() => parsePracticesDraft(`{"practices": []}`)).toThrow(/does not fit the schema/);
    expect(() => parsePracticesDraft(`{"practices": [{"name": "!!!", "fact": "f"}]}`)).toThrow(
      /cannot make a slug/,
    );
  });
});

describe("slugifyPractice", () => {
  it("normalizes case, spaces, and punctuation", () => {
    expect(slugifyPractice("Run pnpm check (always)")).toBe("run-pnpm-check-always");
  });
  it("returns null when nothing survives", () => {
    expect(slugifyPractice("日本語")).toBeNull();
  });
});

// ── Composition ─────────────────────────────────────────────────────────────

describe("composePracticeMd", () => {
  it("round-trips through the practice parser with provenance", () => {
    const text = composePracticeMd(
      { slug: "no-force-push", fact: "Never force-push a shared branch." },
      done.id,
      "rewter",
    );
    const parsed = parsePracticeMd(text);
    expect(parsed.frontmatter).toEqual({
      name: "no-force-push",
      learned_from: done.id,
      project: "rewter",
    });
    expect(parsed.fact).toBe("Never force-push a shared branch.");
  });

  it("omits project for a global draft", () => {
    const text = composePracticeMd({ slug: "x", fact: "X." }, done.id, null);
    expect(parsePracticeMd(text).frontmatter.project).toBeUndefined();
  });
});

// ── The job ─────────────────────────────────────────────────────────────────

describe("draftPractices", () => {
  const opts = { using: "zai/glm-5.3" };

  it("lands pending drafts the scanner accepts, attributed to the task", async () => {
    const gen = scripted([GOOD_DRAFT]);
    const src = source({ events: [steer(done.id, "never force-push")] });

    const result = await draftPractices(gen, src, root, done, opts);
    expect(result).toEqual({
      taskId: done.id,
      outcome: "drafted",
      slugs: ["no-force-push"],
      alreadyPending: [],
    });

    const scan = scanPracticesTree(root);
    expect(scan.problems).toEqual([]);
    expect(scan.practices).toMatchObject([
      {
        slug: "no-force-push",
        status: "pending",
        scope: "global",
        learnedFrom: done.id,
        fact: "Never force-push a shared branch; open a new commit instead.",
      },
    ]);
    expect(gen.calls[0]?.taskId).toBe(done.id);
  });

  it("skips a task with no corrections without spending", async () => {
    const gen = scripted([GOOD_DRAFT]);
    const src = source({
      events: [envelope(done.id, { type: "task.plan_note", taskId: done.id, note: "p" })],
    });

    const result = await draftPractices(gen, src, root, done, opts);
    expect(result).toMatchObject({ outcome: "skipped", reason: "no corrections in the task log" });
    expect(gen.calls).toHaveLength(0);
  });

  it("honours the model's skip verdict, with a default reason for an empty one", async () => {
    const src = source({ events: [steer(done.id, "actually compare v2")] });

    const said = await draftPractices(
      scripted([`{"skip": true, "reason": "task-local redirect"}`]),
      src,
      root,
      done,
      opts,
    );
    expect(said).toMatchObject({ outcome: "skipped", reason: "task-local redirect" });

    const mute = await draftPractices(scripted([`{"skip": true}`]), src, root, done, opts);
    expect(mute).toMatchObject({ outcome: "skipped", reason: "drafter judged nothing durable" });
    expect(existsSync(join(root, "pending"))).toBe(false);
  });

  it("leaves a pending twin alone and says so", async () => {
    const gen = scripted([GOOD_DRAFT, GOOD_DRAFT]);
    const src = source({ events: [steer(done.id, "never force-push")] });

    await draftPractices(gen, src, root, done, opts);
    const file = join(root, "pending", "no-force-push", "PRACTICE.md");
    const before = readFileSync(file, "utf8");
    const second = await draftPractices(gen, src, root, done, opts);
    expect(second).toMatchObject({
      outcome: "skipped",
      alreadyPending: ["no-force-push"],
      reason: "every proposed practice is already pending review (no-force-push)",
    });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("scopes a project fact to the task's project, or global when there is none", async () => {
    const projectDraft = JSON.stringify({
      practices: [
        { name: "tests-beside-source", fact: "Tests sit next to the source.", scope: "project" },
      ],
    });
    const project = ProjectSchema.parse({
      id: newProjectId(),
      slug: "rewter",
      name: "rewter",
      createdAt: TS,
      updatedAt: TS,
    });
    const events = [steer(done.id, "tests go next to the source")];

    const withProject = task({ status: "succeeded", projectId: project.id });
    await draftPractices(
      scripted([projectDraft]),
      source({ events: [steer(withProject.id, "x")], project }),
      root,
      withProject,
      opts,
    );
    expect(scanPracticesTree(root).practices[0]).toMatchObject({
      scope: "project",
      projectSlug: "rewter",
    });

    const other = mkdtempSync(join(tmpdir(), "rewter-practices-distill-"));
    try {
      await draftPractices(scripted([projectDraft]), source({ events }), other, done, opts);
      expect(scanPracticesTree(other).practices[0]).toMatchObject({
        scope: "global",
        projectSlug: null,
      });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("reports a garbage reply as failed, not thrown", async () => {
    const gen = scripted(["I could not possibly say."]);
    const src = source({ events: [steer(done.id, "x")] });

    const result = await draftPractices(gen, src, root, done, opts);
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
    const src = source({ events: [steer(done.id, "x")] });

    const result = await draftPractices(gen, src, root, done, opts);
    expect(result).toMatchObject({ outcome: "failed", reason: "upstream down" });
  });
});
