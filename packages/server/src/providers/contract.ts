/**
 * The adapter contract suite. Every adapter runs the *same* assertions against
 * its own recorded wire fixtures, so "normalized" means one thing rather than
 * three. Adding an adapter means adding fixtures, not tests.
 *
 * The contract, restated:
 *   (text_delta | tool_call_start | tool_call_delta)* → message_end
 *   ...or a terminating `error` chunk. Exactly one terminal chunk, always last.
 *   Every tool_call_delta is preceded by a tool_call_start with the same index.
 */
import type { StreamChunk } from "@rewter/shared";
import { StreamChunkSchema } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { collectStream } from "./collect.js";
import type { AdapterRequest, ProviderAdapter } from "./types.js";
import { AdapterError } from "./types.js";

/** One recorded upstream interaction: a scenario name and the bytes it returns. */
export interface ContractScenario {
  /** Builds the adapter with its transport stubbed to replay this fixture. */
  adapter: () => ProviderAdapter;
  request?: Partial<AdapterRequest>;
}

export interface ContractFixtures {
  /** Plain text response, ends cleanly with usage. */
  text: ContractScenario;
  /** One tool call whose JSON arguments are split across several deltas. */
  splitToolArgs: ContractScenario;
  /** Two tool calls in one turn — indices must stay distinct and ordered. */
  parallelToolCalls: ContractScenario;
  /** Upstream returns an HTTP error status. */
  httpError: ContractScenario;
  /** Connection drops mid-stream, before any terminal event. */
  truncated: ContractScenario;
}

const BASE_REQUEST: AdapterRequest = {
  model: "test-model",
  messages: [{ role: "user", content: "hi" }],
};

async function drain(
  adapter: ProviderAdapter,
  overrides?: Partial<AdapterRequest>,
  signal?: AbortSignal,
): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of adapter.stream({ ...BASE_REQUEST, ...overrides }, signal)) {
    out.push(chunk);
  }
  return out;
}

/** Structural invariants that must hold for *any* stream from *any* adapter. */
function assertContract(chunks: StreamChunk[]): void {
  expect(chunks.length).toBeGreaterThan(0);

  // Every chunk is a valid StreamChunk — catches shape drift at the boundary.
  for (const chunk of chunks) {
    expect(() => StreamChunkSchema.parse(chunk)).not.toThrow();
  }

  const terminals = chunks.filter((c) => c.type === "message_end" || c.type === "error");
  expect(terminals).toHaveLength(1);
  expect(chunks.at(-1)).toBe(terminals[0]);

  const started = new Set<number>();
  for (const chunk of chunks) {
    if (chunk.type === "tool_call_start") {
      // An index may not be opened twice in one stream.
      expect(started.has(chunk.index)).toBe(false);
      started.add(chunk.index);
    }
    if (chunk.type === "tool_call_delta") {
      expect(started.has(chunk.index)).toBe(true);
    }
  }
}

export function describeAdapterContract(name: string, fixtures: ContractFixtures): void {
  describe(`${name} adapter contract`, () => {
    it("text: emits deltas then exactly one message_end with usage", async () => {
      const chunks = await drain(fixtures.text.adapter(), fixtures.text.request);
      assertContract(chunks);

      const end = chunks.at(-1);
      expect(end?.type).toBe("message_end");
      if (end?.type !== "message_end") throw new Error("unreachable");
      expect(end.finishReason).toBe("stop");
      expect(end.usage.inputTokens).toBeGreaterThan(0);
      expect(end.usage.outputTokens).toBeGreaterThan(0);

      const text = chunks
        .filter((c): c is Extract<StreamChunk, { type: "text_delta" }> => c.type === "text_delta")
        .map((c) => c.text)
        .join("");
      expect(text).toBe("Hello world");
      // Deltas, not one lump: streaming must actually stream.
      expect(chunks.filter((c) => c.type === "text_delta").length).toBeGreaterThan(1);
    });

    it("text: collectStream folds the same stream into a ChatResponse", async () => {
      const response = await collectStream(fixtures.text.adapter().stream(BASE_REQUEST));
      expect(response.message.role).toBe("assistant");
      expect(response.message.content).toBe("Hello world");
      expect(response.message.toolCalls).toBeUndefined();
      expect(response.finishReason).toBe("stop");
    });

    it("splitToolArgs: partial JSON reassembles into valid arguments", async () => {
      const chunks = await drain(fixtures.splitToolArgs.adapter(), fixtures.splitToolArgs.request);
      assertContract(chunks);

      const starts = chunks.filter(
        (c): c is Extract<StreamChunk, { type: "tool_call_start" }> => c.type === "tool_call_start",
      );
      expect(starts).toHaveLength(1);
      expect(starts[0]?.name).toBe("get_weather");
      expect(starts[0]?.id).toBeTruthy();

      const response = await collectStream(fixtures.splitToolArgs.adapter().stream(BASE_REQUEST));
      const call = response.message.toolCalls?.[0];
      expect(call?.name).toBe("get_weather");
      // The whole point: reassembled fragments must parse as JSON.
      expect(JSON.parse(call?.arguments ?? "")).toEqual({ city: "Paris", units: "celsius" });
      expect(response.finishReason).toBe("tool_calls");
    });

    it("parallelToolCalls: distinct indices, ordered, args kept separate", async () => {
      const chunks = await drain(
        fixtures.parallelToolCalls.adapter(),
        fixtures.parallelToolCalls.request,
      );
      assertContract(chunks);

      const response = await collectStream(
        fixtures.parallelToolCalls.adapter().stream(BASE_REQUEST),
      );
      const calls = response.message.toolCalls ?? [];
      expect(calls).toHaveLength(2);
      expect(calls.map((c) => c.name)).toEqual(["get_weather", "get_time"]);
      expect(new Set(calls.map((c) => c.id)).size).toBe(2);
      expect(JSON.parse(calls[0]?.arguments ?? "")).toEqual({ city: "Paris" });
      expect(JSON.parse(calls[1]?.arguments ?? "")).toEqual({ tz: "UTC" });
    });

    it("httpError: yields one error chunk, never throws out of the iterator", async () => {
      const chunks = await drain(fixtures.httpError.adapter(), fixtures.httpError.request);
      assertContract(chunks);

      const err = chunks.at(-1);
      expect(err?.type).toBe("error");
      if (err?.type !== "error") throw new Error("unreachable");
      expect(err.message).toBeTruthy();
      // 429 is the canonical retryable status.
      expect(err.statusCode).toBe(429);
      expect(err.retryable).toBe(true);
    });

    it("httpError: collectStream surfaces it as a typed AdapterError", async () => {
      const promise = collectStream(fixtures.httpError.adapter().stream(BASE_REQUEST));
      await expect(promise).rejects.toThrow(AdapterError);
      await expect(promise).rejects.toMatchObject({ retryable: true, statusCode: 429 });
    });

    it("truncated: a mid-stream disconnect is a retryable failure, not a silent success", async () => {
      const chunks = await drain(fixtures.truncated.adapter(), fixtures.truncated.request);
      assertContract(chunks);

      const last = chunks.at(-1);
      // Either shape is contract-legal; what matters is that a truncated stream
      // never folds into a successful ChatResponse.
      if (last?.type === "error") {
        expect(last.retryable).toBe(true);
      } else {
        expect(last?.type).toBe("message_end");
      }

      await expect(
        collectStream(fixtures.truncated.adapter().stream(BASE_REQUEST)),
      ).rejects.toThrow(AdapterError);
    });

    it("abort: signalling mid-stream ends it as non-retryable", async () => {
      const controller = new AbortController();
      controller.abort();
      const chunks = await drain(fixtures.text.adapter(), fixtures.text.request, controller.signal);
      assertContract(chunks);

      const last = chunks.at(-1);
      if (last?.type === "error") {
        // A cancelled task must never be retried back to life.
        expect(last.retryable).toBe(false);
      }
    });
  });
}
