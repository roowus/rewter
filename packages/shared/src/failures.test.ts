/**
 * The failure aggregation.
 *
 * What matters here is the split, not the sum: a summary that counts failures
 * without saying whether they happened before or after output would answer a
 * question nobody asked, and one that counts them without the successes beside
 * them would turn "3 failures" into a scare rather than a rate.
 */
import { describe, expect, it } from "vitest";
import {
  type CostRecord,
  CostRecordSchema,
  type FailureRecord,
  FailureRecordSchema,
} from "./entities.js";
import { FailureSummarySchema, NO_STATUS_KEY, summarizeFailures } from "./failures.js";
import { ModelIdSchema, newCostRecordId, newFailureRecordId } from "./ids.js";

const sonnet = ModelIdSchema.parse("anthropic/claude-sonnet-5");
const glm = ModelIdSchema.parse("zai/glm-5.3");
const PROVIDER = "prv_000000000001";

const noon = Date.UTC(2026, 8, 2, 12, 0, 0);

const failure = (over: Partial<FailureRecord> = {}): FailureRecord =>
  FailureRecordSchema.parse({
    id: newFailureRecordId(),
    taskId: null,
    workerRunId: null,
    modelId: sonnet,
    providerId: PROVIDER,
    attempt: 1,
    phase: "before_output",
    retried: true,
    retryable: true,
    statusCode: 503,
    message: "503 upstream unavailable",
    createdAt: noon,
    ...over,
  });

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
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    },
    createdAt: noon,
    ...over,
  });

describe("summarizeFailures", () => {
  it("returns an empty, valid summary for no records", () => {
    const summary = summarizeFailures([], []);
    expect(FailureSummarySchema.parse(summary)).toEqual(summary);
    expect(summary.totals).toEqual({
      failures: 0,
      beforeOutput: 0,
      midStream: 0,
      retried: 0,
      successes: 0,
      byStatus: {},
    });
    expect(summary.buckets).toEqual([]);
  });

  it("splits failures by phase — the number issue #9 is actually about", () => {
    const summary = summarizeFailures(
      [
        failure(),
        failure({ attempt: 2, retried: false }),
        failure({ phase: "mid_stream", retried: false, statusCode: null, message: "reset" }),
      ],
      [],
    );
    expect(summary.totals).toMatchObject({
      failures: 3,
      beforeOutput: 2,
      midStream: 1,
      retried: 1,
    });
  });

  it("puts successes beside failures so the count reads as a rate", () => {
    const summary = summarizeFailures(
      [failure({ phase: "mid_stream", retried: false })],
      [cost(), cost(), cost({ modelId: glm })],
    );
    expect(summary.totals.successes).toBe(3);
    const row = summary.buckets.find((b) => b.key === sonnet);
    expect(row).toMatchObject({ failures: 1, midStream: 1, successes: 2 });
    // A model that only succeeded still has a row: zero-of-many is the comparison.
    expect(summary.buckets.find((b) => b.key === glm)).toMatchObject({
      failures: 0,
      successes: 1,
      lastMessage: null,
    });
  });

  it("sorts the model that is hurting most to the top", () => {
    const summary = summarizeFailures(
      [failure({ modelId: glm }), failure({ modelId: glm }), failure()],
      [cost(), cost(), cost(), cost()],
    );
    expect(summary.buckets.map((b) => b.key)).toEqual([glm, sonnet]);
  });

  it("keys status counts by status, with a name for no status", () => {
    const summary = summarizeFailures(
      [
        failure({ statusCode: 429 }),
        failure({ statusCode: 429 }),
        failure({ statusCode: null, message: "stream ended without finish_reason" }),
      ],
      [],
    );
    expect(summary.totals.byStatus).toEqual({ "429": 2, [NO_STATUS_KEY]: 1 });
  });

  it("remembers the newest failure per model, not the first", () => {
    const summary = summarizeFailures(
      [
        failure({ createdAt: noon, message: "older" }),
        failure({ createdAt: noon + 1000, message: "newer" }),
        failure({ createdAt: noon + 500, message: "middle" }),
      ],
      [],
    );
    expect(summary.buckets[0]).toMatchObject({ lastMessage: "newer", lastAt: noon + 1000 });
  });

  it("filters both record kinds half-open on the same window", () => {
    const summary = summarizeFailures(
      [
        failure({ createdAt: noon - 1 }),
        failure({ createdAt: noon }),
        failure({ createdAt: noon + 10 }),
      ],
      [cost({ createdAt: noon - 1 }), cost({ createdAt: noon }), cost({ createdAt: noon + 10 })],
      { since: noon, until: noon + 10 },
    );
    expect(summary.totals.failures).toBe(1);
    expect(summary.totals.successes).toBe(1);
    expect(summary).toMatchObject({ since: noon, until: noon + 10 });
  });
});
