/**
 * The tmux mirror, tested without tmux.
 *
 * Both seams (`probe`, `runTmux`) are injected, and the log lands in a real
 * temp directory — the file is the artifact a human would attach to, so the
 * assertions read the actual bytes. In order of what would hurt most:
 *
 *  - **The mirror is optional and invisible.** No tmux = the same adapter
 *    object back, not a wrapper that half-works. With tmux, the inner session
 *    still gets every event, every send, the end and the kill — the harness
 *    cannot tell it is being watched.
 *  - **The watcher sees the whole story**: header, events rendered, steering
 *    (`⇄ user:` — mid-run send_to_worker is the feature the mirror exists to
 *    make visible), and an end line before the tmux session is killed.
 *  - **tmux lifecycle**: `new-session -d -s rwtr_<runId>` tailing the log;
 *    `kill-session` exactly once, even when the runner abandons iteration
 *    mid-stream (the abort path).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newWorkerRunId } from "@rewter/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventQueue } from "./claude-code.js";
import { renderEventLine, tmuxSessionName, withTmuxMirror } from "./tmux.js";
import type { HarnessAdapter, HarnessEvent, HarnessSession, HarnessSpec } from "./types.js";

let logsDir: string;
beforeEach(() => {
  logsDir = mkdtempSync(join(tmpdir(), "rewter-tmux-"));
});
afterEach(() => {
  rmSync(logsDir, { recursive: true, force: true });
});

interface InnerCalls {
  spawns: HarnessSpec[];
  sent: string[];
  ended: number;
  killed: number;
}

function innerAdapter(
  script: HarnessEvent[],
  opts: { closeAfterScript?: boolean } = {},
): { adapter: HarnessAdapter; calls: InnerCalls; queue: EventQueue } {
  const calls: InnerCalls = { spawns: [], sent: [], ended: 0, killed: 0 };
  const queue = new EventQueue();
  const adapter: HarnessAdapter = {
    id: "fake",
    displayName: "Fake Harness",
    spawn(spec: HarnessSpec): HarnessSession {
      calls.spawns.push(spec);
      for (const event of script) queue.push(event);
      if (opts.closeAfterScript !== false) queue.close();
      return {
        events: queue.events(),
        send: (m) => calls.sent.push(m),
        end: () => {
          calls.ended += 1;
        },
        kill: () => {
          calls.killed += 1;
        },
      };
    },
  };
  return { adapter, calls, queue };
}

const spec = (): HarnessSpec => ({
  instructions: "write hello.txt",
  cwd: "/tmp/ws/task",
  runId: newWorkerRunId(),
});

const turnEnd: HarnessEvent = {
  type: "turn_end",
  resultText: "done",
  isError: false,
  costUsd: 0.12,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
};

async function drain(events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function logText(): string {
  const files = readdirSync(logsDir);
  expect(files).toHaveLength(1);
  return readFileSync(join(logsDir, files[0] as string), "utf8");
}

describe("when tmux is missing", () => {
  it("returns the inner adapter itself — tier 3 unchanged, no wrapper", () => {
    const { adapter } = innerAdapter([turnEnd]);
    const wrapped = withTmuxMirror(adapter, {
      binary: "tmux",
      logsDir,
      probe: () => false,
      runTmux: () => {
        throw new Error("must never be called when the probe said no");
      },
    });
    expect(wrapped).toBe(adapter);
  });
});

describe("with tmux available", () => {
  function mirrored(script: HarnessEvent[], opts: { closeAfterScript?: boolean } = {}) {
    const inner = innerAdapter(script, opts);
    const tmuxCalls: string[][] = [];
    const wrapped = withTmuxMirror(inner.adapter, {
      binary: "tmux",
      logsDir,
      probe: () => true,
      runTmux: (args) => tmuxCalls.push(args),
    });
    return { ...inner, wrapped, tmuxCalls };
  }

  it("passes every event through unchanged and mirrors them to the log", async () => {
    const { wrapped } = mirrored([
      { type: "session", sessionId: "sess_1" },
      { type: "text", text: "reading the code" },
      { type: "tool_use", name: "Bash", detail: '{"command":"ls"}' },
      turnEnd,
    ]);
    const session = wrapped.spawn(spec());

    const events = await drain(session.events);

    expect(events.map((e) => e.type)).toEqual(["session", "text", "tool_use", "turn_end"]);
    const log = logText();
    expect(log).toContain("Fake Harness");
    expect(log).toContain("write hello.txt");
    expect(log).toContain("· session sess_1");
    expect(log).toContain("reading the code");
    expect(log).toContain('⚒ Bash {"command":"ls"}');
    expect(log).toContain("── turn end ($0.1200) ──");
    expect(log).toContain("── session ended ──");
  });

  it("names the session rwtr_<runId> and starts a detached tail of the log", () => {
    const { wrapped, tmuxCalls } = mirrored([turnEnd]);
    const s = spec();
    const session = wrapped.spawn(s);

    const name = tmuxSessionName(s.runId);
    expect(session.attach).toEqual({ session: name, command: `tmux attach -t ${name}` });
    expect(tmuxCalls).toHaveLength(1);
    const [newSession] = tmuxCalls;
    expect(newSession?.slice(0, 4)).toEqual(["new-session", "-d", "-s", name]);
    expect(newSession?.[4]).toContain("tail -n +1 -f");
    expect(newSession?.[4]).toContain(`${name}.log`);
  });

  it("mirrors steering, and forwards send/end/kill to the inner session", async () => {
    const { wrapped, calls } = mirrored([turnEnd]);
    const session = wrapped.spawn(spec());

    session.send("also create extra.txt");
    session.end();
    session.kill();
    await drain(session.events);

    expect(calls.sent).toEqual(["also create extra.txt"]);
    expect(calls.ended).toBe(1);
    expect(calls.killed).toBe(1);
    expect(logText()).toContain("⇄ user: also create extra.txt");
  });

  it("kills the tmux session exactly once when the stream ends", async () => {
    const { wrapped, tmuxCalls } = mirrored([turnEnd]);
    await drain(wrapped.spawn(spec()).events);

    const kills = tmuxCalls.filter((args) => args[0] === "kill-session");
    expect(kills).toHaveLength(1);
    expect(kills[0]?.[2]).toMatch(/^rwtr_/);
  });

  it("closes the mirror when the runner abandons iteration mid-stream", async () => {
    // The abort path: the runner's for-await exits via `finally`, never
    // exhausting the iterator. An orphaned `tail -f` session per cancelled
    // task is what this guards against.
    const { wrapped, tmuxCalls, queue } = mirrored([{ type: "text", text: "working…" }], {
      closeAfterScript: false,
    });
    const session = wrapped.spawn(spec());

    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);
    queue.close();

    expect(tmuxCalls.filter((args) => args[0] === "kill-session")).toHaveLength(1);
    expect(logText()).toContain("── session ended ──");
  });
});

describe("renderEventLine", () => {
  it("marks an error turn and omits the cost when there is none", () => {
    expect(
      renderEventLine({
        type: "turn_end",
        resultText: "nope",
        isError: true,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      }),
    ).toBe("── turn end — error ──");
    expect(renderEventLine({ type: "fatal", error: "gone" })).toBe("✖ gone");
  });
});
