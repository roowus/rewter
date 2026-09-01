/**
 * Claude Code adapter tests.
 *
 * Three layers, tested at three costs:
 *
 *  - **`toEvents` is pure** and carries the defensive-parsing promise: every
 *    wire shape we read, every shape we skip, and the guarantee that no line —
 *    garbage, half-JSON, future block types — ever throws. The wire format
 *    belongs to another program's release cycle, so "skip" beats "reject".
 *  - **`EventQueue` is the ordering guarantee.** "A fatal event is always the
 *    last event" (types.ts) rests entirely on close() draining before ending
 *    iteration; a queue that dropped buffered events on close would turn every
 *    crash report into a silent empty stream.
 *  - **The adapter is exercised against real processes** — a stub NDJSON
 *    "harness" and a missing binary — because the spawn/stdin/stdout plumbing
 *    is exactly the part a pure test cannot vouch for.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newWorkerRunId } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { EventQueue, createClaudeCodeAdapter, toEvents, userFrame } from "./claude-code.js";
import type { HarnessEvent, HarnessSession } from "./types.js";

const RUN_ID = newWorkerRunId();

async function collect(session: HarnessSession): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of session.events) events.push(event);
  return events;
}

describe("toEvents", () => {
  it("reads the init line as a session event", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", session_id: "sess_1" });
    expect(toEvents(line)).toEqual([{ type: "session", sessionId: "sess_1" }]);
  });

  it("reads text and tool_use blocks, skipping block types it does not know", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "reading the config" },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    expect(toEvents(line)).toEqual([
      { type: "text", text: "reading the config" },
      { type: "tool_use", name: "Bash", detail: '{"command":"ls"}' },
    ]);
  });

  it("drops whitespace-only text blocks rather than emitting empty feed lines", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "  \n " }] },
    });
    expect(toEvents(line)).toEqual([]);
  });

  it("bounds tool detail to one display-sized line", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Write", input: { content: "x".repeat(500) } }],
      },
    });
    const events = toEvents(line);
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event?.type !== "tool_use") throw new Error("expected a tool_use event");
    expect(event.detail.length).toBeLessThanOrEqual(120);
    expect(event.detail.endsWith("…")).toBe(true);
  });

  it("reads a full result line with cost and usage", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: false,
      result: "done.\nSUMMARY: did the thing",
      total_cost_usd: 0.42,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 7,
      },
    });
    expect(toEvents(line)).toEqual([
      {
        type: "turn_end",
        resultText: "done.\nSUMMARY: did the thing",
        isError: false,
        costUsd: 0.42,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 30,
        cacheWriteTokens: 7,
      },
    ]);
  });

  it("degrades a minimal result line to nulls, never to zeros", () => {
    // Zeros would be recorded as "this turn was free"; nulls are "the harness
    // did not say", which the runner's cost recorder knows to skip.
    const line = JSON.stringify({ type: "result", is_error: true });
    expect(toEvents(line)).toEqual([
      {
        type: "turn_end",
        resultText: "",
        isError: true,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
    ]);
  });

  it("skips what it cannot parse — garbage, unknown types, wrong shapes — without throwing", () => {
    for (const line of [
      "not json at all",
      '{"type": "unterminated',
      JSON.stringify({ type: "user", message: {} }),
      JSON.stringify({ type: "system", subtype: "hook", session_id: "s" }),
      JSON.stringify({ type: "assistant", message: { content: "a plain string" } }),
      "[]",
      "null",
      "42",
    ]) {
      expect(toEvents(line), `line=${line}`).toEqual([]);
    }
  });
});

describe("userFrame", () => {
  it("wraps text in a stream-json user frame with a trailing newline", () => {
    const frame = userFrame("fix the tests");
    expect(frame.endsWith("\n")).toBe(true);
    expect(JSON.parse(frame)).toEqual({
      type: "user",
      message: { role: "user", content: "fix the tests" },
    });
  });
});

describe("EventQueue", () => {
  const text = (t: string): HarnessEvent => ({ type: "text", text: t });

  it("delivers buffered events in order, then ends on close", async () => {
    const queue = new EventQueue();
    queue.push(text("a"));
    queue.push(text("b"));
    queue.close();

    const seen: string[] = [];
    for await (const event of queue.events()) {
      if (event.type === "text") seen.push(event.text);
    }
    expect(seen).toEqual(["a", "b"]);
  });

  it("delivers a fatal pushed just before close — the 'fatal is always last' guarantee", async () => {
    const queue = new EventQueue();
    queue.push(text("progress"));
    queue.push({ type: "fatal", error: "it died" });
    queue.close();

    const seen: HarnessEvent[] = [];
    for await (const event of queue.events()) seen.push(event);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ type: "fatal", error: "it died" });
  });

  it("wakes a parked consumer when an event arrives, and again on close", async () => {
    const queue = new EventQueue();
    const collected = (async () => {
      const seen: HarnessEvent[] = [];
      for await (const event of queue.events()) seen.push(event);
      return seen;
    })();

    // Parked now: nothing buffered. Push, give the microtask a beat, close.
    queue.push(text("late"));
    await new Promise((r) => setTimeout(r, 0));
    queue.close();

    expect(await collected).toEqual([text("late")]);
  });

  it("drops pushes after close instead of resurrecting a finished stream", async () => {
    const queue = new EventQueue();
    queue.push(text("kept"));
    queue.close();
    queue.push(text("dropped"));

    const seen: HarnessEvent[] = [];
    for await (const event of queue.events()) seen.push(event);
    expect(seen).toEqual([text("kept")]);
  });
});

describe("the adapter, against real processes", () => {
  /**
   * A stub "Claude Code": reads one stdin frame, answers with the three wire
   * shapes the adapter reads, exits. The CLI flags the adapter passes land in
   * argv and are ignored, which is exactly what makes the stub a stand-in.
   */
  function stubBinary(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), "rewter-harness-stub-"));
    const path = join(dir, "stub.js");
    writeFileSync(path, `#!/usr/bin/env node\n${script}`);
    chmodSync(path, 0o755);
    return path;
  }

  const ECHO_STUB = `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  const nl = buf.indexOf("\\n");
  if (nl === -1) return;
  const frame = JSON.parse(buf.slice(0, nl));
  const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  say({ type: "system", subtype: "init", session_id: "sess_stub" });
  console.log("--verbose noise the parser must skip");
  say({ type: "assistant", message: { content: [{ type: "text", text: "working on: " + frame.message.content }] } });
  say({ type: "result", is_error: false, result: "did: " + frame.message.content, total_cost_usd: 0.01 });
  process.exit(0);
});
`;

  it("spawns, writes the instructions as the first frame, and streams normalized events", async () => {
    const adapter = createClaudeCodeAdapter({
      binary: stubBinary(ECHO_STUB),
      permissionMode: "acceptEdits",
    });
    const session = adapter.spawn({
      instructions: "count the TODOs",
      cwd: tmpdir(),
      runId: RUN_ID,
    });

    const events = await collect(session);
    expect(events).toEqual([
      { type: "session", sessionId: "sess_stub" },
      { type: "text", text: "working on: count the TODOs" },
      {
        type: "turn_end",
        resultText: "did: count the TODOs",
        isError: false,
        costUsd: 0.01,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
    ]);
  });

  it("turns a missing binary into a fatal event, not a throw", async () => {
    const adapter = createClaudeCodeAdapter({
      binary: "/definitely/not/a/real/binary/rewter-test",
      permissionMode: "acceptEdits",
    });
    const session = adapter.spawn({ instructions: "anything", cwd: tmpdir(), runId: RUN_ID });

    const events = await collect(session);
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event?.type !== "fatal") throw new Error("expected a fatal event");
    expect(event.error).toContain("could not start");
  });

  it("reports a resultless exit as fatal, carrying the stderr tail", async () => {
    const stub = stubBinary(`
process.stderr.write("Invalid API key. Run /login.");
process.exit(1);
`);
    const adapter = createClaudeCodeAdapter({ binary: stub, permissionMode: "acceptEdits" });
    const session = adapter.spawn({ instructions: "anything", cwd: tmpdir(), runId: RUN_ID });

    const events = await collect(session);
    const fatal = events.find((e) => e.type === "fatal");
    if (fatal?.type !== "fatal") throw new Error("expected a fatal event");
    expect(fatal.error).toContain("exited (code 1) without a result");
    expect(fatal.error).toContain("Invalid API key");
  });

  it("kill() ends the stream without a fatal — the runner knows why it killed", async () => {
    // A stub that answers nothing and waits forever on stdin.
    const stub = stubBinary("process.stdin.resume();");
    const adapter = createClaudeCodeAdapter({ binary: stub, permissionMode: "acceptEdits" });
    const session = adapter.spawn({ instructions: "anything", cwd: tmpdir(), runId: RUN_ID });

    setTimeout(() => session.kill(), 50);
    const events = await collect(session);
    expect(events.filter((e) => e.type === "fatal")).toEqual([]);
  });

  it("passes --model through to argv when configured, and omits it when not", async () => {
    const ARGV_STUB = `
const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
say({ type: "result", is_error: false, result: "argv: " + process.argv.slice(2).join(" ") });
process.exit(0);
`;
    const stub = stubBinary(ARGV_STUB);

    const pinned = createClaudeCodeAdapter({
      binary: stub,
      permissionMode: "acceptEdits",
      model: "claude-sonnet-5",
    });
    const pinnedEvents = await collect(
      pinned.spawn({ instructions: "anything", cwd: tmpdir(), runId: RUN_ID }),
    );
    const pinnedEnd = pinnedEvents.find((e) => e.type === "turn_end");
    if (pinnedEnd?.type !== "turn_end") throw new Error("expected a turn_end event");
    expect(pinnedEnd.resultText).toContain("--model claude-sonnet-5");

    const unpinned = createClaudeCodeAdapter({ binary: stub, permissionMode: "acceptEdits" });
    const unpinnedEvents = await collect(
      unpinned.spawn({ instructions: "anything", cwd: tmpdir(), runId: RUN_ID }),
    );
    const unpinnedEnd = unpinnedEvents.find((e) => e.type === "turn_end");
    if (unpinnedEnd?.type !== "turn_end") throw new Error("expected a turn_end event");
    expect(unpinnedEnd.resultText).not.toContain("--model");
  });

  it("strips the router env so the harness cannot recurse into the daemon", async () => {
    const stub = stubBinary(`
const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
say({ type: "result", is_error: false, result: "base_url=" + (process.env.ANTHROPIC_BASE_URL ?? "unset") + " token=" + (process.env.ANTHROPIC_AUTH_TOKEN ?? "unset") });
process.exit(0);
`);
    process.env.ANTHROPIC_BASE_URL = "http://localhost:20130/v1";
    process.env.ANTHROPIC_AUTH_TOKEN = "rewter-test-token";
    try {
      const adapter = createClaudeCodeAdapter({ binary: stub, permissionMode: "acceptEdits" });
      const session = adapter.spawn({ instructions: "anything", cwd: tmpdir(), runId: RUN_ID });
      const events = await collect(session);
      const end = events.find((e) => e.type === "turn_end");
      if (end?.type !== "turn_end") throw new Error("expected a turn_end event");
      expect(end.resultText).toBe("base_url=unset token=unset");
    } finally {
      // biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"
      delete process.env.ANTHROPIC_BASE_URL;
      // biome-ignore lint/performance/noDelete: same — delete is the only true unset
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });
});
