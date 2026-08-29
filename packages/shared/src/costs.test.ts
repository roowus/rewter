/**
 * The cost aggregation.
 *
 * The interesting cases are not "does it add up" but the ones where a plausible
 * implementation quietly loses money: an un-attributed record dropped instead of
 * bucketed, an initiator/worker split that stops summing to the total, and a
 * day boundary that moves an hour of spend into the wrong day.
 */
import { describe, expect, it } from "vitest";
import { CostSummarySchema, NO_TASK_KEY, dayKey, summarizeCosts } from "./costs.js";
import { type CostRecord, CostRecordSchema } from "./entities.js";
import { ModelIdSchema, newCostRecordId, newTaskId, newWorkerRunId } from "./ids.js";

const sonnet = ModelIdSchema.parse("anthropic/claude-sonnet-5");
const glm = ModelIdSchema.parse("zai/glm-5.3");

// 2026-08-28T12:00:00Z — midday UTC, so a timezone shift moves the day.
const noon = Date.UTC(2026, 7, 28, 12, 0, 0);

const cost = (over: Partial<CostRecord> = {}): CostRecord =>
  CostRecordSchema.parse({
    id: newCostRecordId(),
    taskId: null,
    workerRunId: null,
    modelId: sonnet,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.01,
    pricingSnapshot: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    },
    createdAt: noon,
    ...over,
  });

describe("summarizeCosts", () => {
  it("returns an empty, valid summary for no records", () => {
    const summary = summarizeCosts([], { groupBy: "model" });
    expect(() => CostSummarySchema.parse(summary)).not.toThrow();
    expect(summary.buckets).toEqual([]);
    expect(summary.totals.costUsd).toBe(0);
    expect(summary.totals.calls).toBe(0);
  });

  it("splits the initiator's own tokens from delegated work", () => {
    // The question the whole cost design exists to answer: did the planner
    // cost more than the plan saved? A single total cannot say.
    const run = newWorkerRunId();
    const summary = summarizeCosts(
      [
        cost({ workerRunId: null, costUsd: 0.4 }),
        cost({ workerRunId: run, costUsd: 0.1, modelId: glm }),
        cost({ workerRunId: run, costUsd: 0.05, modelId: glm }),
      ],
      { groupBy: "model" },
    );
    expect(summary.totals.initiatorCostUsd).toBeCloseTo(0.4);
    expect(summary.totals.workerCostUsd).toBeCloseTo(0.15);
    expect(summary.totals.costUsd).toBeCloseTo(0.55);
  });

  it("keeps the split inside every bucket, not only the totals", () => {
    // A model used both as initiator and as a worker is the case where a
    // top-level-only split would look right and read wrong.
    const summary = summarizeCosts(
      [
        cost({ modelId: sonnet, workerRunId: null, costUsd: 0.3 }),
        cost({ modelId: sonnet, workerRunId: newWorkerRunId(), costUsd: 0.2 }),
      ],
      { groupBy: "model" },
    );
    expect(summary.buckets).toHaveLength(1);
    const [bucket] = summary.buckets;
    expect(bucket?.initiatorCostUsd).toBeCloseTo(0.3);
    expect(bucket?.workerCostUsd).toBeCloseTo(0.2);
    expect(bucket?.costUsd).toBeCloseTo(0.5);
  });

  it("sorts model buckets by spend, so the expensive thing is first", () => {
    const summary = summarizeCosts(
      [cost({ modelId: glm, costUsd: 0.02 }), cost({ modelId: sonnet, costUsd: 0.5 })],
      { groupBy: "model" },
    );
    expect(summary.buckets.map((b) => b.key)).toEqual([sonnet, glm]);
  });

  it("sorts day buckets forward in time instead of by spend", () => {
    const day = 86_400_000;
    const summary = summarizeCosts(
      [
        cost({ createdAt: noon, costUsd: 0.01 }),
        cost({ createdAt: noon - day, costUsd: 0.9 }),
        cost({ createdAt: noon + day, costUsd: 0.5 }),
      ],
      { groupBy: "day" },
    );
    expect(summary.buckets.map((b) => b.key)).toEqual(["2026-08-27", "2026-08-28", "2026-08-29"]);
  });

  it("buckets days in the requested zone, not the host's", () => {
    // 04:00 UTC on the 28th is still the 27th in Los Angeles. Bucketing it as
    // the 28th moves a night's spend into the next day's number.
    const earlyUtc = Date.UTC(2026, 7, 28, 4, 0, 0);
    const utc = summarizeCosts([cost({ createdAt: earlyUtc })], { groupBy: "day" });
    const la = summarizeCosts([cost({ createdAt: earlyUtc })], {
      groupBy: "day",
      timeZone: "America/Los_Angeles",
    });
    expect(utc.buckets[0]?.key).toBe("2026-08-28");
    expect(la.buckets[0]?.key).toBe("2026-08-27");
    // Echoed, so a page labels the column with the zone it was computed in.
    expect(la.timeZone).toBe("America/Los_Angeles");
  });

  it("defaults to UTC rather than whatever the machine is set to", () => {
    expect(summarizeCosts([], { groupBy: "day" }).timeZone).toBe("UTC");
  });

  it("buckets un-attributed spend rather than dropping it", () => {
    // A plain `/v1` pass-through has no task. It is still money.
    const task = newTaskId();
    const summary = summarizeCosts(
      [cost({ taskId: task, costUsd: 0.1 }), cost({ taskId: null, costUsd: 0.2 })],
      { groupBy: "task" },
    );
    expect(summary.buckets.map((b) => b.key)).toEqual([NO_TASK_KEY, task]);
    expect(summary.totals.costUsd).toBeCloseTo(0.3);
  });

  it("filters half-open so adjacent windows tile without double-counting", () => {
    const records = [
      cost({ createdAt: 1000, costUsd: 1 }),
      cost({ createdAt: 2000, costUsd: 2 }),
      cost({ createdAt: 3000, costUsd: 4 }),
    ];
    const first = summarizeCosts(records, { groupBy: "model", since: 1000, until: 2000 });
    const second = summarizeCosts(records, { groupBy: "model", since: 2000, until: 3000 });
    expect(first.totals.costUsd).toBe(1);
    expect(second.totals.costUsd).toBe(2);
    // The boundary record belongs to exactly one of the two windows.
    expect(first.totals.calls + second.totals.calls).toBe(2);
  });

  it("carries the window back in the response", () => {
    const summary = summarizeCosts([], { groupBy: "model", since: 5, until: 9 });
    expect(summary).toMatchObject({ since: 5, until: 9 });
    expect(summarizeCosts([], { groupBy: "model" })).toMatchObject({ since: null, until: null });
  });

  it("sums token columns alongside cost", () => {
    const summary = summarizeCosts(
      [
        cost({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 2 }),
        cost({ inputTokens: 30, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 1 }),
      ],
      { groupBy: "model" },
    );
    expect(summary.totals).toMatchObject({
      inputTokens: 40,
      outputTokens: 4,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      calls: 2,
    });
  });

  it("does not mutate the records it is given", () => {
    const records = [cost({ costUsd: 0.5 })];
    const before = JSON.stringify(records);
    summarizeCosts(records, { groupBy: "model" });
    expect(JSON.stringify(records)).toBe(before);
  });
});

describe("dayKey", () => {
  it("formats ISO-order regardless of the host locale", () => {
    expect(dayKey(Date.UTC(2026, 0, 5, 23, 59), "UTC")).toBe("2026-01-05");
  });
});
