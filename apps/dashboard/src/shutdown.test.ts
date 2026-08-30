/**
 * The shutdown client's branches.
 *
 * Two of them return `ok: true` with no result, from opposite causes — a daemon
 * that answered with something unreadable, and a daemon that died before it
 * could answer at all. Both are shutdowns in progress, and the test that matters
 * is that neither is reported as a failure: the operator's next move is to watch
 * the socket, not to press the button again.
 */
import { describe, expect, it } from "vitest";
import { shutdownDaemon, shutdownMessage } from "./shutdown.js";

const respond = (status: number, body: unknown = {}): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

const ACCEPTED = {
  ok: true,
  pid: 4242,
  supervisor: "launchd",
  willRestart: false,
  restartWith: "launchctl kickstart gui/$(id -u)/com.roowus.rewter",
};

describe("shutdownDaemon", () => {
  it("returns the daemon's own account of what will happen next", async () => {
    const out = await shutdownDaemon(respond(202, ACCEPTED));
    expect(out).toEqual({ ok: true, result: ACCEPTED });
  });

  it("says a daemon without the hook cannot stop itself, and names the way that can", async () => {
    // 501 is the one refusal worth its own sentence: nothing failed, the
    // capability is absent, and `rewter stop` still works from a terminal.
    const out = await shutdownDaemon(respond(501, { error: { message: "no hook" } }));
    expect(out).toEqual({
      ok: false,
      message: "this daemon cannot stop itself — use `rewter stop`",
    });
  });

  it("passes an unexpected status through rather than guessing", async () => {
    expect(await shutdownDaemon(respond(500))).toEqual({
      ok: false,
      message: "daemon said 500",
    });
  });

  it("treats an accepted-but-unreadable reply as accepted", async () => {
    // A proxy that rewrote the body, or a daemon older than this schema. It is
    // going down either way; reporting a failure would leave someone waiting
    // for a daemon that is already gone.
    const html = (async () => new Response("<html>ok</html>", { status: 202 })) as typeof fetch;
    expect(await shutdownDaemon(html)).toEqual({ ok: true, result: null });
  });

  it("reads a connection that died mid-request as the shutdown winning the race", async () => {
    // The failure that looks most like a network error and is in fact the
    // success case: the process went before the reply could cross the socket.
    const dead = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await shutdownDaemon(dead)).toEqual({ ok: true, result: null });
  });
});

describe("shutdownMessage", () => {
  it("says the connection closed first when there is no result to read", async () => {
    expect(shutdownMessage(null)).toContain("closed before it answered");
  });

  it("promises nothing will bring it back under launchd, and names the command", () => {
    const line = shutdownMessage({
      ...ACCEPTED,
      ok: true as const,
      supervisor: "launchd" as const,
    });
    expect(line).toContain("nothing will start it again");
    expect(line).toContain("launchctl kickstart");
  });

  it("declines to promise either way when the supervisor is unknown", () => {
    // The sentence a guess would replace: "may or may not" is the honest
    // reading of a process that does not recognise what started it.
    const line = shutdownMessage({
      ok: true,
      pid: 1,
      supervisor: "unknown",
      willRestart: null,
      restartWith: "rewter start",
    });
    expect(line).toContain("may or may not come back");
    expect(line).toContain("rewter start");
  });

  it("names the supervisor when something really is expected to restart it", () => {
    const line = shutdownMessage({
      ok: true,
      pid: 1,
      supervisor: "launchd",
      willRestart: true,
      restartWith: "launchctl kickstart gui/$(id -u)/com.roowus.rewter",
    });
    expect(line).toContain("launchd is expected to start it again");
  });
});
