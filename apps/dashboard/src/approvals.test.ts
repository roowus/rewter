/**
 * Answering an approval, with the daemon faked out.
 *
 * The status codes carry meaning here — 409 in particular is not a failure the
 * user did anything about — so what is pinned is that each one becomes a
 * different sentence rather than a generic error.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveApproval } from "./approvals.js";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("resolveApproval", () => {
  it("posts the decision and reports that a worker resumed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { resumedWorker: true }));
    const result = await resolveApproval("apr_x", true, undefined, fetchImpl as never);

    expect(result).toEqual({ ok: true, resumedWorker: true, message: "worker resumed" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/internal/approvals/apr_x");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ approved: true });
  });

  it("omits the note entirely rather than sending an empty one", async () => {
    // The route rejects a non-string note; sending `undefined` through
    // JSON.stringify drops the key, but only if it is never set in the first
    // place — an explicit `note: undefined` is the same, so this pins intent.
    const fetchImpl = vi.fn(async () => jsonResponse(200, { resumedWorker: false }));
    await resolveApproval("apr_x", false, undefined, fetchImpl as never);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(Object.keys(JSON.parse(String(init.body)))).toEqual(["approved"]);
  });

  it("carries a denial note through", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { resumedWorker: true }));
    await resolveApproval("apr_x", false, "not on the prod box", fetchImpl as never);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      approved: false,
      note: "not on the prod box",
    });
  });

  it("says the row was settled when nobody was parked on it", async () => {
    // "Approved, but no worker was waiting" is a real outcome — a task that
    // finished, or one from before a restart — and claiming otherwise would
    // send someone looking for a worker that resumed.
    const fetchImpl = vi.fn(async () => jsonResponse(200, { resumedWorker: false }));
    const result = await resolveApproval("apr_x", true, undefined, fetchImpl as never);

    expect(result.ok).toBe(true);
    expect(result.resumedWorker).toBe(false);
    expect(result.message).toBe("recorded — no worker was waiting");
  });

  it("reads 409 as already answered, not as an error the user caused", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, { error: { message: "already approved" } }),
    );
    const result = await resolveApproval("apr_x", true, undefined, fetchImpl as never);

    expect(result).toEqual({ ok: false, resumedWorker: false, message: "already answered" });
  });

  it("distinguishes an unknown id from a settled one", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, { error: { message: "no such approval" } }),
    );
    const result = await resolveApproval("apr_nope", true, undefined, fetchImpl as never);

    expect(result.message).toBe("no such approval");
  });

  it("reports a daemon that is not there instead of throwing", async () => {
    // The click happens in an event handler; an unhandled rejection there is a
    // button that silently does nothing.
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await resolveApproval("apr_x", true, undefined, fetchImpl as never);

    expect(result).toEqual({ ok: false, resumedWorker: false, message: "daemon unreachable" });
  });

  it("survives a success body that is not JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const result = await resolveApproval("apr_x", true, undefined, fetchImpl as never);

    expect(result.ok).toBe(true);
    expect(result.resumedWorker).toBe(false);
  });
});
