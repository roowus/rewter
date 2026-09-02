/**
 * Same three layers as claude-code.test.ts: `jsonlToEvents` is pure and
 * carries the defensive-parsing promise; the queue's ordering guarantee is
 * pinned once in claude-code.test.ts (same class); and the adapter is
 * exercised against real processes — stub CLIs in every parse mode plus a
 * missing binary — because spawn/stdin/stdout plumbing is exactly the part a
 * pure test cannot vouch for.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newWorkerRunId } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { type GenericHarnessOptions, createGenericAdapter, jsonlToEvents } from "./generic.js";
import type { HarnessEvent, HarnessSession } from "./types.js";

const RUN_ID = newWorkerRunId();

describe("jsonlToEvents", () => {
  it("parses the four event shapes", () => {
    expect(jsonlToEvents('{"type":"session","sessionId":"s-1"}')).toEqual([
      { type: "session", sessionId: "s-1" },
    ]);
    expect(jsonlToEvents('{"type":"text","text":"working on it"}')).toEqual([
      { type: "text", text: "working on it" },
    ]);
    expect(jsonlToEvents('{"type":"tool_use","name":"shell","detail":"ls -la"}')).toEqual([
      { type: "tool_use", name: "shell", detail: "ls -la" },
    ]);
    expect(
      jsonlToEvents(
        '{"type":"turn_end","resultText":"done","isError":false,"costUsd":0.12,"inputTokens":10,"outputTokens":20,"cacheReadTokens":1,"cacheWriteTokens":2}',
      ),
    ).toEqual([
      {
        type: "turn_end",
        resultText: "done",
        isError: false,
        costUsd: 0.12,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
      },
    ]);
  });

  it("fills a minimal turn_end with honest defaults — nulls, not zeros", () => {
    expect(jsonlToEvents('{"type":"turn_end"}')).toEqual([
      {
        type: "turn_end",
        resultText: "",
        isError: false,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
    ]);
  });

  it("skips what it does not understand, never throws", () => {
    expect(jsonlToEvents("not json at all")).toEqual([]);
    expect(jsonlToEvents('{"type":"heartbeat"}')).toEqual([]);
    expect(jsonlToEvents('{"type":"fatal","error":"nope"}')).toEqual([]); // not the process's to declare
    expect(jsonlToEvents('{"type":"text"}')).toEqual([]); // missing field
    expect(jsonlToEvents('{"type":"session","sessionId":""}')).toEqual([]); // empty id
  });

  it("drops whitespace-only text and clamps tool detail to one bounded line", () => {
    expect(jsonlToEvents('{"type":"text","text":"  \\n  "}')).toEqual([]);
    const long = "x".repeat(300);
    const [event] = jsonlToEvents(
      `{"type":"tool_use","name":"shell","detail":"a\\n b   c${long}"}`,
    );
    expect(event?.type).toBe("tool_use");
    if (event?.type === "tool_use") {
      expect(event.detail.length).toBeLessThanOrEqual(120);
      expect(event.detail).toContain("a b c");
      expect(event.detail.endsWith("…")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Real processes. Each stub is a tiny executable node script.
// ---------------------------------------------------------------------------

function stubBinary(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rewter-generic-stub-"));
  const path = join(dir, "stub");
  writeFileSync(path, `#!/usr/bin/env node\n${script}`);
  chmodSync(path, 0o755);
  return path;
}

async function collect(session: HarnessSession): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of session.events) events.push(event);
  return events;
}

function opts(
  over: Partial<GenericHarnessOptions> & Pick<GenericHarnessOptions, "binary" | "parse">,
): GenericHarnessOptions {
  return { id: "stub", ...over };
}

const SPEC = { instructions: "do the thing", cwd: tmpdir() } as const;

describe("createGenericAdapter — jsonl mode", () => {
  it("streams events from a jsonl process fed via stdin", async () => {
    const binary = stubBinary(`
      let buf = "";
      process.stdin.on("data", (d) => {
        buf += d.toString("utf8");
        const nl = buf.indexOf("\\n");
        if (nl === -1) return;
        const task = buf.slice(0, nl);
        const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
        say({ type: "session", sessionId: "gs-1" });
        console.log("log noise the parser must skip");
        say({ type: "text", text: "task was: " + task });
        say({ type: "turn_end", resultText: "did: " + task });
        process.exit(0);
      });
    `);
    const adapter = createGenericAdapter(opts({ binary, parse: "jsonl" }));
    const events = await collect(adapter.spawn({ ...SPEC, runId: RUN_ID }));
    expect(events).toEqual([
      { type: "session", sessionId: "gs-1" },
      { type: "text", text: "task was: do the thing" },
      expect.objectContaining({
        type: "turn_end",
        resultText: "did: do the thing",
        isError: false,
      }),
    ]);
  });

  it("delivers instructions via argv when the template mentions {instructions}", async () => {
    const binary = stubBinary(`
      console.log(JSON.stringify({ type: "turn_end", resultText: "argv: " + process.argv.slice(2).join(" ") }));
    `);
    const adapter = createGenericAdapter(
      opts({ binary, parse: "jsonl", args: ["--task", "{instructions}", "--dir", "{cwd}"] }),
    );
    const events = await collect(adapter.spawn({ ...SPEC, runId: RUN_ID }));
    const end = events.find((e) => e.type === "turn_end");
    expect(end?.type === "turn_end" && end.resultText).toBe(
      `argv: --task do the thing --dir ${tmpdir()}`,
    );
  });

  it("exit without a turn_end is a fatal carrying the stderr tail", async () => {
    const binary = stubBinary(`
      process.stderr.write("auth expired, run login\\n");
      process.exit(1);
    `);
    const adapter = createGenericAdapter(opts({ binary, parse: "jsonl" }));
    const events = await collect(adapter.spawn({ ...SPEC, runId: RUN_ID }));
    expect(events).toHaveLength(1);
    const [fatal] = events;
    expect(fatal?.type).toBe("fatal");
    if (fatal?.type === "fatal") {
      expect(fatal.error).toContain("exited (code 1) without a result");
      expect(fatal.error).toContain("auth expired");
    }
  });
});

describe("createGenericAdapter — plain mode", () => {
  it("with a donePattern: lines are text, the sentinel ends the turn and is excluded", async () => {
    const binary = stubBinary(`
      process.stdin.once("data", () => {
        console.log("step one");
        console.log("step two");
        console.log("DONE");
        process.exit(0);
      });
    `);
    const adapter = createGenericAdapter(opts({ binary, parse: "plain", donePattern: "^DONE$" }));
    const events = await collect(adapter.spawn({ ...SPEC, runId: RUN_ID }));
    expect(events).toEqual([
      { type: "text", text: "step one" },
      { type: "text", text: "step two" },
      expect.objectContaining({
        type: "turn_end",
        resultText: "step one\nstep two",
        isError: false,
        costUsd: null,
      }),
    ]);
  });

  it("without a donePattern: exit 0 is the turn end with accumulated stdout", async () => {
    const binary = stubBinary(`
      process.stdin.once("data", () => {
        console.log("all output");
        console.log("is the result");
        process.exit(0);
      });
    `);
    const adapter = createGenericAdapter(opts({ binary, parse: "plain" }));
    const events = await collect(adapter.spawn({ ...SPEC, runId: RUN_ID }));
    const end = events.at(-1);
    expect(end).toEqual(
      expect.objectContaining({
        type: "turn_end",
        resultText: "all output\nis the result",
        isError: false,
      }),
    );
  });

  it("without a donePattern: non-zero exit is a failed turn, not a fatal", async () => {
    const binary = stubBinary(`
      process.stdin.once("data", () => {
        console.log("tried this");
        process.exit(2);
      });
    `);
    const adapter = createGenericAdapter(opts({ binary, parse: "plain" }));
    const events = await collect(adapter.spawn({ ...SPEC, runId: RUN_ID }));
    const end = events.at(-1);
    expect(end).toEqual(
      expect.objectContaining({ type: "turn_end", resultText: "tried this", isError: true }),
    );
  });

  it("non-zero exit with empty stdout reports the stderr tail as the failure text", async () => {
    const binary = stubBinary(`
      process.stdin.once("data", () => {
        process.stderr.write("config file not found");
        process.exit(1);
      });
    `);
    const adapter = createGenericAdapter(opts({ binary, parse: "plain" }));
    const events = await collect(adapter.spawn({ ...SPEC, runId: RUN_ID }));
    expect(events).toEqual([
      expect.objectContaining({
        type: "turn_end",
        resultText: "config file not found",
        isError: true,
      }),
    ]);
  });

  it("a final line without a trailing newline still lands before the turn end", async () => {
    const binary = stubBinary(`
      process.stdin.once("data", () => {
        process.stdout.write("no newline at eof");
        process.exit(0);
      });
    `);
    const adapter = createGenericAdapter(opts({ binary, parse: "plain" }));
    const events = await collect(adapter.spawn({ ...SPEC, runId: RUN_ID }));
    expect(events).toEqual([
      { type: "text", text: "no newline at eof" },
      expect.objectContaining({ type: "turn_end", resultText: "no newline at eof" }),
    ]);
  });
});

describe("createGenericAdapter — plumbing", () => {
  it("a missing binary is a single fatal, not a throw", async () => {
    const adapter = createGenericAdapter(
      opts({ binary: "/nonexistent/definitely-not-a-real-binary", parse: "jsonl" }),
    );
    const events = await collect(adapter.spawn({ ...SPEC, runId: RUN_ID }));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("fatal");
    if (events[0]?.type === "fatal") expect(events[0].error).toContain("could not start");
  });

  it("kill() ends the stream without a fatal", async () => {
    const binary = stubBinary("process.stdin.resume();");
    const adapter = createGenericAdapter(opts({ binary, parse: "plain" }));
    const session = adapter.spawn({ ...SPEC, runId: RUN_ID });
    setTimeout(() => session.kill(), 50);
    const events = await collect(session);
    expect(events.filter((e) => e.type === "fatal")).toEqual([]);
  });

  it("resume without resumeArgs is a loud fatal, never a silent fresh start", async () => {
    const binary = stubBinary("process.exit(0);");
    const adapter = createGenericAdapter(opts({ binary, parse: "jsonl" }));
    const events = await collect(
      adapter.spawn({ ...SPEC, runId: RUN_ID, resumeSessionId: "old-session" }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("fatal");
    if (events[0]?.type === "fatal") expect(events[0].error).toContain("cannot resume");
  });

  it("resumeArgs are appended with {sessionId} substituted, only when resuming", async () => {
    const binary = stubBinary(`
      console.log(JSON.stringify({ type: "turn_end", resultText: "argv: " + process.argv.slice(2).join(" ") }));
    `);
    const adapter = createGenericAdapter(
      opts({ binary, parse: "jsonl", args: ["run"], resumeArgs: ["--continue", "{sessionId}"] }),
    );
    const fresh = await collect(adapter.spawn({ ...SPEC, runId: RUN_ID }));
    const freshEnd = fresh.find((e) => e.type === "turn_end");
    expect(freshEnd?.type === "turn_end" && freshEnd.resultText).toBe("argv: run");

    const resumed = await collect(
      adapter.spawn({ ...SPEC, runId: RUN_ID, resumeSessionId: "sess-9" }),
    );
    const resumedEnd = resumed.find((e) => e.type === "turn_end");
    expect(resumedEnd?.type === "turn_end" && resumedEnd.resultText).toBe(
      "argv: run --continue sess-9",
    );
  });

  it("send() delivers plain stdin lines mid-session (REPL-style multi-turn)", async () => {
    const binary = stubBinary(`
      let turns = 0;
      const rl = require("node:readline").createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        console.log("heard: " + line);
        console.log("DONE");
        turns += 1;
        if (turns === 2) process.exit(0);
      });
    `);
    const adapter = createGenericAdapter(opts({ binary, parse: "plain", donePattern: "^DONE$" }));
    const session = adapter.spawn({ ...SPEC, runId: RUN_ID });
    const events: HarnessEvent[] = [];
    for await (const event of session.events) {
      events.push(event);
      // First turn boundary: steer, exactly as the runner's inbox drain would.
      if (event.type === "turn_end" && events.filter((e) => e.type === "turn_end").length === 1) {
        session.send("follow-up question");
      }
    }
    const turnEnds = events.filter((e) => e.type === "turn_end");
    expect(turnEnds).toHaveLength(2);
    expect(turnEnds[0]).toEqual(expect.objectContaining({ resultText: "heard: do the thing" }));
    expect(turnEnds[1]).toEqual(
      expect.objectContaining({ resultText: "heard: follow-up question" }),
    );
  });

  it("displayName defaults to the id", () => {
    const a = createGenericAdapter(opts({ binary: "x", parse: "plain" }));
    expect(a.id).toBe("stub");
    expect(a.displayName).toBe("stub");
    const b = createGenericAdapter(opts({ binary: "x", parse: "plain", displayName: "My CLI" }));
    expect(b.displayName).toBe("My CLI");
  });
});
