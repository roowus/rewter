import { PassThrough } from "node:stream";
import { type EventEnvelope, type Project, ProjectSchema, newProjectId } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { chatCommand } from "./chat.js";
import { Stream, fanOut, task as taskEntity } from "./fold-fixtures.js";
import type { SocketFactory, SocketLike } from "./watch.js";

const TASK_ID = "task_abcdefghijkl";

/**
 * The daemon's socket, driven by the test. By default it opens and immediately
 * replays a task that is already terminal, so the end-of-turn settle is instant
 * and the footer prints; a test that wants a live tree passes `events` instead
 * and pushes them itself.
 */
class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners: Record<string, Array<(ev: unknown) => void>> = {};

  constructor(readonly taskId: string) {}

  addEventListener(type: string, listener: (ev: never) => void): void {
    const list = this.listeners[type] ?? [];
    list.push(listener as (ev: unknown) => void);
    this.listeners[type] = list;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.emit("open", undefined);
  }
  event(event: EventEnvelope): void {
    this.emit("message", { data: JSON.stringify({ type: "event", event }) });
  }
  hangUp(code: number, reason?: string): void {
    this.emit("close", { code, reason });
  }
  private emit(type: string, ev: unknown): void {
    for (const l of this.listeners[type] ?? []) l(ev);
  }
}

/** A task that has already finished, as the socket would replay it. */
function settledReplay(taskId: string): EventEnvelope[] {
  const s = new Stream();
  const t = taskEntity(taskId);
  s.push(t.id, { type: "task.created", task: t });
  s.push(t.id, { type: "task.status_changed", taskId: t.id, from: "pending", to: "running" });
  s.push(t.id, { type: "task.status_changed", taskId: t.id, from: "running", to: "succeeded" });
  return s.events;
}

type SocketMode = "settled" | "manual" | "refused";

function fakeSockets(mode: SocketMode = "settled"): {
  factory: SocketFactory;
  opened: FakeSocket[];
} {
  const opened: FakeSocket[] = [];
  const factory: SocketFactory = (url) => {
    if (mode === "refused") throw new Error(`no socket to ${url}`);
    const socket = new FakeSocket(TASK_ID);
    opened.push(socket);
    // Open on the next tick, as a real upgrade would — never synchronously inside the constructor.
    queueMicrotask(() => {
      socket.open();
      if (mode === "settled") for (const ev of settledReplay(TASK_ID)) socket.event(ev);
    });
    return socket;
  };
  return { factory, opened };
}

function project(slug: string, dir: string): Project {
  return ProjectSchema.parse({
    id: newProjectId(),
    slug,
    name: slug,
    resources: [{ kind: "dir", location: dir }],
    createdAt: 1_724_800_000_000,
    updatedAt: 1_724_800_000_000,
  });
}

/** An SSE body whose frames are pushed by the test, so steering can happen mid-stream. */
function liveBody(): {
  body: ReadableStream<Uint8Array>;
  push: (payload: unknown) => void;
  done: () => void;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    body,
    push: (payload) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)),
    done: () => {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  };
}

function textChunk(text: string): unknown {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "auto/orchestrator",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

interface FakeDaemonOptions {
  taskId?: string | undefined;
  steer?: (message: string) => Response;
  /** How many completions to expect — one live feed each. Default 1. */
  turns?: number;
  /** What `GET /internal/projects` returns. Default: none. */
  projects?: Project[];
}

/**
 * The whole daemon surface the chat command touches, as one routed fetch.
 * Discovery is skipped by pointing REWTER_URL at it, so no health route needed.
 * `feed` is the first turn's body; `feeds[n]` the n-th, for multi-turn tests.
 */
function fakeDaemon(opts: FakeDaemonOptions = {}) {
  const feeds = Array.from({ length: opts.turns ?? 1 }, () => liveBody());
  const feed = feeds[0] as ReturnType<typeof liveBody>;
  const completions: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const steers: string[] = [];
  const cancels: string[] = [];
  let projectLookups = 0;
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/internal/projects") {
      projectLookups += 1;
      return new Response(JSON.stringify({ projects: opts.projects ?? [] }), { status: 200 });
    }
    if (path === "/v1/chat/completions") {
      const body = feeds[completions.length]?.body;
      if (body === undefined) throw new Error(`unexpected completion #${completions.length + 1}`);
      completions.push({
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const headers: Record<string, string> = { "content-type": "text/event-stream" };
      if (opts.taskId !== undefined) headers["x-rewter-task-id"] = opts.taskId;
      return new Response(body, { status: 200, headers });
    }
    if (path === `/internal/tasks/${TASK_ID}/steer`) {
      const message = (JSON.parse(String(init?.body)) as { message: string }).message;
      steers.push(message);
      if (opts.steer !== undefined) return opts.steer(message);
      return new Response(
        JSON.stringify({ taskId: TASK_ID, queued: true, remainder: message, approvals: 0 }),
        { status: 202 },
      );
    }
    if (path === `/internal/tasks/${TASK_ID}/cancel`) {
      cancels.push(path);
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected request: ${path}`);
  }) as typeof globalThis.fetch;
  return {
    fetch,
    feed,
    feeds,
    completions,
    steers,
    cancels,
    get projectLookups() {
      return projectLookups;
    },
  };
}

interface LaunchOptions {
  socket?: SocketMode;
  cwd?: string;
}

/**
 * Run chatCommand against the fake daemon with piped (non-TTY) io. `done()` is
 * EOF on stdin then the exit code — the session outlives its first turn, so a
 * test that wants a one-shot run has to hang up like a pipe would. The socket is
 * always faked: the default `nodeSocket` would really dial the loopback port.
 */
function launch(args: string[], daemon: ReturnType<typeof fakeDaemon>, lo: LaunchOptions = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += String(chunk);
  });
  const sockets = fakeSockets(lo.socket);
  const exit = chatCommand(args, {
    env: { REWTER_URL: "http://127.0.0.1:20180" },
    fetch: daemon.fetch,
    pidfilePath: "/nonexistent/rewter.pid",
    io: { input, output },
    socket: sockets.factory,
    cwd: lo.cwd ?? "/nowhere/in/particular",
    now: () => 1_724_800_000_000 + 60_000,
  });
  const done = (): Promise<number> => {
    input.end();
    return exit;
  };
  return { input, exit, done, output: () => rendered, sockets: sockets.opened };
}

/** Poll until a condition holds — steering rides async fetches the test can't await directly. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("chatCommand", () => {
  it("runs a task to completion and renders the feed as plain lines", async () => {
    const daemon = fakeDaemon({ taskId: TASK_ID });
    const { done, output } = launch(["summarize", "the", "thing"], daemon);
    daemon.feed.push(textChunk("◆ plan: one worker\n"));
    daemon.feed.push(textChunk("✔ done\nthe answer\n"));
    daemon.feed.done();
    expect(await done()).toBe(0);
    expect(output()).toContain(`· task ${TASK_ID}`);
    expect(output()).toContain("◆ plan: one worker");
    expect(output()).toContain("the answer");
    // Piped output must be escape-code free — plain lines only.
    expect(output()).not.toContain("[");
    expect(daemon.completions[0]?.body.messages).toEqual([
      { role: "user", content: "summarize the thing" },
    ]);
    expect(daemon.completions[0]?.body.model).toBe("auto/orchestrator");
    // …and no tree either: a tree that cannot be redrawn is a log spammer.
    expect(output()).not.toContain("┌");
  });

  describe("live tree and footer", () => {
    it("subscribes to the task over the socket and prints the cost footer after the answer", async () => {
      const daemon = fakeDaemon({ taskId: TASK_ID });
      const { done, output, sockets } = launch(["task"], daemon);
      daemon.feed.push(textChunk("\n"));
      daemon.feed.push(textChunk("the answer"));
      daemon.feed.done();
      expect(await done()).toBe(0);
      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.sent.map((s) => JSON.parse(s))).toEqual([
        { type: "subscribe", taskId: TASK_ID },
      ]);
      expect(sockets[0]?.closed).toBe(true);
      // The task in the replay finished 3s after it was created and had no workers.
      expect(output()).toContain("the answer\n· $0 spent · 0 worker(s) · 3.0s\n");
      expect(output()).not.toContain("");
    });

    it("keeps the footer out of the assistant turn", async () => {
      const daemon = fakeDaemon({ taskId: TASK_ID, turns: 2 });
      const { input, done, output } = launch(["q1"], daemon);
      daemon.feed.push(textChunk("\n"));
      daemon.feed.push(textChunk("a1"));
      daemon.feed.done();
      await until(() => output().endsWith("worker(s) · 3.0s\n› "), "footer then prompt");
      input.write("q2\n");
      await until(() => daemon.completions.length === 2, "turn 2");
      expect(daemon.completions[1]?.body.messages).toEqual([
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ]);
      daemon.feeds[1]?.done();
      expect(await done()).toBe(0);
    });

    it("folds a fan-out into worker counts and spend", async () => {
      const daemon = fakeDaemon({ taskId: TASK_ID });
      const { done, output, sockets } = launch(["task"], daemon, { socket: "manual" });
      await until(() => sockets.length === 1, "the socket");
      const socket = sockets[0] as FakeSocket;
      const { stream, finish } = fanOut(TASK_ID);
      finish();
      for (const ev of stream.events) socket.event(ev);
      daemon.feed.push(textChunk("\n"));
      daemon.feed.push(textChunk("compared"));
      daemon.feed.done();
      expect(await done()).toBe(0);
      expect(output()).toContain("compared\n· $0.02 spent (planning $0.02) · 2 worker(s) · 18s\n");
    });

    it("says once that the tree is off when the socket cannot connect, and still finishes", async () => {
      const daemon = fakeDaemon({ taskId: TASK_ID });
      const { done, output } = launch(["task"], daemon, { socket: "refused" });
      daemon.feed.push(textChunk("\n"));
      daemon.feed.push(textChunk("the answer"));
      daemon.feed.done();
      expect(await done()).toBe(0);
      expect(output()).toContain(
        "· no live tree — socket unavailable: no socket to ws://127.0.0.1:20180/internal/ws",
      );
      expect(output()).toContain("the answer");
    });

    it("waits for the socket to agree the task is over before printing the footer", async () => {
      const daemon = fakeDaemon({ taskId: TASK_ID });
      const { done, output, sockets } = launch(["task"], daemon, { socket: "manual" });
      await until(() => sockets.length === 1, "the socket");
      const socket = sockets[0] as FakeSocket;
      const replay = settledReplay(TASK_ID);
      // Stream ends first; the terminal event lands on the socket afterwards.
      for (const ev of replay.slice(0, 2)) socket.event(ev);
      daemon.feed.push(textChunk("answer"));
      daemon.feed.done();
      await until(() => output().includes("answer\n"), "the answer");
      await new Promise((r) => setTimeout(r, 30));
      expect(output()).not.toContain("spent");
      for (const ev of replay.slice(2)) socket.event(ev);
      expect(await done()).toBe(0);
      expect(output()).toContain("· $0 spent · 0 worker(s) · 3.0s");
    });

    it("opens no socket for a pass-through model, which has no task", async () => {
      const daemon = fakeDaemon({});
      const { done, output, sockets } = launch(["--model", "some/model", "hi"], daemon);
      daemon.feed.push(textChunk("Hello"));
      daemon.feed.done();
      expect(await done()).toBe(0);
      expect(sockets).toHaveLength(0);
      expect(output()).not.toContain("spent");
    });
  });

  describe("project auto-select", () => {
    const clarity = project("clarity", "/Users/me/projects/clarity");

    it("picks the project whose directory contains the cwd, says so, and sends the header", async () => {
      const daemon = fakeDaemon({ taskId: TASK_ID, projects: [clarity] });
      const { done, output } = launch(["go"], daemon, { cwd: "/Users/me/projects/clarity/src" });
      await until(() => daemon.completions.length === 1, "the task to start");
      daemon.feed.done();
      expect(await done()).toBe(0);
      expect(output()).toContain(
        "· project clarity (from cwd; -p <slug> or --no-project to override)",
      );
      expect(daemon.completions[0]?.headers["x-rewter-project"]).toBe("clarity");
      expect(daemon.projectLookups).toBe(1);
    });

    it("sends no header when the cwd is in no project", async () => {
      const daemon = fakeDaemon({ taskId: TASK_ID, projects: [clarity] });
      const { done, output } = launch(["go"], daemon, { cwd: "/tmp" });
      await until(() => daemon.completions.length === 1, "the task to start");
      daemon.feed.done();
      expect(await done()).toBe(0);
      expect(output()).not.toContain("· project");
      expect(daemon.completions[0]?.headers["x-rewter-project"]).toBeUndefined();
    });

    it("lets -p override the cwd match without a lookup", async () => {
      const daemon = fakeDaemon({ taskId: TASK_ID, projects: [clarity] });
      const { done, output } = launch(["-p", "other", "go"], daemon, {
        cwd: "/Users/me/projects/clarity",
      });
      await until(() => daemon.completions.length === 1, "the task to start");
      daemon.feed.done();
      expect(await done()).toBe(0);
      expect(daemon.completions[0]?.headers["x-rewter-project"]).toBe("other");
      expect(daemon.projectLookups).toBe(0);
      expect(output()).not.toContain("from cwd");
    });

    it("--no-project opts out of the lookup entirely", async () => {
      const daemon = fakeDaemon({ taskId: TASK_ID, projects: [clarity] });
      const { done } = launch(["--no-project", "go"], daemon, {
        cwd: "/Users/me/projects/clarity",
      });
      await until(() => daemon.completions.length === 1, "the task to start");
      daemon.feed.done();
      expect(await done()).toBe(0);
      expect(daemon.completions[0]?.headers["x-rewter-project"]).toBeUndefined();
      expect(daemon.projectLookups).toBe(0);
      expect(daemon.completions[0]?.body.messages).toEqual([{ role: "user", content: "go" }]);
    });
  });

  it("steers mid-run: a typed line POSTs immediately and echoes as queued", async () => {
    const daemon = fakeDaemon({ taskId: TASK_ID });
    const { input, done, output } = launch(["long", "task"], daemon);
    daemon.feed.push(textChunk("▶ [w1] started\n"));
    await until(() => output().includes("[w1] started"), "the feed to start rendering");

    input.write("also check the tests\n");
    await until(() => daemon.steers.length === 1, "the steer POST");
    expect(daemon.steers[0]).toBe("also check the tests");

    daemon.feed.done();
    expect(await done()).toBe(0);
    expect(output()).toContain("· queued for the initiator: also check the tests");
  });

  it("echoes applied approval commands distinctly from queued text", async () => {
    const daemon = fakeDaemon({
      taskId: TASK_ID,
      steer: () =>
        new Response(
          JSON.stringify({ taskId: TASK_ID, queued: false, remainder: "", approvals: 2 }),
          { status: 202 },
        ),
    });
    const { input, done, output } = launch(["task"], daemon);
    input.write("approve all\n");
    await until(() => daemon.steers.length === 1, "the steer POST");
    daemon.feed.done();
    expect(await done()).toBe(0);
    expect(output()).toContain("· 2 approval command(s) applied");
    expect(output()).not.toContain("queued for the initiator");
  });

  it("keeps two quick lines in order", async () => {
    const daemon = fakeDaemon({ taskId: TASK_ID });
    const { input, done } = launch(["task"], daemon);
    input.write("first\nsecond\n");
    await until(() => daemon.steers.length === 2, "both steer POSTs");
    expect(daemon.steers).toEqual(["first", "second"]);
    daemon.feed.done();
    expect(await done()).toBe(0);
  });

  it("says so when steering fails", async () => {
    const daemon = fakeDaemon({
      taskId: TASK_ID,
      steer: () =>
        new Response(JSON.stringify({ error: { message: "task is already succeeded" } }), {
          status: 409,
        }),
    });
    const { input, done, output } = launch(["task"], daemon);
    input.write("too late\n");
    await until(() => daemon.steers.length === 1, "the steer POST");
    daemon.feed.done();
    expect(await done()).toBe(0);
    expect(output()).toContain("· steering failed: task is already succeeded");
  });

  it("explains why steering is unavailable without a task id", async () => {
    // Pass-through routes carry no x-rewter-task-id; typing at them can't work.
    const daemon = fakeDaemon({});
    const { input, done, output } = launch(["--model", "some/model", "task"], daemon);
    input.write("hello?\n");
    await until(() => output().includes("cannot steer"), "the cannot-steer note");
    daemon.feed.done();
    expect(await done()).toBe(0);
    expect(daemon.steers).toHaveLength(0);
  });

  it("asks for the first line when no prompt is given on argv", async () => {
    const daemon = fakeDaemon({ taskId: TASK_ID });
    const { input, done, output } = launch([], daemon);
    await until(() => output().includes("›"), "the prompt");
    input.write("do it interactively\n");
    await until(() => daemon.completions.length === 1, "the task to start");
    daemon.feed.done();
    expect(await done()).toBe(0);
    expect(daemon.completions[0]?.body.messages).toEqual([
      { role: "user", content: "do it interactively" },
    ]);
  });

  it("refuses an empty instruction", async () => {
    const daemon = fakeDaemon({});
    const { input, exit, output } = launch([], daemon);
    input.write("   \n");
    expect(await exit).toBe(1);
    expect(output()).toContain("nothing to do");
    expect(daemon.completions).toHaveLength(0);
  });

  it("forwards --project as the routing header and --model into the body", async () => {
    const daemon = fakeDaemon({ taskId: TASK_ID });
    const { done } = launch(["--project", "clarity", "--model", "auto/orchestrator", "go"], daemon);
    await until(() => daemon.completions.length === 1, "the task to start");
    daemon.feed.done();
    expect(await done()).toBe(0);
    expect(daemon.completions[0]?.headers["x-rewter-project"]).toBe("clarity");
  });

  it("fails cleanly when no daemon is discoverable", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => {
      rendered += String(chunk);
    });
    const exit = await chatCommand(["task"], {
      env: {},
      fetch: globalThis.fetch,
      pidfilePath: "/nonexistent/rewter.pid",
      io: { input, output },
    });
    expect(exit).toBe(1);
    expect(rendered).toContain("rewter is not running");
  });

  it("relays a pre-stream refusal and exits 1", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
        status: 401,
      })) as unknown as typeof globalThis.fetch;
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => {
      rendered += String(chunk);
    });
    const exit = await chatCommand(["task"], {
      env: { REWTER_URL: "http://127.0.0.1:20180" },
      fetch,
      pidfilePath: "/nonexistent/rewter.pid",
      io: { input, output },
    });
    expect(exit).toBe(1);
    expect(rendered).toContain("invalid api key");
  });

  it("renders a mid-stream error and exits 1", async () => {
    const daemon = fakeDaemon({ taskId: TASK_ID });
    const { exit, output } = launch(["task"], daemon);
    daemon.feed.push(textChunk("partial\n"));
    daemon.feed.push({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "auto/orchestrator",
      choices: [{ index: 0, delta: {}, finish_reason: null }],
      error: { message: "provider fell over", type: "upstream", code: null },
    });
    daemon.feed.done();
    expect(await exit).toBe(1);
    expect(output()).toContain("✖ provider fell over");
  });

  it("flushes a final line that has no trailing newline", async () => {
    const daemon = fakeDaemon({ taskId: TASK_ID });
    const { done, output } = launch(["task"], daemon);
    daemon.feed.push(textChunk("the last word"));
    daemon.feed.done();
    expect(await done()).toBe(0);
    expect(output()).toContain("the last word");
  });

  describe("follow-up turns", () => {
    it("carries the conversation: the next line starts a new task with [user, assistant, user]", async () => {
      const daemon = fakeDaemon({ taskId: TASK_ID, turns: 2 });
      const { input, done, output } = launch(["first", "question"], daemon);
      // The engine's shape: progress lines, a separator delta, then the answer alone.
      daemon.feed.push(textChunk("◆ plan: one worker\n"));
      daemon.feed.push(textChunk("✔ [w1] done ($0.0010, 1s)\n"));
      daemon.feed.push(textChunk("\n"));
      daemon.feed.push(textChunk("the first answer"));
      daemon.feed.done();
      await until(
        () => output().endsWith("the first answer\n· $0 spent · 0 worker(s) · 3.0s\n› "),
        "the follow-up prompt",
      );

      input.write("and a follow-up\n");
      await until(() => daemon.completions.length === 2, "the second task to start");
      expect(daemon.completions[1]?.body.messages).toEqual([
        { role: "user", content: "first question" },
        { role: "assistant", content: "the first answer" },
        { role: "user", content: "and a follow-up" },
      ]);
      // A fresh task each turn — the daemon has no session, the messages are it.
      expect(daemon.completions[1]?.body.model).toBe("auto/orchestrator");

      daemon.feeds[1]?.push(textChunk("\n"));
      daemon.feeds[1]?.push(textChunk("the second answer"));
      daemon.feeds[1]?.done();
      expect(await done()).toBe(0);
      expect(output()).toContain("the second answer");
    });

    it("keeps growing the history across three turns", async () => {
      const daemon = fakeDaemon({ taskId: TASK_ID, turns: 3 });
      const { input, done, output } = launch(["q1"], daemon);
      daemon.feed.push(textChunk("a1"));
      daemon.feed.done();
      await until(
        () => output().endsWith("a1\n· $0 spent · 0 worker(s) · 3.0s\n› "),
        "prompt after turn 1",
      );
      input.write("q2\n");
      await until(() => daemon.completions.length === 2, "turn 2");
      daemon.feeds[1]?.push(textChunk("a2"));
      daemon.feeds[1]?.done();
      // Typed *after* the answer landed — while the stream is open it would be steering.
      await until(
        () => output().endsWith("a2\n· $0 spent · 0 worker(s) · 3.0s\n› "),
        "prompt after turn 2",
      );
      input.write("q3\n");
      await until(() => daemon.completions.length === 3, "turn 3");
      expect(daemon.completions[2]?.body.messages).toEqual([
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "q3" },
      ]);
      daemon.feeds[2]?.done();
      expect(await done()).toBe(0);
    });

    it("forwards --project on every turn", async () => {
      const daemon = fakeDaemon({ taskId: TASK_ID, turns: 2 });
      const { input, done, output } = launch(["-p", "clarity", "q1"], daemon);
      daemon.feed.push(textChunk("a1"));
      daemon.feed.done();
      await until(
        () => output().endsWith("a1\n· $0 spent · 0 worker(s) · 3.0s\n› "),
        "prompt after turn 1",
      );
      input.write("q2\n");
      await until(() => daemon.completions.length === 2, "turn 2");
      expect(daemon.completions[1]?.headers["x-rewter-project"]).toBe("clarity");
      daemon.feeds[1]?.done();
      expect(await done()).toBe(0);
    });

    it("skips blank lines at the follow-up prompt instead of starting a task", async () => {
      const daemon = fakeDaemon({ taskId: TASK_ID, turns: 2 });
      const { input, done, output } = launch(["q1"], daemon);
      daemon.feed.push(textChunk("a1"));
      daemon.feed.done();
      await until(
        () => output().endsWith("a1\n· $0 spent · 0 worker(s) · 3.0s\n› "),
        "the follow-up prompt",
      );
      input.write("\n   \n");
      await until(
        () => output().endsWith("a1\n· $0 spent · 0 worker(s) · 3.0s\n› › › "),
        "re-prompts for each blank line",
      );
      expect(daemon.completions).toHaveLength(1);
      input.write("q2\n");
      await until(() => daemon.completions.length === 2, "turn 2");
      daemon.feeds[1]?.done();
      expect(await done()).toBe(0);
    });

    it("uses the whole text as the assistant turn for a pass-through model", async () => {
      // No task id → no feed to strip; every delta is answer.
      const daemon = fakeDaemon({ turns: 2 });
      const { input, done, output } = launch(["--model", "some/model", "hi"], daemon);
      daemon.feed.push(textChunk("Hello"));
      daemon.feed.push(textChunk(", "));
      daemon.feed.push(textChunk("world"));
      daemon.feed.done();
      await until(() => output().endsWith("Hello, world\n› "), "prompt after turn 1");
      input.write("again\n");
      await until(() => daemon.completions.length === 2, "turn 2");
      expect(daemon.completions[1]?.body.messages).toEqual([
        { role: "user", content: "hi" },
        { role: "assistant", content: "Hello, world" },
        { role: "user", content: "again" },
      ]);
      daemon.feeds[1]?.done();
      expect(await done()).toBe(0);
    });

    it("ends the session with 1 after a failed turn — no assistant turn, no prompt", async () => {
      const daemon = fakeDaemon({ taskId: TASK_ID, turns: 2 });
      const { input, exit, output } = launch(["task"], daemon);
      daemon.feed.push(textChunk("partial\n"));
      daemon.feed.push({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "auto/orchestrator",
        choices: [{ index: 0, delta: {}, finish_reason: null }],
        error: { message: "provider fell over", type: "upstream", code: null },
      });
      daemon.feed.done();
      expect(await exit).toBe(1);
      input.write("still there?\n");
      expect(daemon.completions).toHaveLength(1);
      expect(output()).not.toContain("✖ provider fell over\n› ");
    });

    it("exits 0 when stdin closed during the first turn (piped one-shot use)", async () => {
      const daemon = fakeDaemon({ taskId: TASK_ID });
      const { input, exit, output } = launch(["task"], daemon);
      daemon.feed.push(textChunk("◆ plan\n"));
      await until(() => output().includes("◆ plan"), "the feed to start");
      input.end();
      // Let readline observe EOF before the turn ends, as `< /dev/null` would.
      await new Promise((r) => setTimeout(r, 20));
      daemon.feed.push(textChunk("\n"));
      daemon.feed.push(textChunk("answer"));
      daemon.feed.done();
      expect(await exit).toBe(0);
      expect(daemon.completions).toHaveLength(1);
      // No dangling follow-up prompt on a pipe that has already hung up.
      expect(output()).not.toContain("›");
    });
  });
});
