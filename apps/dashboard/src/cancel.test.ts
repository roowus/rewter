/**
 * The cancel client's branches.
 *
 * `TaskTree.test.tsx` proves the button reaches this; here the interest is the
 * status codes, and specifically that the two 200s are *not* the same answer.
 */
import { describe, expect, it } from "vitest";
import { cancelTask } from "./cancel.js";

const respond = (status: number, body: unknown = {}): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

const TASK = "task_01J000000000000000000000";

describe("cancelTask", () => {
  it("reports a collapsed live session", async () => {
    const result = await cancelTask(TASK, respond(200, { aborted: true }));
    expect(result).toEqual({ ok: true, aborted: true, message: "cancelling" });
  });

  it("distinguishes a settled row from a killed task", async () => {
    // Both are 200s. Flattening them would tell a user their workers were cut
    // off when in fact there were none — a claim they might act on.
    const result = await cancelTask(TASK, respond(200, { aborted: false }));
    expect(result).toEqual({
      ok: true,
      aborted: false,
      message: "recorded — nothing was running",
    });
  });

  it("treats 409 as a race lost, not a failure of the caller's", async () => {
    const result = await cancelTask(TASK, respond(409, { error: { message: "…" } }));
    expect(result).toMatchObject({ ok: false, message: "already finished" });
  });

  it("reports an id the daemon has never seen", async () => {
    expect(await cancelTask(TASK, respond(404))).toMatchObject({ message: "no such task" });
  });

  it("passes an unexpected status through rather than guessing", async () => {
    expect(await cancelTask(TASK, respond(500))).toMatchObject({ message: "daemon said 500" });
  });

  it("survives a body that is not JSON", async () => {
    // A proxy erroring with an HTML page shouldn't throw inside a click handler.
    const html = (async () => new Response("<html>nope</html>", { status: 200 })) as typeof fetch;
    expect(await cancelTask(TASK, html)).toEqual({
      ok: true,
      aborted: false,
      message: "recorded — nothing was running",
    });
  });

  it("turns a dead daemon into an answer instead of an exception", async () => {
    const dead = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await cancelTask(TASK, dead)).toEqual({
      ok: false,
      aborted: false,
      message: "daemon unreachable",
    });
  });
});
