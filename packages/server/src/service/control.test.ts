import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonStatus, formatStatus, stopDaemon } from "./control.js";
import { type Pidfile, readPidfile, writePidfile } from "./pidfile.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewter-control-"));
  path = join(dir, "rewter.pid");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ENTRY: Pidfile = {
  pid: 4242,
  url: "http://127.0.0.1:8787",
  startedAt: 1_700_000_000_000,
  version: "0.1.0",
};

/** A stub daemon answering `/internal/health` with `body`. */
function health(body: unknown, status = 200): typeof globalThis.fetch {
  return (async (url: string | URL) => {
    expect(String(url)).toBe("http://127.0.0.1:8787/internal/health");
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
}

/** Nothing listening: the shape a dead port takes. */
const refused = (async () => {
  throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
}) as unknown as typeof globalThis.fetch;

const OK = { status: "ok", version: "0.1.0", models: 7, providers: 2 };

describe("daemonStatus", () => {
  it("is stopped when there is no pidfile", async () => {
    expect(await daemonStatus(path)).toEqual({ state: "stopped" });
  });

  it("is stopped when the pidfile is unreadable — no claim, nothing to probe", async () => {
    writeFileSync(path, "{ truncated");
    expect(await daemonStatus(path, { fetch: refused })).toEqual({ state: "stopped" });
  });

  it("is running when the recorded URL answers with rewter's shape", async () => {
    writePidfile(path, ENTRY);
    const status = await daemonStatus(path, { fetch: health(OK) });
    expect(status.state).toBe("running");
    // The payload rides along, so `status` prints counts without a second call.
    if (status.state === "running") expect(status.health.models).toBe(7);
  });

  it("is stale when nothing answers there", async () => {
    // The daemon died without cleaning up — the ordinary `kill -9` case.
    writePidfile(path, ENTRY);
    const status = await daemonStatus(path, { fetch: refused });
    expect(status.state).toBe("stale");
    if (status.state === "stale") expect(status.entry.pid).toBe(4242);
  });

  it("is stale when the socket accepts but never answers", async () => {
    // Bounded so `status` cannot hang: the abort surfaces as a rejected fetch,
    // which means the same thing as a refused connection — nothing is serving.
    writePidfile(path, ENTRY);
    const hangs = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("timed out")));
      })) as unknown as typeof globalThis.fetch;
    const status = await daemonStatus(path, { fetch: hangs, timeoutMs: 20 });
    expect(status.state).toBe("stale");
  });

  it("is unreachable when the port answers, but not as rewter", async () => {
    // The case that matters: something else inherited the port. A liveness
    // check that stopped at "the connection worked" would signal a stranger.
    writePidfile(path, ENTRY);
    const status = await daemonStatus(path, { fetch: health({ hello: "nginx" }) });
    expect(status.state).toBe("unreachable");
    if (status.state === "unreachable") expect(status.reason).toBe("not a rewter daemon");
  });

  it("is unreachable when health returns an error status", async () => {
    writePidfile(path, ENTRY);
    const status = await daemonStatus(path, { fetch: health(OK, 503) });
    expect(status.state).toBe("unreachable");
    if (status.state === "unreachable") expect(status.reason).toContain("503");
  });

  it("is unreachable when the answer is not JSON at all", async () => {
    writePidfile(path, ENTRY);
    const html = (async () =>
      new Response("<html>hello</html>", { status: 200 })) as unknown as typeof globalThis.fetch;
    const status = await daemonStatus(path, { fetch: html });
    expect(status.state).toBe("unreachable");
    if (status.state === "unreachable") expect(status.reason).toContain("JSON");
  });

  it("leaves the pidfile alone — reporting is not repair", async () => {
    writePidfile(path, ENTRY);
    await daemonStatus(path, { fetch: refused });
    expect(readPidfile(path)).toEqual(ENTRY);
  });
});

describe("stopDaemon", () => {
  /** Records signals instead of sending them, so the test runner survives. */
  function recorder() {
    const sent: Array<[number, string]> = [];
    return {
      sent,
      kill: (pid: number, signal: NodeJS.Signals) => {
        sent.push([pid, signal]);
      },
    };
  }

  const noSleep = async () => {};

  it("is a no-op when nothing is running", async () => {
    const { sent, kill } = recorder();
    const outcome = await stopDaemon(path, { kill });
    expect(outcome).toEqual({ ok: true, note: "not running" });
    expect(sent).toEqual([]);
  });

  it("removes a stale pidfile and says the last shutdown was not graceful", async () => {
    writePidfile(path, ENTRY);
    const { sent, kill } = recorder();
    const outcome = await stopDaemon(path, { fetch: refused, kill });
    expect(outcome.ok).toBe(true);
    expect(outcome.note).toContain("stale pidfile");
    // Emphatically not signalled: the pid may belong to anything by now.
    expect(sent).toEqual([]);
    expect(readPidfile(path)).toBeUndefined();
  });

  it("refuses to signal a pid when the port is answering as something else", async () => {
    writePidfile(path, ENTRY);
    const { sent, kill } = recorder();
    const outcome = await stopDaemon(path, { fetch: health({ hello: "nginx" }), kill });
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("refusing to signal pid 4242");
    expect(sent).toEqual([]);
    // And the file stays: this is not our claim to clear.
    expect(readPidfile(path)).toEqual(ENTRY);
  });

  it("SIGTERMs a running daemon and waits for the port to go quiet", async () => {
    writePidfile(path, ENTRY);
    const { sent, kill } = recorder();
    // Answers as rewter until the signal lands, then stops — which is what a
    // graceful shutdown looks like from out here.
    const fetch = (async () => {
      if (sent.length > 0) throw new Error("connect ECONNREFUSED");
      return new Response(JSON.stringify(OK), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const outcome = await stopDaemon(path, { fetch, kill, sleep: noSleep });
    expect(outcome).toEqual({ ok: true, note: "stopped (pid 4242)" });
    expect(sent).toEqual([[4242, "SIGTERM"]]);
  });

  it("never escalates to SIGKILL", async () => {
    // A stream mid-drain killed harder leaves the client parsing a truncated
    // event; if the drain is genuinely stuck that is a thing to report.
    writePidfile(path, ENTRY);
    const { sent, kill } = recorder();
    const outcome = await stopDaemon(path, {
      fetch: health(OK),
      kill,
      sleep: noSleep,
      graceMs: 5,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("after SIGTERM");
    expect(outcome.note).toContain("draining");
    expect(sent.map(([, s]) => s)).toEqual(["SIGTERM"]);
  });

  it("cleans up a pidfile the exiting daemon did not get to remove", async () => {
    writePidfile(path, ENTRY);
    const { sent, kill } = recorder();
    const fetch = (async () => {
      if (sent.length > 0) throw new Error("connect ECONNREFUSED");
      return new Response(JSON.stringify(OK), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await stopDaemon(path, { fetch, kill, sleep: noSleep });
    expect(readPidfile(path)).toBeUndefined();
  });

  it("reports a signal that could not be delivered rather than claiming success", async () => {
    // ESRCH between the probe and the signal: rare, and from here it is
    // indistinguishable from a daemon that exited on its own in the gap.
    writePidfile(path, ENTRY);
    const outcome = await stopDaemon(path, {
      fetch: health(OK),
      kill: () => {
        throw new Error("kill ESRCH");
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("could not signal pid 4242");
  });
});

describe("formatStatus", () => {
  it("says plainly that nothing is running", () => {
    expect(formatStatus({ state: "stopped" })).toBe("rewter is not running");
  });

  it("names the stale case rather than collapsing it into 'not running'", () => {
    // Worth printing: it means the last shutdown was not graceful, and the
    // next boot will have interrupted rows to show for it.
    const line = formatStatus({ state: "stale", entry: ENTRY });
    expect(line).toContain("not running");
    expect(line).toContain("stale pidfile for pid 4242");
    expect(line).toContain("not graceful");
  });

  it("says what is on the port when it is not rewter", () => {
    const line = formatStatus({
      state: "unreachable",
      entry: ENTRY,
      reason: "not a rewter daemon",
    });
    expect(line).toContain("http://127.0.0.1:8787");
    expect(line).toContain("not rewter");
  });

  it("prints version, address, pid, uptime and counts on one line", () => {
    const entry = { ...ENTRY, startedAt: Date.now() - 3 * 60 * 60 * 1000 };
    const line = formatStatus({ state: "running", entry, health: OK });
    expect(line).toBe(
      "rewter 0.1.0 running on http://127.0.0.1:8787, pid 4242, up 3h — 2 provider(s), 7 model(s)",
    );
  });

  it("omits counts a bare health payload does not carry", () => {
    const entry = { ...ENTRY, startedAt: Date.now() - 5_000 };
    const line = formatStatus({ state: "running", entry, health: { status: "ok" } });
    expect(line).toBe("rewter 0.1.0 running on http://127.0.0.1:8787, pid 4242, up 5s");
  });

  it("keeps uptime coarse — 'up 3h' is what you want at a glance", () => {
    const at = (ms: number) =>
      formatStatus({
        state: "running",
        entry: { ...ENTRY, startedAt: Date.now() - ms },
        health: { status: "ok" },
      });
    expect(at(42_000)).toContain("up 42s");
    expect(at(90 * 1000)).toContain("up 1m");
    expect(at(2 * 60 * 60 * 1000)).toContain("up 2h");
    expect(at(5 * 24 * 60 * 60 * 1000)).toContain("up 5d");
    // Clock moved backwards mid-run; not worth a negative.
    expect(at(-10_000)).toContain("up 0s");
  });
});
