/**
 * Approval gate tests.
 *
 * Three properties matter here, and everything else is detail:
 *
 *  - **Nothing is ungated silently.** Every auto-approval writes a row saying
 *    which rule let it through, so "nothing needed asking" and "the user turned
 *    the gate off" are distinguishable after the fact.
 *  - **A parked worker always gets an answer.** Approve, deny, approve-all, or
 *    task cancellation — but never a promise nobody resolves, because that is a
 *    worker hung forever holding a concurrency slot.
 *  - **The allowlist cannot be talked into a write.** Most tests below are
 *    attempts to get `isReadOnlyCommand` to say yes to something that writes.
 */
import {
  ModelIdSchema,
  type TaskId,
  TaskSettingsSchema,
  newTaskId,
  newWorkItemId,
} from "@rewter/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { Approvals, isReadOnlyCommand } from "./approvals.js";

let db: Db;
let repos: Repos;
let bus: EventBus;
let tick: number;
let taskId: TaskId;
let autoApprove: boolean;

beforeEach(() => {
  db = openDb(":memory:");
  tick = 1_756_252_800_000;
  const clock = () => ++tick;
  bus = new EventBus(db, clock);
  repos = new Repos(db, bus, clock);
  autoApprove = false;
  taskId = newTaskId();
  const now = ++tick;
  repos.createTask({
    id: taskId,
    status: "pending",
    title: "approval gate",
    initiatorModelId: ModelIdSchema.parse("anthropic/claude-sonnet-5"),
    projectId: null,
    conversationFingerprint: null,
    settings: TaskSettingsSchema.parse({}),
    resultSummary: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  });
});

function gate(announce?: (a: { id: string }) => void): Approvals {
  return new Approvals({
    repos,
    taskId,
    autoApprove: () => autoApprove,
    clock: () => ++tick,
    ...(announce === undefined ? {} : { announce }),
  });
}

/** `rm -rf` on a real path: the thing the gate exists for. */
const RISKY = { kind: "shell" as const, summary: "rm -rf ~/projects/thing/node_modules" };

describe("policy", () => {
  it("asks nobody when auto-approve is on, but records that it was on", async () => {
    autoApprove = true;
    const verdict = await gate().require(RISKY);

    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.auto).toBe(true);
    // The audit trail must name the rule. "auto_approved" alone cannot tell a
    // reader whether the user disabled the gate or the action was harmless.
    const row = repos.getApproval(verdict.approvalId as string);
    expect(row?.status).toBe("auto_approved");
    expect(row?.resolutionNote).toBe("auto-approve is on for this task");
    expect(row?.resolvedBy).toBe("policy");
  });

  it("reads auto-approve fresh, so flipping it mid-task takes effect", async () => {
    const g = gate();
    const parked = g.require(RISKY);
    // Still pending: the flag was off when this was asked.
    expect(g.pending()).toHaveLength(1);

    autoApprove = true;
    const second = await g.require(RISKY);
    expect(second.ok).toBe(true);

    g.cancel();
    await parked;
  });

  it("lets a write inside the workspace through, logged", async () => {
    const verdict = await gate().require({
      kind: "write_outside_workspace",
      summary: "write notes.md",
      inWorkspace: true,
    });
    expect(verdict.ok).toBe(true);
    expect(repos.getApproval(verdict.approvalId as string)?.resolutionNote).toBe(
      "inside the task workspace",
    );
  });

  it("lets a read-only command through, logged", async () => {
    const verdict = await gate().require({ kind: "shell", summary: "git status", readOnly: true });
    expect(verdict.ok).toBe(true);
    expect(repos.getApproval(verdict.approvalId as string)?.resolutionNote).toBe(
      "read-only command",
    );
  });

  it("parks anything else and announces it", async () => {
    const announced: string[] = [];
    const g = gate((a) => announced.push(a.id));

    let settled = false;
    const parked = g.require(RISKY).then((v) => {
      settled = true;
      return v;
    });
    await Promise.resolve();

    // The whole point: it must NOT have resolved on its own.
    expect(settled).toBe(false);
    const pending = g.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.summary).toBe(RISKY.summary);
    expect(announced).toEqual([pending[0]?.id]);

    g.resolve(pending[0]?.id as never, true, "dashboard");
    expect((await parked).ok).toBe(true);
  });

  it("emits exactly one approval.requested per request", async () => {
    // The repo emits on write; a second append here would put two cards in the
    // dashboard for one prompt.
    const g = gate();
    void g.require(RISKY);
    await Promise.resolve();

    const requested = bus
      .eventsAfter(0, taskId)
      .filter((e) => e.payload.type === "approval.requested");
    expect(requested).toHaveLength(1);
    g.cancel();
  });
});

describe("resolution", () => {
  it("hands a denial back as a result the model can act on, not an error", async () => {
    const g = gate();
    const parked = g.require(RISKY);
    await Promise.resolve();
    const id = g.pending()[0]?.id as never;

    g.resolve(id, false, "dashboard", "use the test fixture instead");
    const verdict = await parked;

    expect(verdict.ok).toBe(false);
    // The note is the useful half: bare "denied" invites the identical retry.
    expect(verdict.ok === false && verdict.reason).toBe(
      "denied by the user: use the test fixture instead",
    );
  });

  it("still reads as a denial with no note", async () => {
    const g = gate();
    const parked = g.require(RISKY);
    await Promise.resolve();
    g.resolve(g.pending()[0]?.id as never, false, "in_band");
    const verdict = await parked;
    expect(verdict.ok === false && verdict.reason).toBe("denied by the user");
  });

  it("ignores a second resolve of the same request", async () => {
    const g = gate();
    const parked = g.require(RISKY);
    await Promise.resolve();
    const id = g.pending()[0]?.id as never;

    expect(g.resolve(id, true, "dashboard")).toBe(true);
    // A double-click in the dashboard, or a race between a click and an in-band
    // "approve all". Ordinary, not an error — and it must not flip the verdict.
    expect(g.resolve(id, false, "in_band")).toBe(false);
    expect((await parked).ok).toBe(true);
    expect(repos.getApproval(id)?.status).toBe("approved");
  });

  it("ignores an unknown id", () => {
    expect(gate().resolve("apr_nope" as never, true, "dashboard")).toBe(false);
  });

  it("resolves every parked request at once for 'approve all'", async () => {
    const g = gate();
    const a = g.require({ ...RISKY, summary: "rm -rf a" });
    const b = g.require({ ...RISKY, summary: "rm -rf b" });
    await Promise.resolve();

    expect(g.resolveAll(true, "in_band", "approve all")).toBe(2);
    expect((await a).ok).toBe(true);
    expect((await b).ok).toBe(true);
    expect(g.pending()).toHaveLength(0);
  });

  it("carries the work item and run through to the row", async () => {
    // The dashboard groups approval cards under the worker that asked, so these
    // must survive the round trip.
    const workItemId = newWorkItemId();
    repos.createWorkItem({
      id: workItemId,
      taskId,
      parentWorkItemId: null,
      status: "pending",
      title: "clean",
      instructions: "clean the tree",
      modelId: ModelIdSchema.parse("anthropic/claude-sonnet-5"),
      tier: 2,
      resultSummary: null,
      error: null,
      createdAt: ++tick,
      updatedAt: tick,
      finishedAt: null,
    });
    autoApprove = true;
    const verdict = await gate().require({
      ...RISKY,
      workItemId,
      detail: { cwd: "/tmp/x" },
    });
    const row = repos.getApproval(verdict.approvalId as string);
    expect(row?.workItemId).toBe(workItemId);
    expect(row?.detail).toEqual({ cwd: "/tmp/x" });
  });
});

describe("cancellation", () => {
  it("denies everything parked when the task is cancelled", async () => {
    // A worker must not sit awaiting a human who has closed the tab.
    const g = gate();
    const parked = g.require(RISKY);
    await Promise.resolve();

    g.cancel();
    const verdict = await parked;
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("cancelled");
  });

  it("refuses later requests without opening a prompt nobody will answer", async () => {
    const g = gate();
    g.cancel();
    const verdict = await g.require(RISKY);
    expect(verdict.ok).toBe(false);
    expect(verdict.approvalId).toBeNull();
    // No row, no dashboard card: the task is going away.
    expect(g.pending()).toHaveLength(0);
  });

  it("refuses even a harmless action after cancellation", async () => {
    // Cancellation is checked before policy on purpose: a torn-down task should
    // not still be doing work, however safe the individual step looks.
    const g = gate();
    g.cancel();
    autoApprove = true;
    expect((await g.require({ ...RISKY, readOnly: true })).ok).toBe(false);
  });
});

describe("isReadOnlyCommand", () => {
  it("accepts the listed commands", () => {
    for (const c of ["ls", "ls -la src", "git status", "git diff --stat", "pnpm test", "pwd"]) {
      expect(isReadOnlyCommand(c)).toBe(true);
    }
  });

  it("rejects anything unlisted", () => {
    for (const c of ["rm -rf /", "git push", "pnpm install", "curl example.com", "npm publish"]) {
      expect(isReadOnlyCommand(c)).toBe(false);
    }
  });

  it("rejects a chained or substituted command that starts with a safe word", () => {
    // The whole reason the check is not "does it begin with an allowed word".
    for (const c of [
      "ls; rm -rf ~",
      "ls && rm -rf ~",
      "ls | tee /etc/passwd",
      "ls > /tmp/out",
      "cat f `rm -rf ~`",
      "cat f $(rm -rf ~)",
      "git status & rm -rf ~",
      "ls\nrm -rf ~",
    ]) {
      expect(isReadOnlyCommand(c)).toBe(false);
    }
  });

  it("rejects a read-looking command told to write a file", () => {
    // `git diff -o` and friends: the verb reads, the flag writes.
    expect(isReadOnlyCommand("git diff -o /tmp/x")).toBe(false);
    expect(isReadOnlyCommand("git log --output=/tmp/x")).toBe(false);
    expect(isReadOnlyCommand("git log --output /tmp/x")).toBe(false);
  });

  it("does not match a two-word command on its first word alone", () => {
    // `git` is not on the list; only specific subcommands are.
    expect(isReadOnlyCommand("git")).toBe(false);
    expect(isReadOnlyCommand("git reset --hard")).toBe(false);
    expect(isReadOnlyCommand("pnpm build")).toBe(false);
  });

  it("rejects empty and whitespace-only input", () => {
    expect(isReadOnlyCommand("")).toBe(false);
    expect(isReadOnlyCommand("   ")).toBe(false);
  });

  it("tolerates surrounding whitespace on a real command", () => {
    expect(isReadOnlyCommand("  git status  ")).toBe(true);
  });
});
