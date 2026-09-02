import { type FoldedTask, foldTask } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { T0, approval, fanOut } from "./fold-fixtures.js";
import { costFooter, duration, renderTree, shortModelId, usd } from "./tree.js";

const TASK_ID = "task_abcdefghijkl";

function fold(events: ReturnType<typeof fanOut>["stream"]["events"]): FoldedTask {
  const folded = foldTask(events, TASK_ID);
  if (folded === undefined) throw new Error("fixture did not fold");
  return folded;
}

describe("renderTree", () => {
  it("draws a header, one row per worker, and a closing rule", () => {
    const { stream } = fanOut(TASK_ID);
    const lines = renderTree(fold(stream.events), T0 + 30_000);
    expect(lines[0]).toBe(
      "┌ running · 1/2 workers done, 1 running · $0.02 spent (planning $0.02) · 30s",
    );
    expect(lines[1]).toBe("│ ✔ url 1 — w1 · glm-5.3 · T1 · succeeded · $0.0010 · 13s");
    expect(lines[2]).toBe("│ ▶ url 2 — w2 · glm-5.3 · T1 · running · $0 · 30s");
    expect(lines[3]).toBe("└");
    expect(lines).toHaveLength(4);
  });

  it("lists pending approvals with their worker's label", () => {
    const { stream, task, items } = fanOut(TASK_ID);
    const w2 = items[1];
    if (w2 === undefined) throw new Error("fixture");
    stream.push(task.id, {
      type: "work_item.status_changed",
      workItemId: w2.id,
      from: "running",
      to: "waiting_approval",
    });
    stream.push(task.id, {
      type: "approval.requested",
      approval: approval(task.id, w2.id, "shell: rm -rf build"),
    });
    const lines = renderTree(fold(stream.events), T0 + 30_000);
    expect(lines[2]).toContain("⏸ url 2 — w2 · glm-5.3 · T1 · waiting approval");
    expect(lines[3]).toBe("│ ⏸ [w2] awaiting approval: shell: rm -rf build");
  });

  it("uses finishedAt rather than now once the task is over", () => {
    const { stream, finish } = fanOut(TASK_ID);
    finish();
    const folded = fold(stream.events);
    const a = renderTree(folded, T0 + 30_000);
    const b = renderTree(folded, T0 + 300_000);
    expect(a).toEqual(b);
    expect(a[0]).toContain("succeeded · 2/2 workers done · $0.02 spent (planning $0.02)");
  });
});

describe("costFooter", () => {
  it("summarises spend, worker count and elapsed on one feed line", () => {
    const { stream, finish } = fanOut(TASK_ID);
    finish();
    const footer = costFooter(fold(stream.events), T0 + 999_999);
    expect(footer).toBe("· $0.02 spent (planning $0.02) · 2 worker(s) · 18s");
    // Feed lines must stay bracket-free so piped output stays escape-code-free by inspection.
    expect(footer).not.toContain("[");
  });

  it("omits the planning share when the initiator spent nothing", () => {
    const { stream, task } = fanOut("task_zzzzzzzzzzzz");
    const folded = foldTask(stream.events, task.id);
    if (folded === undefined) throw new Error("fixture");
    const noPlanning = { ...folded, initiatorCostUsd: 0, costUsd: 0.001 };
    expect(costFooter(noPlanning, T0 + 5_000)).toBe("· $0.0010 spent · 2 worker(s) · 5.0s");
  });
});

describe("formatting", () => {
  it("usd follows the dashboard's rule", () => {
    expect(usd(0)).toBe("$0");
    expect(usd(0.0042)).toBe("$0.0042");
    expect(usd(1.371)).toBe("$1.37");
  });

  it("duration scales its unit", () => {
    expect(duration(840)).toBe("840ms");
    expect(duration(4_200)).toBe("4.2s");
    expect(duration(12_400)).toBe("12s");
    expect(duration(246_000)).toBe("4m 06s");
    expect(duration(-5)).toBe("0ms");
  });

  it("shortModelId drops the provider", () => {
    expect(shortModelId("anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(shortModelId("local-model")).toBe("local-model");
  });
});
