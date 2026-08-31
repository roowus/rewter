/**
 * The orchestrator over HTTP: `auto/orchestrator` through both dialects.
 *
 * `engine.test.ts` proves the orchestration itself; these prove the *seam*. The
 * engine yields the same `StreamChunk`s a model call does, so the claim under
 * test is that nothing in the HTTP layer needs to know the difference — the
 * same SSE framing, the same `[DONE]`, the same non-stream fold.
 *
 * Two behaviours exist only here and are pinned only here:
 *
 *  - `x-rewter-task-id` goes out *before* the first byte of the body. It is the
 *    client's handle for steering and reconnection, and a header set late is a
 *    header never sent.
 *  - A second POST of the same conversation plus one turn is *steering*, not a
 *    second task. Getting that wrong doubles the bill and silently orphans the
 *    task the user was actually replying to.
 */
import {
  type ChatMessage,
  type Project,
  ProjectSchema,
  type StreamChunk,
  newProjectId,
} from "@rewter/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { Orchestrator } from "../orchestrator/engine.js";
import { LiveTaskIndex } from "../orchestrator/live.js";
import type { WorkerOutcome, WorkerRunner } from "../orchestrator/worker.js";
import { Router } from "../router/router.js";
import { FakeAdapter, end, text } from "../testing/fake-adapter.js";
import { PRV_A, model, provider } from "../testing/registry.js";
import { PROJECT_HEADER, TASK_ID_HEADER, buildApp } from "./app.js";

const BIG = "anthropic/claude-opus-5";
const SMALL = "zai/glm-5.3";
const CREATED_MS = 1_756_252_800_000;

let db: Db;
let repos: Repos;
let bus: EventBus;
let app: FastifyInstance;
let live: LiveTaskIndex;

/** A full pricing block — `model()` spreads shallowly, so partials would drop fields. */
const price = (inputPerMTok: number, outputPerMTok: number) => ({
  inputPerMTok,
  outputPerMTok,
  cacheReadPerMTok: inputPerMTok / 10,
  cacheWritePerMTok: inputPerMTok * 1.25,
});

beforeEach(() => {
  db = openDb(":memory:");
  let tick = CREATED_MS;
  const clock = (): number => ++tick;
  bus = new EventBus(db, clock);
  repos = new Repos(db, bus, clock);
  repos.upsertProvider(provider());
  repos.upsertModel(model(BIG, PRV_A, { pricing: price(15, 75) }));
  repos.upsertModel(model(SMALL, PRV_A, { pricing: price(0.6, 2.2) }));
});

afterEach(async () => {
  live?.shutdown();
  // Concurrent steering tests listen on a real port; inject-only tests never
  // bind. `closeAllConnections` is a no-op on an unbound server.
  app?.server.closeAllConnections();
  await app?.close();
});

/** One initiator turn as chunks, tool arguments split as providers really send them. */
function turn(...calls: Array<{ name: string; args: unknown }>): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  calls.forEach((call, index) => {
    chunks.push({ type: "tool_call_start", index, id: `call_${index}`, name: call.name });
    chunks.push({
      type: "tool_call_delta",
      index,
      argumentsDelta: JSON.stringify(call.args),
    });
  });
  chunks.push(end("tool_calls"));
  return chunks;
}

const outcome = (over: Partial<WorkerOutcome> = {}): WorkerOutcome => ({
  status: "succeeded",
  summary: "did the thing",
  fullText: "did the thing, at length",
  error: null,
  workerRunId: "run_stub" as WorkerOutcome["workerRunId"],
  durationMs: 5,
  ...over,
});

interface Harness {
  adapter: FakeAdapter;
  orchestrator: Orchestrator;
}

/** Builds the app around a scripted initiator and a stub worker. */
function setup(scripts: StreamChunk[][], worker?: WorkerRunner): Harness {
  const adapter = new FakeAdapter(scripts);
  const router = new Router({ repos, createAdapter: () => adapter, sleep: async () => undefined });
  const orchestrator = new Orchestrator({
    router,
    repos,
    bus,
    runWorker: worker ?? (async () => outcome()),
  });
  live = new LiveTaskIndex();
  app = buildApp({
    router,
    repos,
    bus,
    orchestrator,
    live,
    clock: () => CREATED_MS,
    // Heartbeats would inject `: ping` comments into byte-exact assertions.
    sse: { heartbeatMs: 0 },
  });
  return { adapter, orchestrator };
}

/**
 * Bind the app already built by `setup`. Steering tests need a real socket:
 * `app.inject()` serializes in-flight streams, so a follow-up would only
 * dispatch after the first task had finished — and a finished task is not
 * a task you can steer.
 */
async function listen(): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

const HEADERS = { "content-type": "application/json" };

function postChat(
  base: string,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { ...HEADERS, ...extraHeaders },
    body: JSON.stringify(payload),
  });
}

const chat = (over: Record<string, unknown> = {}) => ({
  model: "auto/orchestrator",
  messages: [{ role: "user", content: "summarize these three URLs" }],
  ...over,
});

/** Every `data:` payload in an SSE body, with `[DONE]` kept as a marker. */
function sseFrames(body: string): unknown[] {
  return body
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => {
      const payload = block.slice("data: ".length);
      return payload === "[DONE]" ? "[DONE]" : JSON.parse(payload);
    });
}

/** The visible text of an OpenAI SSE body — what the user actually reads. */
function feedOf(body: string): string {
  return sseFrames(body)
    .filter((f): f is { choices: Array<{ delta: { content?: string } }> } => f !== "[DONE]")
    .map((f) => f.choices[0]?.delta.content ?? "")
    .join("");
}

/** A three-turn script: plan, wait, finish. The canonical happy path. */
function fanOutScript(answer = "All three agree."): StreamChunk[][] {
  return [
    turn(
      { name: "plan_note", args: { note: "split the URLs three ways" } },
      { name: "spawn_worker", args: { title: "one", model: SMALL, instructions: "url one" } },
      { name: "spawn_worker", args: { title: "two", model: SMALL, instructions: "url two" } },
    ),
    turn({ name: "wait", args: { mode: "all" } }),
    turn({ name: "finish", args: { answer } }),
  ];
}

describe("POST /v1/chat/completions — orchestrator", () => {
  it("streams an orchestration in the same frames a model call uses", async () => {
    setup(fanOutScript());
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chat({ stream: true }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const frames = sseFrames(res.body);
    expect(frames.at(-1)).toBe("[DONE]");
    // The role frame the OpenAI protocol expects first, exactly as plain
    // routing sends it — the client cannot tell an orchestration apart.
    expect(frames[0]).toMatchObject({
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant" } }],
    });

    const feed = feedOf(res.body);
    expect(feed).toContain("◆ plan: split the URLs three ways");
    expect(feed).toContain(`[w1 · ${SMALL} · tier1]`);
    expect(feed).toContain("✔ [w1] done");
    expect(feed).toContain("All three agree.");
  });

  it("folds a non-streaming orchestration into one completion", async () => {
    setup(fanOutScript("The short answer."));
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chat(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      object: string;
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    }>();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.finish_reason).toBe("stop");
    // The narration is inline: a non-streaming client waits longer and sees the
    // same text, rather than a different, quieter answer.
    expect(body.choices[0]?.message.content).toContain("◆ plan:");
    expect(body.choices[0]?.message.content).toContain("The short answer.");
  });

  it("sends the task id as a header, streaming and not", async () => {
    setup(fanOutScript());
    const streamed = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chat({ stream: true }),
    });
    expect(streamed.headers[TASK_ID_HEADER]).toMatch(/^task_/);

    const plain = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chat(),
    });
    expect(plain.headers[TASK_ID_HEADER]).toMatch(/^task_/);
    // Two POSTs of the same opening conversation are two tasks, not one: the
    // first has finished, so there is nothing live to continue.
    expect(plain.headers[TASK_ID_HEADER]).not.toBe(streamed.headers[TASK_ID_HEADER]);
  });

  it("records the task with the initiator that actually led", async () => {
    setup(fanOutScript());
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chat({ model: `auto/orchestrator:${SMALL}` }),
    });
    const taskId = res.headers[TASK_ID_HEADER] as string;
    expect(repos.getTask(taskId)).toMatchObject({
      status: "succeeded",
      initiatorModelId: SMALL,
    });
  });

  it("400s a pin naming a model that is not in the registry", async () => {
    setup(fanOutScript());
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chat({ model: "auto/orchestrator:nope/not-real" }),
    });
    // The task row is written eagerly, so a bad pin fails while a status code is
    // still available — rather than becoming a text line inside a 200.
    expect(res.statusCode).toBe(404);
    expect(res.headers[TASK_ID_HEADER]).toBeUndefined();
  });

  it("501s when the daemon has no orchestrator wired", async () => {
    const adapter = new FakeAdapter([[text("x"), end()]]);
    app = buildApp({
      router: new Router({ repos, createAdapter: () => adapter, sleep: async () => undefined }),
      repos,
      bus,
      sse: { heartbeatMs: 0 },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chat(),
    });
    expect(res.statusCode).toBe(501);
    expect(res.json<{ error: { type: string } }>().error.type).toBe("not_implemented");
  });
});

describe("project selection", () => {
  function saveProject(over: Record<string, unknown> = {}): Project {
    const project = ProjectSchema.parse({
      id: newProjectId(),
      slug: "rewter",
      name: "Rewter",
      createdAt: CREATED_MS,
      updatedAt: CREATED_MS,
      ...over,
    });
    repos.upsertProject(project);
    return project;
  }

  it("selects a project by model suffix and records it on the task", async () => {
    const project = saveProject();
    setup(fanOutScript());
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chat({ model: "auto@rewter" }),
    });
    expect(res.statusCode).toBe(200);
    const taskId = res.headers[TASK_ID_HEADER] as string;
    expect(repos.getTask(taskId)?.projectId).toBe(project.id);
  });

  it("selects a project by header, for clients whose picker cannot carry a suffix", async () => {
    const project = saveProject();
    setup(fanOutScript());
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chat(),
      headers: { [PROJECT_HEADER]: "rewter" },
    });
    expect(res.statusCode).toBe(200);
    const taskId = res.headers[TASK_ID_HEADER] as string;
    expect(repos.getTask(taskId)?.projectId).toBe(project.id);
  });

  it("400s when the suffix and the header disagree", async () => {
    saveProject();
    saveProject({ slug: "other", name: "Other" });
    setup(fanOutScript());
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chat({ model: "auto@rewter" }),
      headers: { [PROJECT_HEADER]: "other" },
    });
    // Guessing would silently run the task under the wrong project's policy.
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("pick one");
    expect(res.headers[TASK_ID_HEADER]).toBeUndefined();
  });

  it("agrees with itself when both channels name the same project", async () => {
    saveProject();
    setup(fanOutScript());
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chat({ model: "auto@rewter" }),
      headers: { [PROJECT_HEADER]: "rewter" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("404s a slug that names no project — before any task row exists", async () => {
    setup(fanOutScript());
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chat({ model: "auto@no-such-project" }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("unknown project");
    expect(res.headers[TASK_ID_HEADER]).toBeUndefined();
    expect(tasksSeen()).toHaveLength(0);
  });

  it("400s an archived project, distinctly from an unknown one", async () => {
    saveProject({ archived: true });
    setup(fanOutScript());
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chat({ model: "auto@rewter" }),
    });
    // "Retired, unarchive it" is actionable in a way "typo" is not.
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("archived");
  });

  it("carries the project through a pinned model suffix too", async () => {
    const project = saveProject();
    setup(fanOutScript());
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chat({ model: `auto@rewter:${SMALL}` }),
    });
    expect(res.statusCode).toBe(200);
    const taskId = res.headers[TASK_ID_HEADER] as string;
    expect(repos.getTask(taskId)).toMatchObject({
      projectId: project.id,
      initiatorModelId: SMALL,
    });
  });

  it("applies project selection on the Anthropic dialect as well", async () => {
    const project = saveProject();
    setup(fanOutScript());
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "auto/orchestrator",
        max_tokens: 1024,
        messages: [{ role: "user", content: "go" }],
      },
      headers: { [PROJECT_HEADER]: "rewter" },
    });
    expect(res.statusCode).toBe(200);
    const taskId = res.headers[TASK_ID_HEADER] as string;
    expect(repos.getTask(taskId)?.projectId).toBe(project.id);
  });
});

describe("POST /v1/messages — orchestrator", () => {
  const anthropicBody = (over: Record<string, unknown> = {}) => ({
    model: "auto/orchestrator",
    max_tokens: 1024,
    messages: [{ role: "user", content: "summarize these three URLs" }],
    ...over,
  });

  it("streams an orchestration as Anthropic events", async () => {
    setup(fanOutScript("Anthropic answer."));
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: anthropicBody({ stream: true }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers[TASK_ID_HEADER]).toMatch(/^task_/);
    // The events Claude Code's parser requires, in order.
    for (const type of [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]) {
      expect(res.body, `missing ${type}`).toContain(`event: ${type}`);
    }
    expect(res.body).toContain("Anthropic answer.");
  });

  it("folds a non-streaming orchestration into one message", async () => {
    setup(fanOutScript("Anthropic answer."));
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: anthropicBody(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      type: string;
      role: string;
      content: Array<{ type: string; text: string }>;
    }>();
    expect(body).toMatchObject({ type: "message", role: "assistant" });
    expect(body.content[0]?.text).toContain("Anthropic answer.");
  });

  it("501s in Anthropic's error shape when no orchestrator is wired", async () => {
    const adapter = new FakeAdapter([[text("x"), end()]]);
    app = buildApp({
      router: new Router({ repos, createAdapter: () => adapter, sleep: async () => undefined }),
      repos,
      bus,
      sse: { heartbeatMs: 0 },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: anthropicBody(),
    });
    expect(res.statusCode).toBe(501);
    expect(res.json<{ type: string; error: { type: string } }>()).toMatchObject({
      type: "error",
      error: { type: "not_implemented" },
    });
  });
});

describe("steering by re-POST", () => {
  /**
   * A worker that parks until the test releases it. This is what makes steering
   * testable at all: the follow-up has to arrive while turn 2 is genuinely
   * in flight, not after the task has finished.
   */
  function parkedWorker(): { runner: WorkerRunner; release: () => void; started: Promise<void> } {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((r) => {
      markStarted = r;
    });
    const runner: WorkerRunner = async () => {
      markStarted();
      await gate;
      return outcome();
    };
    return { runner, release, started };
  }

  function parkedScript(): StreamChunk[][] {
    return [
      turn({ name: "spawn_worker", args: { title: "one", model: SMALL, instructions: "go" } }),
      turn({ name: "wait", args: { mode: "all" } }),
      turn({ name: "finish", args: { answer: "done" } }),
    ];
  }

  it("injects a follow-up's new message into the running task and attaches to its stream", async () => {
    const parked = parkedWorker();
    setup(parkedScript(), parked.runner);
    const base = await listen();

    const conversation = [{ role: "user", content: "summarize these three URLs" }];
    const first = await postChat(base, {
      model: "auto/orchestrator",
      messages: conversation,
      stream: true,
    });
    await parked.started;

    // The follow-up: the same conversation, one turn longer. An OpenAI client
    // has no other way to say something to a request already in flight.
    // Awaiting the response resolves once its headers are out, which is after
    // the route has matched and steered — release the worker only then, or the
    // first task races to completion and there is nothing left to steer.
    const b = await postChat(base, {
      model: "auto/orchestrator",
      messages: [
        ...conversation,
        { role: "assistant", content: "working on it" },
        { role: "user", content: "actually, focus on the third one" },
      ],
      stream: true,
    });
    parked.release();

    const [aBody, bBody] = await Promise.all([first.text(), b.text()]);
    expect(b.headers.get(TASK_ID_HEADER)).toBe(first.headers.get(TASK_ID_HEADER));
    // One task, not two: a second task here would double the bill and orphan
    // the one the user was replying to.
    expect(tasksSeen()).toHaveLength(1);
    // Both streams end cleanly, and the steering reached the initiator.
    expect(feedOf(aBody)).toContain("actually, focus on the third one");
    expect(feedOf(bBody)).toContain("done");

    // And it is on the log, not only in the feed. The feed is gone on reconnect
    // and on restart; "did my instruction land" needs an answer that outlives
    // the stream, and the dashboard reads the log rather than the SSE body.
    const steered = bus
      .eventsAfter(0)
      .filter((e) => e.payload.type === "steering.received")
      .map((e) => (e.payload as { text: string }).text);
    expect(steered).toEqual(["actually, focus on the third one"]);
  });

  it("matches on the task id header when the client can echo it", async () => {
    const parked = parkedWorker();
    setup(parkedScript(), parked.runner);
    const base = await listen();

    const first = await postChat(base, chat({ stream: true }));
    await parked.started;
    const taskId = first.headers.get(TASK_ID_HEADER);
    expect(taskId).toMatch(/^task_/);

    // A conversation with nothing in common — only the header ties it back.
    const b = await postChat(
      base,
      {
        model: "auto/orchestrator",
        messages: [{ role: "user", content: "entirely unrelated" }],
        stream: true,
      },
      { [TASK_ID_HEADER]: taskId as string },
    );
    parked.release();

    await Promise.all([first.text(), b.text()]);
    expect(b.headers.get(TASK_ID_HEADER)).toBe(taskId);
    expect(tasksSeen()).toHaveLength(1);
  });

  it("starts a fresh task when a conversation continues one that already finished", async () => {
    setup(fanOutScript());
    const conversation: ChatMessage[] = [{ role: "user", content: "summarize these three URLs" }];
    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "auto/orchestrator", messages: conversation },
    });

    const second = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto/orchestrator",
        messages: [...conversation, { role: "user", content: "now do it again" }],
      },
    });

    // Steering a task that has already answered would be a message into the
    // void; a finished task is not a task you can reply to.
    expect(second.headers[TASK_ID_HEADER]).not.toBe(first.headers[TASK_ID_HEADER]);
    expect(tasksSeen()).toHaveLength(2);
  });
});

/** Task ids that appear anywhere in the event log — one per orchestration. */
function tasksSeen(): string[] {
  const ids = new Set<string>();
  for (const e of bus.eventsAfter(0)) if (e.taskId !== null) ids.add(e.taskId);
  return [...ids];
}
