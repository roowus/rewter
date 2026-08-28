/**
 * Engine tests — the M5 acceptance scenarios, driven by scripted models.
 *
 * The initiator is a `FakeAdapter` replaying tool-call chunk scripts, so a whole
 * orchestration is deterministic: turn 1 spawns three workers, turn 2 waits,
 * turn 3 finishes. Workers are a stub `WorkerRunner`, because what is under test
 * here is the *engine* — `worker.test.ts` covers the real one.
 *
 * Two things these assert that nothing else can:
 *
 *  - The engine yields `StreamChunk`s indistinguishable from a model call's, so
 *    progress lines are ordinary `text_delta`s and the HTTP layer needs no
 *    special case. Every test reads the feed as text.
 *  - Bad model behaviour never throws. A hallucinated model id, a tier that does
 *    not exist yet, an unknown worker label and a self-handoff are all *tool
 *    results*, and the task carries on. A task that dies because a model guessed
 *    wrong would be the worst possible trade.
 */
import {
  type ChatMessage,
  ModelIdSchema,
  type StreamChunk,
  type TaskId,
  newCostRecordId,
  newWorkerRunId,
} from "@rewter/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { Router } from "../router/router.js";
import { FakeAdapter, end, text } from "../testing/fake-adapter.js";
import { PRV_A, model, provider } from "../testing/registry.js";
import {
  Orchestrator,
  type OrchestratorOptions,
  fingerprintConversation,
  titleFor,
} from "./engine.js";
import type { WorkerContext, WorkerOutcome, WorkerRunner } from "./worker.js";

const BIG = "anthropic/claude-opus-5";
const SMALL = "zai/glm-5.3";
const CONVERSATION: ChatMessage[] = [{ role: "user", content: "summarize these three URLs" }];

let db: Db;
let repos: Repos;
let bus: EventBus;
let tick: number;

beforeEach(() => {
  db = openDb(":memory:");
  tick = 1_756_252_800_000;
  const clock = (): number => ++tick;
  bus = new EventBus(db, clock);
  repos = new Repos(db, bus, clock);
  repos.upsertProvider(provider());
  // Priced apart so the "most expensive tools-capable model leads" heuristic has
  // an unambiguous answer.
  repos.upsertModel(
    model(BIG, PRV_A, {
      pricing: {
        inputPerMTok: 15,
        outputPerMTok: 75,
        cacheReadPerMTok: 1.5,
        cacheWritePerMTok: 18.75,
      },
    }),
  );
  repos.upsertModel(
    model(SMALL, PRV_A, {
      pricing: {
        inputPerMTok: 0.6,
        outputPerMTok: 2.2,
        cacheReadPerMTok: 0.1,
        cacheWritePerMTok: 0.8,
      },
    }),
  );
});

// ── Scripting helpers ────────────────────────────────────────────────────────

/**
 * One initiator turn as chunks. Tool calls arrive split across deltas, because
 * that is how providers actually send them and the assembler has to cope.
 */
function turn(...calls: Array<{ name: string; args: unknown }>): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  calls.forEach((call, index) => {
    chunks.push({ type: "tool_call_start", index, id: `call_${index}`, name: call.name });
    const json = JSON.stringify(call.args);
    const cut = Math.floor(json.length / 2);
    chunks.push({ type: "tool_call_delta", index, argumentsDelta: json.slice(0, cut) });
    chunks.push({ type: "tool_call_delta", index, argumentsDelta: json.slice(cut) });
  });
  chunks.push(end("tool_calls"));
  return chunks;
}

/** A turn of plain prose with no tool call — the "forgot to call finish" case. */
function prose(body: string): StreamChunk[] {
  return [text(body), end("stop")];
}

interface Harness {
  orchestrator: Orchestrator;
  adapter: FakeAdapter;
  spawned: WorkerContext[];
}

function outcome(over: Partial<WorkerOutcome> = {}): WorkerOutcome {
  return {
    status: "succeeded",
    summary: "did the thing",
    fullText: "did the thing, at length",
    error: null,
    workerRunId: newWorkerRunId(),
    durationMs: 1_200,
    ...over,
  };
}

function makeHarness(
  scripts: StreamChunk[][],
  over: Partial<OrchestratorOptions> = {},
  worker?: WorkerRunner,
): Harness {
  const adapter = new FakeAdapter(scripts);
  const router = new Router({
    repos,
    createAdapter: () => adapter,
    clock: () => ++tick,
    sleep: async () => {},
  });
  const spawned: WorkerContext[] = [];
  const runWorker: WorkerRunner = async (ctx) => {
    spawned.push(ctx);
    return worker === undefined ? outcome() : worker(ctx);
  };
  return {
    adapter,
    spawned,
    orchestrator: new Orchestrator({
      router,
      repos,
      bus,
      clock: () => ++tick,
      runWorker,
      ...over,
    }),
  };
}

/** Collect a whole orchestration as the text a client would see, plus the chunks. */
async function drive(
  h: Harness,
  over: {
    conversation?: ChatMessage[];
    requestedModel?: string;
    settings?: Record<string, unknown>;
    signal?: AbortSignal;
  } = {},
): Promise<{ feed: string; chunks: StreamChunk[] }> {
  const chunks: StreamChunk[] = [];
  for await (const c of h.orchestrator.run({
    conversation: over.conversation ?? CONVERSATION,
    requestedModel: over.requestedModel ?? "auto/orchestrator",
    settings: over.settings,
    signal: over.signal,
  })) {
    chunks.push(c);
  }
  const feed = chunks
    .filter((c): c is Extract<StreamChunk, { type: "text_delta" }> => c.type === "text_delta")
    .map((c) => c.text)
    .join("");
  return { feed, chunks };
}

const only = <T>(rows: T[]): T => {
  if (rows.length !== 1) throw new Error(`expected exactly one, got ${rows.length}`);
  return rows[0] as T;
};

function tasks() {
  // There is exactly one task per orchestration; grab it without knowing its id.
  const seen = new Set<string>();
  for (const e of bus.eventsAfter(0)) if (e.taskId !== null) seen.add(e.taskId);
  return [...seen].map((id) => repos.getTask(id)).filter((t) => t !== undefined);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("pickInitiator", () => {
  it("honours an explicit pin over everything else", () => {
    const { orchestrator } = makeHarness([], { defaultInitiatorModel: BIG });
    expect(orchestrator.pickInitiator(`auto/orchestrator:${SMALL}`)).toBe(SMALL);
  });

  it("canonicalizes a pin written as a bare name", () => {
    const { orchestrator } = makeHarness([]);
    // `glm-5.3` is not an id; resolve widens to it, and the task must record the
    // id that actually ran.
    expect(orchestrator.pickInitiator("auto/orchestrator:glm-5.3")).toBe(SMALL);
  });

  it("falls back to the configured default, then to the priciest tools-capable model", () => {
    expect(
      makeHarness([], { defaultInitiatorModel: SMALL }).orchestrator.pickInitiator("auto"),
    ).toBe(SMALL);
    expect(makeHarness([]).orchestrator.pickInitiator("auto")).toBe(BIG);
  });

  it("says plainly when nothing in the registry can lead", () => {
    repos.upsertModel(
      model(BIG, PRV_A, {
        supports: { tools: false, streaming: true, vision: false, caching: false },
      }),
    );
    repos.upsertModel(
      model(SMALL, PRV_A, {
        supports: { tools: false, streaming: true, vision: false, caching: false },
      }),
    );
    expect(() => makeHarness([]).orchestrator.pickInitiator("auto")).toThrow(/supports tools/);
  });
});

describe("fan-out", () => {
  it("runs three workers in parallel from one turn and reports each in the feed", async () => {
    const h = makeHarness([
      turn(
        { name: "plan_note", args: { note: "split the URLs three ways" } },
        {
          name: "spawn_worker",
          args: { title: "url one", model: SMALL, instructions: "summarize url one" },
        },
        {
          name: "spawn_worker",
          args: { title: "url two", model: SMALL, instructions: "summarize url two" },
        },
        {
          name: "spawn_worker",
          args: { title: "url three", model: SMALL, instructions: "summarize url three" },
        },
      ),
      turn({ name: "wait", args: { mode: "all" } }),
      turn({ name: "finish", args: { answer: "All three agree." } }),
    ]);

    const { feed, chunks } = await drive(h);

    expect(h.spawned).toHaveLength(3);
    expect(feed).toContain("◆ plan: split the URLs three ways");
    for (const label of ["w1", "w2", "w3"]) {
      expect(feed, `${label} never started`).toContain(`[${label} · ${SMALL} · tier1]`);
      expect(feed, `${label} never finished`).toContain(`✔ [${label}] done`);
    }
    expect(feed).toContain("All three agree.");

    // The whole run is one ordinary stream: text deltas then a single end frame.
    const last = chunks.at(-1);
    expect(last?.type).toBe("message_end");
    expect(last?.type === "message_end" && last.finishReason).toBe("stop");

    const task = only(tasks());
    expect(task?.status).toBe("succeeded");
    expect(task?.resultSummary).toBe("All three agree.");
    expect(repos.listWorkItems(task?.id ?? "")).toHaveLength(3);
  });

  it("each worker gets only its own instructions", async () => {
    const h = makeHarness([
      turn(
        { name: "spawn_worker", args: { title: "a", model: SMALL, instructions: "task A" } },
        { name: "spawn_worker", args: { title: "b", model: SMALL, instructions: "task B" } },
      ),
      turn({ name: "wait", args: {} }),
      turn({ name: "finish", args: { answer: "done" } }),
    ]);
    await drive(h);

    expect(h.spawned.map((c) => c.workItem.instructions)).toEqual(["task A", "task B"]);
    // Chained, not shared: each worker has its own signal.
    expect(h.spawned[0]?.signal).not.toBe(h.spawned[1]?.signal);
  });

  it("respects the task's concurrency setting", async () => {
    let live = 0;
    let peak = 0;
    const h = makeHarness(
      [
        turn(
          ...[1, 2, 3, 4].map((n) => ({
            name: "spawn_worker",
            args: { title: `t${n}`, model: SMALL, instructions: `job ${n}` },
          })),
        ),
        turn({ name: "wait", args: {} }),
        turn({ name: "finish", args: { answer: "done" } }),
      ],
      {},
      async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((r) => setImmediate(r));
        live -= 1;
        return outcome();
      },
    );

    await drive(h, { settings: { concurrency: 2 } });
    expect(peak).toBe(2);
  });

  it("takes settings the request omitted from the configured defaults", async () => {
    // The config file's `orchestrator.maxSpendUsd` is only real if it survives a
    // request that says nothing about settings — which is every request, since
    // the OpenAI wire format has nowhere to put a spending cap.
    const h = makeHarness([turn({ name: "finish", args: { answer: "done" } })], {
      defaultSettings: { maxSpendUsd: 2.5, concurrency: 3 },
    });
    const started = h.orchestrator.start({
      conversation: CONVERSATION,
      requestedModel: "auto/orchestrator",
    });
    const settings = repos.getTask(started.taskId)?.settings;
    expect(settings?.maxSpendUsd).toBe(2.5);
    expect(settings?.concurrency).toBe(3);
  });

  it("lets a request's settings win over the configured defaults", async () => {
    const h = makeHarness([turn({ name: "finish", args: { answer: "done" } })], {
      defaultSettings: { maxSpendUsd: 2.5, concurrency: 3 },
    });
    const started = h.orchestrator.start({
      conversation: CONVERSATION,
      requestedModel: "auto/orchestrator",
      settings: { maxSpendUsd: 9 },
    });
    // Overridden where asked, inherited where not.
    const settings = repos.getTask(started.taskId)?.settings;
    expect(settings?.maxSpendUsd).toBe(9);
    expect(settings?.concurrency).toBe(3);
  });
});

describe("wait", () => {
  it("returns as soon as one worker lands in 'any' mode", async () => {
    // w2 never settles on its own, so a run that finishes at all proves `any`
    // did not wait for it. It settles on cancellation, which is what the task
    // teardown does to every worker still running.
    const h = makeHarness(
      [
        turn(
          { name: "spawn_worker", args: { title: "quick", model: SMALL, instructions: "fast" } },
          { name: "spawn_worker", args: { title: "slow", model: SMALL, instructions: "slow" } },
        ),
        turn({ name: "wait", args: { mode: "any" } }),
        turn({ name: "finish", args: { answer: "one was enough" } }),
      ],
      {},
      async (ctx) =>
        ctx.workItem.title === "quick"
          ? outcome({ summary: "quick result" })
          : new Promise<WorkerOutcome>((resolve) => {
              ctx.signal.addEventListener("abort", () =>
                resolve(outcome({ status: "cancelled", summary: "cancelled", error: "cancelled" })),
              );
            }),
    );

    const { feed } = await drive(h);
    expect(feed).toContain("one was enough");
    // The initiator was handed w1's result while w2 was still outstanding.
    const seen = JSON.stringify(h.adapter.requests.at(-1)?.messages ?? []);
    expect(seen).toContain("quick result");
    expect(seen).toContain("w2: still running");
  });

  it("returns on the first landing when both were still running at the call", async () => {
    // The other `any` test exercises the already-satisfied path (a worker that
    // settled before `wait` was called). This one holds *both* workers open so
    // the race in `awaitWorkers` is what has to end the wait.
    let releaseQuick: (() => void) | undefined;
    const h = makeHarness(
      [
        turn(
          { name: "spawn_worker", args: { title: "quick", model: SMALL, instructions: "fast" } },
          { name: "spawn_worker", args: { title: "slow", model: SMALL, instructions: "slow" } },
        ),
        turn({ name: "wait", args: { mode: "any" } }),
        turn({ name: "finish", args: { answer: "raced" } }),
      ],
      {},
      async (ctx) =>
        new Promise<WorkerOutcome>((resolve) => {
          if (ctx.workItem.title === "quick") {
            releaseQuick = () => resolve(outcome({ summary: "quick result" }));
            return;
          }
          ctx.signal.addEventListener("abort", () =>
            resolve(outcome({ status: "cancelled", summary: "cancelled", error: "cancelled" })),
          );
        }),
    );

    // Let both spawns reach the stub, then let exactly one finish.
    const run = drive(h);
    await new Promise((r) => setTimeout(r, 10));
    expect(releaseQuick).toBeDefined();
    releaseQuick?.();

    const { feed } = await run;
    expect(feed).toContain("raced");
    expect(JSON.stringify(h.adapter.requests.at(-1)?.messages ?? [])).toContain(
      "w2: still running",
    );
  });

  it("hands the initiator summaries, not full text", async () => {
    const h = makeHarness(
      [
        turn({ name: "spawn_worker", args: { title: "a", model: SMALL, instructions: "x" } }),
        turn({ name: "wait", args: {} }),
        turn({ name: "finish", args: { answer: "done" } }),
      ],
      {},
      async () => outcome({ summary: "the short version", fullText: "THE VERY LONG VERSION" }),
    );
    await drive(h);

    // Turn 3's request carries the tool result from turn 2's `wait`.
    const sent = JSON.stringify(h.adapter.requests.at(-1)?.messages ?? []);
    expect(sent).toContain("the short version");
    expect(sent).not.toContain("THE VERY LONG VERSION");
  });

  it("gives the full text only when the initiator pays for it with get_result", async () => {
    const h = makeHarness(
      [
        turn({ name: "spawn_worker", args: { title: "a", model: SMALL, instructions: "x" } }),
        turn({ name: "wait", args: {} }),
        turn({ name: "get_result", args: { label: "w1" } }),
        turn({ name: "finish", args: { answer: "done" } }),
      ],
      {},
      async () => outcome({ summary: "short", fullText: "THE VERY LONG VERSION" }),
    );
    await drive(h);

    expect(JSON.stringify(h.adapter.requests.at(-1)?.messages ?? [])).toContain(
      "THE VERY LONG VERSION",
    );
  });

  it("tells the initiator which labels exist when it names one that does not", async () => {
    const h = makeHarness([
      turn({ name: "spawn_worker", args: { title: "a", model: SMALL, instructions: "x" } }),
      turn({ name: "wait", args: { labels: ["w7"] } }),
      turn({ name: "finish", args: { answer: "recovered" } }),
    ]);

    const { feed } = await drive(h);
    // A bad label is a correction, not a crash.
    expect(feed).toContain("recovered");
    expect(JSON.stringify(h.adapter.requests.at(-1)?.messages ?? [])).toContain(
      "there is no worker w7",
    );
  });
});

describe("failures the initiator can recover from", () => {
  it("reports a failed worker and lets the initiator retry on a stronger model", async () => {
    const h = makeHarness(
      [
        turn({
          name: "spawn_worker",
          args: { title: "hard", model: SMALL, instructions: "hard job" },
        }),
        turn({ name: "wait", args: {} }),
        turn({
          name: "spawn_worker",
          args: { title: "retry", model: BIG, instructions: "hard job" },
        }),
        turn({ name: "wait", args: {} }),
        turn({ name: "finish", args: { answer: "the big one got it" } }),
      ],
      {},
      async (ctx) =>
        ctx.workItem.modelId === SMALL
          ? outcome({
              status: "failed",
              summary: "failed: 429 rate limited",
              fullText: null,
              error: "429 rate limited",
            })
          : outcome({ summary: "solved it" }),
    );

    const { feed } = await drive(h);
    expect(feed).toContain("✖ [w1] failed: 429 rate limited");
    expect(feed).toContain("✔ [w2] done");
    expect(feed).toContain("the big one got it");

    const items = repos.listWorkItems(only(tasks())?.id ?? "");
    expect(items.map((i) => i.status).sort()).toEqual(["failed", "succeeded"]);
  });

  it("refuses a hallucinated model id as a tool result, not an exception", async () => {
    const h = makeHarness([
      turn({
        name: "spawn_worker",
        args: { title: "x", model: "openai/gpt-nonexistent", instructions: "x" },
      }),
      turn({ name: "finish", args: { answer: "used a real one instead" } }),
    ]);

    const { feed } = await drive(h);
    expect(h.spawned).toHaveLength(0);
    expect(feed).toContain("used a real one instead");
    expect(JSON.stringify(h.adapter.requests.at(-1)?.messages ?? [])).toContain(
      "Choose a model id listed in the registry",
    );
  });

  it("spawns a tier-2 worker and labels the feed line with its tier", async () => {
    const h = makeHarness([
      turn({
        name: "spawn_worker",
        args: { title: "patch the config", model: SMALL, instructions: "x", tier: 2 },
      }),
      turn({ name: "wait", args: {} }),
      turn({ name: "finish", args: { answer: "patched" } }),
    ]);

    const { feed } = await drive(h);
    // The stub runner stands in for the real loop; what is under test is that the
    // engine routes tier 2 to *a* runner and narrates the tier it was given.
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]?.workItem.tier).toBe(2);
    expect(feed).toContain(`[w1 · ${SMALL} · tier2]`);
    expect(repos.listWorkItems(only(tasks())?.id ?? "")[0]?.tier).toBe(2);
  });

  it("explains that tier 3 has not arrived yet, and points at tier 2", async () => {
    const h = makeHarness([
      turn({
        name: "spawn_worker",
        args: { title: "x", model: SMALL, instructions: "x", tier: 3 },
      }),
      turn({ name: "finish", args: { answer: "did it myself" } }),
    ]);

    await drive(h);
    expect(h.spawned).toHaveLength(0);
    const sent = JSON.stringify(h.adapter.requests.at(-1)?.messages ?? []);
    expect(sent).toContain("tier 3 workers");
    expect(sent).toContain("Use tier 2");
  });

  it("nudges a model that answered in prose, then accepts the prose", async () => {
    const h = makeHarness([prose("Here is my answer."), prose("Here is my answer.")]);
    const { feed } = await drive(h);

    // One reminder, then take it — discarding the turn would be more expensive.
    expect(feed).toContain("Here is my answer.");
    expect(JSON.stringify(h.adapter.requests.at(-1)?.messages ?? [])).toContain(
      "Nothing you write outside a tool call reaches the user",
    );
    expect(only(tasks())?.status).toBe("succeeded");
  });

  it("fails the task as text rather than as an error frame when the initiator loops", async () => {
    // maxTurns 2, and the script never calls `finish`.
    const h = makeHarness([turn({ name: "plan_note", args: { note: "thinking" } })], {
      maxTurns: 2,
    });

    const { feed, chunks } = await drive(h);
    expect(feed).toContain("✖ task failed");
    expect(feed).toContain("within 2 turns");
    // A failed orchestration still spent money; it must not render as an empty response.
    const last = chunks.at(-1);
    expect(last?.type === "message_end" && last.finishReason).toBe("error");
    expect(only(tasks())?.status).toBe("failed");
  });
});

describe("handoff", () => {
  it("switches model, restarts with the context summary, and finishes there", async () => {
    const h = makeHarness(
      [
        turn({
          name: "handoff",
          args: {
            to_model: BIG,
            reason: "needs deeper reasoning",
            context_summary: "The user asked about X; I got as far as Y.",
          },
        }),
        turn({ name: "finish", args: { answer: "the successor's answer" } }),
      ],
      { defaultInitiatorModel: SMALL },
    );

    const { feed } = await drive(h);
    expect(feed).toContain(`⇄ handing off to ${BIG}: needs deeper reasoning`);
    expect(feed).toContain("the successor's answer");

    // The successor runs on the new model and sees the summary, not the transcript.
    const second = h.adapter.requests.at(-1);
    expect(second?.model).toBe(model(BIG).upstreamId);
    const sent = JSON.stringify(second?.messages ?? []);
    expect(sent).toContain("I got as far as Y");
    // The successor starts from the summary, not from the predecessor's transcript —
    // that is the whole economy of a handoff.
    expect(sent).not.toContain("needs deeper reasoning");

    const events = bus.eventsAfter(0).map((e) => e.payload.type);
    expect(events).toContain("handoff.initiated");
  });

  it("refuses a handoff to an alias of the current model", async () => {
    const h = makeHarness(
      [
        // `glm-5.3` is a bare name for SMALL — a raw string comparison would miss it
        // and loop the task forever.
        turn({ name: "handoff", args: { to_model: "glm-5.3", reason: "r", context_summary: "c" } }),
        turn({ name: "finish", args: { answer: "carried on myself" } }),
      ],
      { defaultInitiatorModel: SMALL },
    );

    const { feed } = await drive(h);
    expect(feed).not.toContain("handing off");
    expect(feed).toContain("carried on myself");
    expect(JSON.stringify(h.adapter.requests.at(-1)?.messages ?? [])).toContain(
      "handing off to yourself would loop",
    );
  });

  it("stops handing off once the ladder is exhausted", async () => {
    const h = makeHarness(
      [
        turn({ name: "handoff", args: { to_model: BIG, reason: "r", context_summary: "c" } }),
        turn({ name: "handoff", args: { to_model: SMALL, reason: "r", context_summary: "c" } }),
        turn({ name: "finish", args: { answer: "stopped bouncing" } }),
      ],
      { defaultInitiatorModel: SMALL, maxHandoffs: 1 },
    );

    const { feed } = await drive(h);
    expect(feed).toContain("stopped bouncing");
    expect(JSON.stringify(h.adapter.requests.at(-1)?.messages ?? [])).toContain(
      "no further handoffs are allowed",
    );
  });
});

describe("cancellation", () => {
  it("collapses the whole worker tree when the client disconnects mid-fan-out", async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const h = makeHarness(
      [
        turn(
          { name: "spawn_worker", args: { title: "a", model: SMALL, instructions: "x" } },
          { name: "spawn_worker", args: { title: "b", model: SMALL, instructions: "y" } },
        ),
        turn({ name: "wait", args: {} }),
        turn({ name: "finish", args: { answer: "never reached" } }),
      ],
      {},
      async (ctx) => {
        signals.push(ctx.signal);
        // Abort once both are in flight, then resolve as cancelled the way the
        // real worker does.
        if (signals.length === 2) controller.abort();
        return new Promise<WorkerOutcome>((resolve) => {
          if (ctx.signal.aborted) {
            resolve(outcome({ status: "cancelled", summary: "cancelled", error: "cancelled" }));
            return;
          }
          ctx.signal.addEventListener("abort", () =>
            resolve(outcome({ status: "cancelled", summary: "cancelled", error: "cancelled" })),
          );
        });
      },
    );

    const { feed, chunks } = await drive(h, { signal: controller.signal });

    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(feed).toContain("⊘ task cancelled");
    expect(feed).not.toContain("never reached");
    // A cancel is not an error — the client asked for it.
    const last = chunks.at(-1);
    expect(last?.type === "message_end" && last.finishReason).toBe("stop");
    expect(only(tasks())?.status).toBe("cancelled");
  });

  it("cancels one worker on request without touching the task", async () => {
    const h = makeHarness(
      [
        turn(
          { name: "spawn_worker", args: { title: "keep", model: SMALL, instructions: "x" } },
          { name: "spawn_worker", args: { title: "drop", model: SMALL, instructions: "y" } },
        ),
        turn({ name: "cancel_worker", args: { label: "w2", reason: "no longer needed" } }),
        turn({ name: "wait", args: { labels: ["w1"] } }),
        turn({ name: "finish", args: { answer: "finished with one" } }),
      ],
      {},
      async (ctx) =>
        ctx.workItem.title === "keep"
          ? outcome({ summary: "kept" })
          : new Promise<WorkerOutcome>((resolve) =>
              ctx.signal.addEventListener("abort", () =>
                resolve(outcome({ status: "cancelled", summary: "cancelled", error: "cancelled" })),
              ),
            ),
    );

    const { feed } = await drive(h);
    expect(feed).toContain("⊘ [w2] cancelled: no longer needed");
    expect(feed).toContain("finished with one");
    expect(only(tasks())?.status).toBe("succeeded");
  });
});

describe("send_to_worker", () => {
  /**
   * A worker that will not finish until something arrives in its inbox.
   *
   * Polling on a real timer, not a resolved promise: the message is sent on a
   * *later* initiator turn, so a runner that read its inbox once and gave up
   * would pass whether or not the engine ever delivered anything.
   */
  const waitsForMessage: WorkerRunner = async (ctx) => {
    for (let tries = 0; tries < 500; tries++) {
      const messages = ctx.inbox?.() ?? [];
      if (messages.length > 0) return outcome({ summary: `heard: ${messages.join("; ")}` });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return outcome({
      status: "failed",
      summary: "no message arrived",
      error: "inbox stayed empty",
    });
  };

  const spawnTier2 = (title: string) => ({
    name: "spawn_worker",
    args: { title, model: SMALL, instructions: "x", tier: 2 },
  });

  it("delivers the message to a running tier-2 worker and shows it in the feed", async () => {
    const h = makeHarness(
      [
        turn(spawnTier2("audit")),
        turn({
          name: "send_to_worker",
          args: { label: "w1", message: "use the fixture, not prod" },
        }),
        turn({ name: "wait", args: {} }),
        turn({ name: "finish", args: { answer: "done" } }),
      ],
      {},
      waitsForMessage,
    );

    const { feed } = await drive(h);

    // The line is in the user's feed, not just between the two AIs: a worker
    // changing course is only explicable if the instruction that caused it is
    // visible in the same place.
    expect(feed).toContain("⇄ [w1] told: use the fixture, not prod");
    // And it actually reached the worker — proved by the summary it reported back.
    expect(feed).toContain("done");
    expect(only(tasks())?.status).toBe("succeeded");
    expect(repos.listWorkItems(only(tasks())?.id ?? "")[0]?.resultSummary).toBe(
      "heard: use the fixture, not prod",
    );
  });

  it("refuses a tier-1 target and names tier 2 as the way to get what was wanted", async () => {
    const h = makeHarness(
      [
        turn({ name: "spawn_worker", args: { title: "think", model: SMALL, instructions: "x" } }),
        turn({ name: "send_to_worker", args: { label: "w1", message: "change of plan" } }),
        turn({ name: "finish", args: { answer: "finished anyway" } }),
      ],
      {},
      // Still running when the message arrives — a finished worker gets the
      // "already finished" answer instead, which is the more useful of the two
      // and so is checked first.
      async (ctx) =>
        new Promise<WorkerOutcome>((resolve) =>
          ctx.signal.addEventListener("abort", () =>
            resolve(outcome({ status: "cancelled", summary: "cancelled", error: "cancelled" })),
          ),
        ),
    );

    const { feed } = await drive(h);

    // Structural, not unimplemented: a tier-1 worker is one model call with no
    // turn boundary to read at. The refusal has to point somewhere.
    const sent = JSON.stringify(h.adapter.requests.at(-1)?.messages ?? []);
    expect(sent).toContain("tier-1 worker");
    expect(sent).toContain("tier 2");
    expect(feed).not.toContain("told:");
    expect(feed).toContain("finished anyway");
    expect(only(tasks())?.status).toBe("succeeded");
  });

  it("tells the initiator to read the result instead when the worker has already finished", async () => {
    const h = makeHarness([
      turn(spawnTier2("quick")),
      turn({ name: "wait", args: {} }),
      turn({ name: "send_to_worker", args: { label: "w1", message: "one more thing" } }),
      turn({ name: "finish", args: { answer: "too late" } }),
    ]);

    await drive(h);

    const sent = JSON.stringify(h.adapter.requests.at(-1)?.messages ?? []);
    expect(sent).toContain("already finished");
    expect(sent).toContain("get_result");
  });

  it("names the workers that do exist when the label does not", async () => {
    const h = makeHarness([
      turn(spawnTier2("real")),
      turn({ name: "send_to_worker", args: { label: "w7", message: "hello?" } }),
      turn({ name: "wait", args: {} }),
      turn({ name: "finish", args: { answer: "carried on" } }),
    ]);

    const { feed } = await drive(h);

    const sent = JSON.stringify(h.adapter.requests.at(-1)?.messages ?? []);
    expect(sent).toContain("there is no worker w7");
    expect(sent).toContain("Started so far: w1");
    expect(feed).toContain("carried on");
  });
});

describe("budget", () => {
  /** Put a spend on the ledger the way the router would, so `totals()` sees it. */
  function chargeTask(taskId: TaskId, costUsd: number): void {
    repos.recordCost({
      id: newCostRecordId(),
      taskId,
      workerRunId: null,
      modelId: ModelIdSchema.parse(SMALL),
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd,
      pricingSnapshot: model(SMALL).pricing,
      createdAt: ++tick,
    });
  }

  it("notes the spend once it crosses 80% of the cap, and tells the initiator", async () => {
    const h = makeHarness(
      [
        turn({ name: "spawn_worker", args: { title: "a", model: SMALL, instructions: "x" } }),
        turn({ name: "wait", args: {} }),
        turn({ name: "finish", args: { answer: "wrapped up" } }),
      ],
      {},
      async (ctx) => {
        chargeTask(ctx.taskId, 0.9);
        return outcome();
      },
    );

    const { feed } = await drive(h, { settings: { maxSpendUsd: 1 } });
    // Not just the worker's $0.90: the initiator's own turns are billed to the
    // task too, so the figure quoted is the whole ledger.
    expect(feed).toMatch(/· budget: \$0\.9\d of \$1\.00 spent/);
    // The nudge reaches the model, not just the user.
    expect(JSON.stringify(h.adapter.requests.at(-1)?.messages ?? [])).toContain("[BUDGET]");
  });

  it("refuses new workers outright once the cap is reached", async () => {
    let spawns = 0;
    const h = makeHarness(
      [
        turn({ name: "spawn_worker", args: { title: "a", model: SMALL, instructions: "x" } }),
        turn({ name: "wait", args: {} }),
        turn({ name: "spawn_worker", args: { title: "b", model: SMALL, instructions: "y" } }),
        turn({ name: "finish", args: { answer: "stopped at one" } }),
      ],
      {},
      async (ctx) => {
        spawns += 1;
        chargeTask(ctx.taskId, 1.5);
        return outcome();
      },
    );

    const { feed } = await drive(h, { settings: { maxSpendUsd: 1 } });
    // A note the model can ignore is not a cap; this one is enforced.
    expect(spawns).toBe(1);
    expect(feed).toContain("stopped at one");
    expect(JSON.stringify(h.adapter.requests.at(-1)?.messages ?? [])).toContain(
      "spending cap has been reached",
    );
  });

  it("stays out of the way when no cap is set", async () => {
    const h = makeHarness(
      [
        turn({ name: "spawn_worker", args: { title: "a", model: SMALL, instructions: "x" } }),
        turn({ name: "wait", args: {} }),
        turn({ name: "finish", args: { answer: "done" } }),
      ],
      {},
      async (ctx) => {
        chargeTask(ctx.taskId, 42);
        return outcome();
      },
    );

    const { feed } = await drive(h);
    expect(feed).not.toContain("budget:");
    expect(feed).toContain("done");
  });
});

describe("ask_user", () => {
  it("shows the question but does not hang the run waiting for an answer", async () => {
    const h = makeHarness([
      turn({ name: "ask_user", args: { question: "Which repo?" } }),
      turn({ name: "finish", args: { answer: "assumed the current one" } }),
    ]);

    const { feed } = await drive(h);
    expect(feed).toContain("⏸ Which repo?");
    expect(feed).toContain("assumed the current one");
    // No reply channel exists during a run, so the initiator is told to assume.
    expect(JSON.stringify(h.adapter.requests.at(-1)?.messages ?? [])).toContain(
      "State the assumption you are making",
    );
  });
});

describe("the task row", () => {
  it("records the canonical initiator id and a fingerprint of the conversation prefix", async () => {
    const conversation: ChatMessage[] = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "follow-up" },
    ];
    const h = makeHarness([turn({ name: "finish", args: { answer: "ok" } })]);
    await drive(h, { conversation, requestedModel: "auto/orchestrator:glm-5.3" });

    const task = only(tasks());
    expect(task?.initiatorModelId).toBe(SMALL);
    expect(task?.title).toBe("follow-up");
    // The prefix is what a follow-up re-POST will still match.
    expect(task?.conversationFingerprint).toBe(fingerprintConversation(conversation));
  });
});

describe("fingerprintConversation", () => {
  it("matches a follow-up against the conversation it continues", () => {
    const first: ChatMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    // The client re-POSTs the whole history plus one new turn; the prefix is
    // unchanged, which is exactly the property steering needs.
    const followUp: ChatMessage[] = [...first, { role: "assistant", content: "d" }];
    expect(fingerprintConversation(followUp)).not.toBe(fingerprintConversation(first));
    expect(fingerprintConversation(first.slice(0, 3))).toBe(fingerprintConversation(first));

    const different: ChatMessage[] = [
      { role: "user", content: "z" },
      { role: "user", content: "c" },
    ];
    expect(fingerprintConversation(different)).not.toBe(fingerprintConversation(first));
  });

  it("handles a single-message conversation without reaching past the start", () => {
    expect(fingerprintConversation([{ role: "user", content: "only" }])).toBe(
      fingerprintConversation([]),
    );
  });
});

describe("titleFor", () => {
  it("takes the last non-empty user message, clamped to one line", () => {
    expect(titleFor([{ role: "user", content: "  do   the\nthing  " }])).toBe("do the thing");
    expect(titleFor([{ role: "user", content: "x".repeat(200) }]).length).toBe(120);
    expect(titleFor([{ role: "system", content: "prompt" }])).toBe("orchestration");
    expect(titleFor([])).toBe("orchestration");
  });
});
