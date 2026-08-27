/**
 * Narration tests.
 *
 * These are format assertions, which usually earn their keep poorly — except
 * that this format is the *only* thing the user sees while an orchestration
 * runs, and two properties genuinely matter: one event is one line (a provider
 * stack trace must not blow the feed apart), and a sub-cent cost must not render
 * as "$0.00", which reads as free rather than cheap.
 */
import { describe, expect, it } from "vitest";
import {
  GLYPH,
  askUserLine,
  formatCost,
  formatDuration,
  handoffLine,
  noteLine,
  planLine,
  workerCancelledLine,
  workerDoneLine,
  workerFailedLine,
  workerStartLine,
} from "./narrate.js";

describe("progress lines", () => {
  it("prefixes each line with its own glyph", () => {
    expect(planLine("split the work three ways")).toBe("◆ plan: split the work three ways");
    expect(
      workerStartLine({ label: "w1", modelId: "zai/glm-5.3", tier: 1, title: "summarize" }),
    ).toBe("▶ [w1 · zai/glm-5.3 · tier1] summarize — started");
    expect(workerDoneLine({ label: "w1", costUsd: 0.0032, durationMs: 2_400 })).toBe(
      "✔ [w1] done ($0.0032, 2.4s)",
    );
    expect(workerFailedLine({ label: "w2", error: "429 rate limited" })).toBe(
      "✖ [w2] failed: 429 rate limited",
    );
    expect(workerCancelledLine({ label: "w3" })).toBe("⊘ [w3] cancelled");
    expect(workerCancelledLine({ label: "w3", reason: "no longer needed" })).toBe(
      "⊘ [w3] cancelled: no longer needed",
    );
    expect(noteLine("budget: $0.40 of $1.00 spent")).toBe("· budget: $0.40 of $1.00 spent");
  });

  it("appends the dashboard url to the plan line only when there is one", () => {
    expect(planLine("go", "http://localhost:20130/t/task_x")).toContain(
      "(dashboard: http://localhost:20130/t/task_x)",
    );
    expect(planLine("go")).not.toContain("dashboard");
  });

  it("tells the user how to answer an ask_user question", () => {
    const line = askUserLine("Which repo?", "task_abc");
    expect(line.startsWith(GLYPH.paused)).toBe(true);
    expect(line).toContain("Which repo?");
    expect(line).toContain("task_abc");
  });

  it("names the successor and the reason on a handoff", () => {
    expect(
      handoffLine({ toModel: "anthropic/claude-opus-5", reason: "needs deeper reasoning" }),
    ).toBe("⇄ handing off to anthropic/claude-opus-5: needs deeper reasoning");
  });

  /**
   * The one that actually catches bugs: an upstream error arrives with a stack
   * trace attached often enough that a multi-line progress line would be a
   * regular occurrence, not an edge case.
   */
  it("keeps a multi-line error to one line", () => {
    const stack = "Error: socket hang up\n    at TLSSocket.onHangUp\n    at emitOne";
    const line = workerFailedLine({ label: "w1", error: stack });
    expect(line.includes("\n")).toBe(false);
    expect(line).toBe("✖ [w1] failed: Error: socket hang up");
  });

  it("clamps an absurdly long single-line error", () => {
    const line = workerFailedLine({ label: "w1", error: "x".repeat(500) });
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThan(220);
  });

  it("survives an empty error string without producing a bare glyph line", () => {
    expect(workerFailedLine({ label: "w1", error: "" })).toBe("✖ [w1] failed: ");
  });
});

describe("formatCost", () => {
  it("distinguishes unknown, free, and cheap", () => {
    // Three different facts that a naive "$0.00" would render identically.
    expect(formatCost(null)).toBe("cost n/a");
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.0004)).toBe("$0.0004");
  });

  it("uses two decimals once the cost is worth reading in cents", () => {
    expect(formatCost(0.01)).toBe("$0.01");
    expect(formatCost(1.239)).toBe("$1.24");
  });
});

describe("formatDuration", () => {
  it("scales the unit to the magnitude", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(940)).toBe("940ms");
    expect(formatDuration(1_000)).toBe("1.0s");
    expect(formatDuration(12_340)).toBe("12.3s");
    expect(formatDuration(65_000)).toBe("1m5s");
    expect(formatDuration(3_600_000)).toBe("60m0s");
  });

  it("never reports a negative duration from a jittery clock", () => {
    expect(formatDuration(-5)).toBe("0ms");
  });
});
