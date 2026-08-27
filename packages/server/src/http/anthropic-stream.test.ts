/**
 * The translator is stateful, so these tests are about *sequences*, not single
 * frames: which block is open when, that it gets closed before the next opens,
 * and that a message always terminates. A client assembling content into the
 * wrong index is the failure mode these guard.
 */
import { describe, expect, it } from "vitest";
import { end, err, text, toolDelta, toolStart } from "../testing/fake-adapter.js";
import { AnthropicStreamTranslator } from "./anthropic-stream.js";

const ctx = { id: "msg_test", model: "anthropic/claude-sonnet-5" };

/** Feed chunks through a fresh translator, collecting every event in order. */
function run(chunks: Parameters<AnthropicStreamTranslator["next"]>[0][]) {
  const t = new AnthropicStreamTranslator(ctx);
  const events = [t.start()];
  for (const chunk of chunks) events.push(...t.next(chunk));
  events.push(...t.finishIfOpen());
  return events;
}

const types = (events: { type: string }[]) => events.map((e) => e.type);

describe("AnthropicStreamTranslator", () => {
  it("wraps text deltas in a single content block", () => {
    const events = run([text("hello"), text(" world"), end()]);

    expect(types(events)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    // One block opened once, not one per delta.
    expect(events.filter((e) => e.type === "content_block_start")).toHaveLength(1);
  });

  it("reports real usage on message_delta, zeros on message_start", () => {
    const events = run([text("hi"), end("stop", { inputTokens: 12, outputTokens: 3 })]);

    const start = events[0] as { message: { usage: unknown } };
    expect(start.message.usage).toEqual({ input_tokens: 0, output_tokens: 0 });

    const delta = events.find((e) => e.type === "message_delta") as { usage: unknown };
    expect(delta.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
  });

  it("surfaces cache tokens when the upstream reports them", () => {
    const events = run([end("stop", { cacheReadTokens: 900, cacheWriteTokens: 100 })]);
    const delta = events.find((e) => e.type === "message_delta") as {
      usage: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    };

    expect(delta.usage.cache_read_input_tokens).toBe(900);
    expect(delta.usage.cache_creation_input_tokens).toBe(100);
  });

  it("closes the text block before opening a tool_use block", () => {
    const events = run([
      text("let me look"),
      toolStart(0, "toolu_1", "get_weather"),
      toolDelta(0, '{"city":'),
      toolDelta(0, '"Paris"}'),
      end("tool_calls"),
    ]);

    expect(types(events)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      // The text block is closed before the tool block opens — emitting a
      // start while another block is open is a protocol violation.
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const indices = events
      .filter((e) => e.type.startsWith("content_block"))
      .map((e) => (e as { index: number }).index);
    expect(indices).toEqual([0, 0, 0, 1, 1, 1, 1]);
  });

  it("gives each parallel tool call its own block index", () => {
    const events = run([
      toolStart(0, "toolu_1", "a"),
      toolDelta(0, "{}"),
      toolStart(1, "toolu_2", "b"),
      toolDelta(1, "{}"),
      end("tool_calls"),
    ]);

    const starts = events.filter((e) => e.type === "content_block_start") as {
      index: number;
      content_block: { id: string; name: string; input: unknown };
    }[];
    expect(starts.map((s) => s.index)).toEqual([0, 1]);
    expect(starts.map((s) => s.content_block.id)).toEqual(["toolu_1", "toolu_2"]);
    // Input opens empty; `input_json_delta` frames fill it.
    expect(starts[0]?.content_block.input).toEqual({});
  });

  it("streams tool arguments as input_json_delta, not text_delta", () => {
    const events = run([toolStart(0, "toolu_1", "f"), toolDelta(0, '{"x":1}'), end("tool_calls")]);
    const delta = events.find((e) => e.type === "content_block_delta") as {
      delta: { type: string; partial_json: string };
    };

    expect(delta.delta).toEqual({ type: "input_json_delta", partial_json: '{"x":1}' });
  });

  it("maps finish reasons to Anthropic stop reasons", () => {
    const stopFor = (reason: Parameters<typeof end>[0]) => {
      const events = run([end(reason)]);
      return (events.find((e) => e.type === "message_delta") as { delta: { stop_reason: string } })
        .delta.stop_reason;
    };

    expect(stopFor("stop")).toBe("end_turn");
    expect(stopFor("tool_calls")).toBe("tool_use");
    expect(stopFor("length")).toBe("max_tokens");
    expect(stopFor("content_filter")).toBe("refusal");
  });

  it("terminates the message after a mid-stream error", () => {
    const events = run([text("partial"), err("upstream exploded", false, 500)]);

    // The error is reported *and* the message closed: a client that ignores
    // the error event must not hang waiting for message_stop.
    expect(types(events)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "error",
      "message_delta",
      "message_stop",
    ]);
    expect(
      (events.find((e) => e.type === "error") as { error: { message: string } }).error,
    ).toEqual({ type: "api_error", message: "upstream exploded" });
  });

  it("closes a stream that ended without any terminal chunk", () => {
    // A caller-side throw mid-iteration: no message_end, no error chunk.
    const t = new AnthropicStreamTranslator(ctx);
    const events = [t.start(), ...t.next(text("truncated")), ...t.finishIfOpen()];

    expect(types(events)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  it("does not double-terminate an already-closed message", () => {
    const t = new AnthropicStreamTranslator(ctx);
    t.start();
    t.next(text("hi"));
    t.next(end());

    expect(t.finishIfOpen()).toEqual([]);
  });
});
