import type { ChatMessage, StreamChunk, TaskId } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { LiveTaskIndex, continuationKeys, conversationKey, newMessagesSince } from "./live.js";

const TASK = "task_one" as TaskId;

/** A source the test drives by hand, so timing is deterministic. */
function controllable(): {
  source: AsyncIterable<StreamChunk>;
  push: (text: string) => void;
  fail: (err: Error) => void;
  close: () => void;
} {
  const queue: StreamChunk[] = [];
  let notify: (() => void) | null = null;
  let closed = false;
  let failure: Error | null = null;
  const wake = (): void => {
    const fn = notify;
    notify = null;
    fn?.();
  };
  const source = (async function* () {
    while (true) {
      while (queue.length > 0) {
        const c = queue.shift();
        if (c !== undefined) yield c;
      }
      if (failure !== null) throw failure;
      if (closed) return;
      await new Promise<void>((r) => {
        notify = r;
      });
    }
  })();
  return {
    source,
    push: (text) => {
      queue.push({ type: "text_delta", text });
      wake();
    },
    fail: (err) => {
      failure = err;
      wake();
    },
    close: () => {
      closed = true;
      wake();
    },
  };
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of stream) if (c.type === "text_delta") out.push(c.text);
  return out;
}

/** A timer stub: nothing fires until the test says so. */
function fakeTimers(): {
  timers: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (h: unknown) => void;
  };
  fire: () => void;
  pending: () => number;
} {
  const jobs = new Map<number, () => void>();
  let next = 1;
  return {
    timers: {
      setTimeout: (fn) => {
        const id = next++;
        jobs.set(id, fn);
        return id;
      },
      clearTimeout: (h) => {
        jobs.delete(h as number);
      },
    },
    fire: () => {
      const all = [...jobs.values()];
      jobs.clear();
      for (const fn of all) fn();
    },
    pending: () => jobs.size,
  };
}

describe("conversation keys", () => {
  const base: ChatMessage[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
  ];

  it("finds the original conversation among a follow-up's prefixes", () => {
    const followUp: ChatMessage[] = [...base, { role: "user", content: "also do c" }];
    expect(continuationKeys(followUp)).toContain(conversationKey(base));
  });

  it("does not treat an identical re-POST as a continuation of itself", () => {
    // A resend with no new turn is a retry. Matching it would inject the whole
    // conversation back into the task as steering.
    expect(continuationKeys(base)).not.toContain(conversationKey(base));
  });

  it("puts the longest prefix first, so the newest task wins", () => {
    const deep: ChatMessage[] = [
      ...base,
      { role: "user", content: "c" },
      { role: "user", content: "d" },
    ];
    const keys = continuationKeys(deep);
    expect(keys[0]).toBe(conversationKey(deep.slice(0, 3)));
    expect(keys[1]).toBe(conversationKey(base));
  });

  it("bounds how far back it looks", () => {
    const long: ChatMessage[] = Array.from({ length: 50 }, (_, i) => ({
      role: "user" as const,
      content: `m${i}`,
    }));
    expect(continuationKeys(long, 8)).toHaveLength(8);
  });

  it("recovers exactly the messages added since a task started", () => {
    const followUp: ChatMessage[] = [...base, { role: "user", content: "new" }];
    expect(newMessagesSince(followUp, conversationKey(base))).toEqual([
      { role: "user", content: "new" },
    ]);
  });

  it("distinguishes conversations that differ only in role", () => {
    const asUser: ChatMessage[] = [{ role: "user", content: "x" }];
    const asAssistant: ChatMessage[] = [{ role: "assistant", content: "x" }];
    expect(conversationKey(asUser)).not.toBe(conversationKey(asAssistant));
  });
});

describe("LiveTask", () => {
  it("replays what it already buffered to a late subscriber, then follows live", async () => {
    const src = controllable();
    const index = new LiveTaskIndex(fakeTimers());
    const task = index.register({
      taskId: TASK,
      key: "k",
      abort: new AbortController(),
      source: src.source,
    });

    src.push("one");
    await tick();
    // Subscribe *after* the first chunk: reconnection is the whole point.
    const read = drain(task.subscribe());
    await tick();
    src.push("two");
    src.close();

    expect(await read).toEqual(["one", "two"]);
  });

  it("keeps pumping with nobody attached, so a disconnect loses no output", async () => {
    const src = controllable();
    const index = new LiveTaskIndex(fakeTimers());
    const task = index.register({
      taskId: TASK,
      key: "k",
      abort: new AbortController(),
      source: src.source,
    });

    src.push("while-gone");
    await tick();
    expect(task.subscriberCount).toBe(0);

    src.push("still-gone");
    src.close();
    await tick();

    expect(await drain(task.subscribe())).toEqual(["while-gone", "still-gone"]);
  });

  it("broadcasts one chunk to every attached subscriber", async () => {
    const src = controllable();
    const index = new LiveTaskIndex(fakeTimers());
    const task = index.register({
      taskId: TASK,
      key: "k",
      abort: new AbortController(),
      source: src.source,
    });

    const a = drain(task.subscribe());
    const b = drain(task.subscribe());
    await tick();
    src.push("shared");
    src.close();

    expect(await a).toEqual(["shared"]);
    expect(await b).toEqual(["shared"]);
  });

  it("releases a subscriber when the client disconnects, without cancelling the task", async () => {
    const src = controllable();
    const index = new LiveTaskIndex(fakeTimers());
    const abort = new AbortController();
    const task = index.register({ taskId: TASK, key: "k", abort, source: src.source });

    const clientGone = new AbortController();
    const read = drain(task.subscribe(clientGone.signal));
    await tick();
    src.push("seen");
    await tick();
    clientGone.abort();

    expect(await read).toEqual(["seen"]);
    expect(abort.signal.aborted).toBe(false);
    expect(task.isFinished).toBe(false);
    src.close();
  });

  it("ends every subscriber when the pump throws, rather than hanging them", async () => {
    const src = controllable();
    const index = new LiveTaskIndex(fakeTimers());
    const task = index.register({
      taskId: TASK,
      key: "k",
      abort: new AbortController(),
      source: src.source,
    });

    const read = drain(task.subscribe());
    await tick();
    src.push("before");
    await tick();
    src.fail(new Error("upstream died"));

    await expect(read).rejects.toThrow("upstream died");
  });

  it("drains steering once", () => {
    const index = new LiveTaskIndex(fakeTimers());
    const task = index.register({
      taskId: TASK,
      key: "k",
      abort: new AbortController(),
      source: (async function* () {})(),
    });
    task.steer("do it differently");
    expect(task.drainSteering()).toEqual(["do it differently"]);
    expect(task.drainSteering()).toEqual([]);
  });
});

describe("LiveTaskIndex", () => {
  const conversation: ChatMessage[] = [{ role: "user", content: "start" }];

  function register(
    index: LiveTaskIndex,
    id: string,
    conv: ChatMessage[],
  ): ReturnType<LiveTaskIndex["register"]> {
    return index.register({
      taskId: id as TaskId,
      key: conversationKey(conv),
      abort: new AbortController(),
      source: controllable().source,
    });
  }

  it("matches a follow-up to the running task it continues, with its new messages", () => {
    const index = new LiveTaskIndex(fakeTimers());
    register(index, "task_a", conversation);

    const followUp: ChatMessage[] = [
      ...conversation,
      { role: "assistant", content: "working" },
      { role: "user", content: "actually, focus on X" },
    ];
    const hit = index.match({ conversation: followUp });
    expect(hit?.task.taskId).toBe("task_a");
    expect(hit?.newMessages.at(-1)?.content).toBe("actually, focus on X");
  });

  it("prefers the task id header over the conversation", () => {
    const index = new LiveTaskIndex(fakeTimers());
    register(index, "task_a", conversation);
    register(index, "task_b", [{ role: "user", content: "other" }]);

    const hit = index.match({
      taskIdHeader: "task_b",
      conversation: [...conversation, { role: "user", content: "more" }],
    });
    expect(hit?.task.taskId).toBe("task_b");
  });

  it("falls back to the conversation when the header names a task that is gone", () => {
    const index = new LiveTaskIndex(fakeTimers());
    register(index, "task_a", conversation);
    const hit = index.match({
      taskIdHeader: "task_vanished",
      conversation: [...conversation, { role: "user", content: "more" }],
    });
    expect(hit?.task.taskId).toBe("task_a");
  });

  it("returns the newest task when two share a conversation", () => {
    const index = new LiveTaskIndex(fakeTimers());
    register(index, "task_old", conversation);
    register(index, "task_new", conversation);
    const hit = index.match({ conversation: [...conversation, { role: "user", content: "go" }] });
    expect(hit?.task.taskId).toBe("task_new");
  });

  it("does not match a fresh conversation", () => {
    const index = new LiveTaskIndex(fakeTimers());
    register(index, "task_a", conversation);
    expect(index.match({ conversation: [{ role: "user", content: "unrelated" }] })).toBeNull();
  });

  it("cancels a task nobody came back for", async () => {
    const timers = fakeTimers();
    const index = new LiveTaskIndex(timers);
    const src = controllable();
    const abort = new AbortController();
    const task = index.register({ taskId: TASK, key: "k", abort, source: src.source });

    const clientGone = new AbortController();
    const read = drain(task.subscribe(clientGone.signal));
    await tick();
    clientGone.abort();
    await read;

    expect(timers.pending()).toBe(1);
    timers.fire();
    expect(abort.signal.aborted).toBe(true);
  });

  it("spares a task whose client reconnected inside the grace window", async () => {
    const timers = fakeTimers();
    const index = new LiveTaskIndex(timers);
    const src = controllable();
    const abort = new AbortController();
    const task = index.register({ taskId: TASK, key: "k", abort, source: src.source });

    const clientGone = new AbortController();
    const first = drain(task.subscribe(clientGone.signal));
    await tick();
    clientGone.abort();
    await first;

    // The reconnect: a second subscriber before the timer fires.
    index.cancelGrace(TASK);
    const second = drain(task.subscribe());
    await tick();
    timers.fire();

    expect(abort.signal.aborted).toBe(false);
    src.push("survived");
    src.close();
    expect(await second).toEqual(["survived"]);
  });

  it("forgets a task once it finishes, so a later conversation starts fresh", async () => {
    const index = new LiveTaskIndex(fakeTimers());
    const src = controllable();
    index.register({
      taskId: TASK,
      key: conversationKey(conversation),
      abort: new AbortController(),
      source: src.source,
    });
    expect(index.size).toBe(1);

    src.close();
    await tick();

    expect(index.size).toBe(0);
    expect(
      index.match({ conversation: [...conversation, { role: "user", content: "more" }] }),
    ).toBeNull();
  });

  it("cancels everything on shutdown", () => {
    const index = new LiveTaskIndex(fakeTimers());
    const abort = new AbortController();
    index.register({ taskId: TASK, key: "k", abort, source: controllable().source });
    index.shutdown();
    expect(abort.signal.aborted).toBe(true);
  });
});

/** Let the pump's microtasks run. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
