/**
 * The budget client's branches.
 *
 * `TaskTree.test.tsx` proves the form reaches this; here the interest is the
 * status codes, and — as with `cancelTask` — that the two 200s are different
 * answers. "Saved" and "the running task will now stop at $5" are not the same
 * claim, and only one of them is ever true at a time.
 */
import { describe, expect, it } from "vitest";
import { setTaskBudget } from "./budget.js";

const respond = (status: number, body: unknown = {}): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

const TASK = "task_01J000000000000000000000";

describe("setTaskBudget", () => {
  it("reports a cap a live session took", async () => {
    const result = await setTaskBudget(TASK, 5, respond(200, { applied: true }));
    expect(result).toEqual({ ok: true, applied: true, message: "budget updated" });
  });

  it("distinguishes a row write from a running task changing course", async () => {
    const result = await setTaskBudget(TASK, 5, respond(200, { applied: false }));
    expect(result).toEqual({
      ok: true,
      applied: false,
      message: "saved — nothing was running",
    });
  });

  it("sends null as null rather than as a zero", async () => {
    // The whole distinction the cap rests on: `null` is uncapped, `0` is a cap
    // no work could fit under, and a client that collapsed them would make
    // "remove the budget" unreachable.
    let sent: string | undefined;
    const capture = (async (_url: string, init: RequestInit) => {
      sent = init.body as string;
      return new Response(JSON.stringify({ applied: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await setTaskBudget(TASK, null, capture);
    expect(JSON.parse(sent ?? "{}")).toEqual({ maxSpendUsd: null });
  });

  it("posts to the task's own settings route", async () => {
    let url: string | undefined;
    const capture = (async (u: string) => {
      url = u;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await setTaskBudget(TASK, 3, capture);
    expect(url).toBe(`/internal/tasks/${TASK}/settings`);
  });

  it("treats 409 as a race lost, not a failure of the caller's", async () => {
    const result = await setTaskBudget(TASK, 5, respond(409, { error: { message: "…" } }));
    expect(result).toMatchObject({ ok: false, message: "already finished" });
  });

  it("relays a rejected amount as the input problem it is", async () => {
    expect(await setTaskBudget(TASK, 0, respond(400))).toMatchObject({
      ok: false,
      message: "must be a positive amount",
    });
  });

  it("reports an id the daemon has never seen", async () => {
    expect(await setTaskBudget(TASK, 5, respond(404))).toMatchObject({ message: "no such task" });
  });

  it("passes an unexpected status through rather than guessing", async () => {
    expect(await setTaskBudget(TASK, 5, respond(500))).toMatchObject({
      message: "daemon said 500",
    });
  });

  it("survives a body that is not JSON", async () => {
    const html = (async () => new Response("<html>nope</html>", { status: 200 })) as typeof fetch;
    expect(await setTaskBudget(TASK, 5, html)).toEqual({
      ok: true,
      applied: false,
      message: "saved — nothing was running",
    });
  });

  it("turns a dead daemon into an answer instead of an exception", async () => {
    const dead = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await setTaskBudget(TASK, 5, dead)).toEqual({
      ok: false,
      applied: false,
      message: "daemon unreachable",
    });
  });
});
