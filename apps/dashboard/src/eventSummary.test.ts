/**
 * The one-line renderer. What is provable here is the rule, not each string:
 * approvals render their summary verbatim (the line a decision is made from),
 * transitions render as transitions, money keeps its sub-cent digits (the same
 * rule as the costs panel), and long text truncates rather than wrapping the
 * table into a ribbon.
 */
import type { EventEnvelope } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { describeEvent, oneLine } from "./eventSummary.js";

const wrap = (payload: EventEnvelope["payload"]): EventEnvelope["payload"] => payload;

describe("describeEvent", () => {
  it("renders an approval request's summary verbatim — the decision is made from this line", () => {
    const line = describeEvent(
      wrap({
        type: "approval.requested",
        approval: {
          id: "apr_1" as never,
          taskId: "task_1" as never,
          workItemId: null,
          workerRunId: null,
          status: "pending",
          kind: "shell",
          summary: "shell: rm -rf build/ && make",
          detail: null,
          resolvedBy: null,
          resolutionNote: null,
          createdAt: 0,
          resolvedAt: null,
        },
      }),
    );
    expect(line).toBe("shell: rm -rf build/ && make");
  });

  it("renders a transition as the transition", () => {
    expect(
      describeEvent(
        wrap({
          type: "task.status_changed",
          taskId: "task_1" as never,
          from: "running",
          to: "succeeded",
        }),
      ),
    ).toBe("running → succeeded");
  });

  it("keeps sub-cent money readable — a $0.0042 worker is not free", () => {
    const line = describeEvent(
      wrap({
        type: "cost.recorded",
        cost: {
          id: "cst_1" as never,
          taskId: null,
          workerRunId: null,
          modelId: "zai/glm-5.3" as never,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.0042,
          pricingSnapshot: {
            inputPerMTok: 1,
            outputPerMTok: 2,
          } as never,
          createdAt: 0,
        },
      }),
    );
    expect(line).toBe("$0.0042 · glm-5.3");
  });

  it("names the handoff's destination and reason", () => {
    expect(
      describeEvent(
        wrap({
          type: "handoff.initiated",
          taskId: "task_1" as never,
          fromWorkItemId: null,
          toModelId: "anthropic/claude-opus-5",
          reason: "needs deeper reasoning than I can offer",
        }),
      ),
    ).toBe("→ claude-opus-5 — needs deeper reasoning than I can offer");
  });

  it("shows progress and steering text as written", () => {
    expect(
      describeEvent(
        wrap({
          type: "worker_run.progress",
          workerRunId: "run_1" as never,
          text: "reading 3 files",
        }),
      ),
    ).toBe("reading 3 files");
  });
});

describe("oneLine", () => {
  it("leaves short text alone", () => {
    expect(oneLine("short")).toBe("short");
  });

  it("truncates long text on a word boundary", () => {
    const long = "word ".repeat(60).trim();
    const cut = oneLine(long);
    expect(cut.length).toBeLessThanOrEqual(141);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.slice(0, -1)).not.toMatch(/[^…]\s$/);
  });
});
