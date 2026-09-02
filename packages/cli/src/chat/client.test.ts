import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Project, ProjectSchema, newProjectId } from "@rewter/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cancelTask,
  discoverDaemon,
  listProjects,
  projectForCwd,
  resolveApproval,
  steerTask,
} from "./client.js";
import type { Connection } from "./client.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewter-chat-client-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function pidfileAt(url: string): string {
  const path = join(dir, "rewter.pid");
  writeFileSync(
    path,
    JSON.stringify({ pid: 4242, url, startedAt: Date.now(), version: "0.0.0-test" }),
  );
  return path;
}

/** A fetch that records every call and answers from a script, in order. */
function scriptedFetch(responses: Response[]): {
  fetch: typeof globalThis.fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next === undefined) throw new Error("scripted fetch exhausted");
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const healthOk = () =>
  new Response(JSON.stringify({ status: "ok", version: "0.0.0-test" }), { status: 200 });

describe("discoverDaemon", () => {
  it("finds a running daemon through the pidfile after the health probe passes", async () => {
    const { fetch, calls } = scriptedFetch([healthOk()]);
    const found = await discoverDaemon({
      env: {},
      pidfilePath: pidfileAt("http://127.0.0.1:20180"),
      fetch,
    });
    expect(found).toEqual({
      ok: true,
      connection: { baseUrl: "http://127.0.0.1:20180", headers: {} },
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:20180/internal/health");
  });

  it("lets REWTER_URL override the pidfile without probing", async () => {
    // The tailnet case: the daemon is on another machine, no local pidfile
    // speaks for it, and a probe against the local file would be wrong anyway.
    const { fetch, calls } = scriptedFetch([]);
    const found = await discoverDaemon({
      env: { REWTER_URL: "http://rewter-host.tail:20180/" },
      pidfilePath: pidfileAt("http://127.0.0.1:1"),
      fetch,
    });
    expect(found).toEqual({
      ok: true,
      connection: { baseUrl: "http://rewter-host.tail:20180", headers: {} },
    });
    expect(calls).toHaveLength(0);
  });

  it("reports stopped when there is no pidfile", async () => {
    const { fetch } = scriptedFetch([]);
    const found = await discoverDaemon({
      env: {},
      pidfilePath: join(dir, "absent.pid"),
      fetch,
    });
    expect(found).toEqual({
      ok: false,
      reason: "rewter is not running — start it with `rewter start`",
    });
  });

  it("reports a stale pidfile when the URL does not answer", async () => {
    const fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const found = await discoverDaemon({
      env: {},
      pidfilePath: pidfileAt("http://127.0.0.1:1"),
      fetch,
    });
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.reason).toContain("stale pidfile for pid 4242");
  });

  it("refuses a port where something non-rewter answers", async () => {
    const { fetch } = scriptedFetch([new Response("<html>hello</html>", { status: 200 })]);
    const found = await discoverDaemon({
      env: {},
      pidfilePath: pidfileAt("http://127.0.0.1:8080"),
      fetch,
    });
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.reason).toContain("it is not rewter");
  });

  it("sends the internal key as x-api-key, preferring it over the API key", async () => {
    const { fetch } = scriptedFetch([healthOk()]);
    const found = await discoverDaemon({
      env: { REWTER_INTERNAL_KEY: "int-key", REWTER_API_KEY: "api-key" },
      pidfilePath: pidfileAt("http://127.0.0.1:20180"),
      fetch,
    });
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.connection.headers).toEqual({ "x-api-key": "int-key" });
  });

  it("falls back to the API key when no internal key is set", async () => {
    const { fetch } = scriptedFetch([healthOk()]);
    const found = await discoverDaemon({
      env: { REWTER_API_KEY: "api-key" },
      pidfilePath: pidfileAt("http://127.0.0.1:20180"),
      fetch,
    });
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.connection.headers).toEqual({ "x-api-key": "api-key" });
  });
});

const conn: Connection = { baseUrl: "http://127.0.0.1:20180", headers: { "x-api-key": "k" } };
const TASK_ID = "task_abcdefghijkl";

describe("steerTask", () => {
  it("POSTs the message and returns the parsed result", async () => {
    const { fetch, calls } = scriptedFetch([
      new Response(
        JSON.stringify({ taskId: TASK_ID, queued: true, remainder: "hurry up", approvals: 1 }),
        { status: 202 },
      ),
    ]);
    const outcome = await steerTask(conn, fetch, TASK_ID, "approve apr_x\nhurry up");
    expect(outcome).toEqual({
      ok: true,
      result: { taskId: TASK_ID, queued: true, remainder: "hurry up", approvals: 1 },
    });
    const call = calls[0];
    expect(call?.url).toBe(`http://127.0.0.1:20180/internal/tasks/${TASK_ID}/steer`);
    expect(call?.init?.method).toBe("POST");
    expect(JSON.parse(String(call?.init?.body))).toEqual({ message: "approve apr_x\nhurry up" });
    expect((call?.init?.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });

  it("relays the daemon's error envelope on a 409", async () => {
    const { fetch } = scriptedFetch([
      new Response(
        JSON.stringify({ error: { message: "task is already succeeded", type: "conflict" } }),
        { status: 409 },
      ),
    ]);
    const outcome = await steerTask(conn, fetch, TASK_ID, "too late");
    expect(outcome).toEqual({ ok: false, status: 409, reason: "task is already succeeded" });
  });

  it("falls back to the status code when the error body is not JSON", async () => {
    const { fetch } = scriptedFetch([new Response("nope", { status: 500 })]);
    const outcome = await steerTask(conn, fetch, TASK_ID, "x");
    expect(outcome).toEqual({ ok: false, status: 500, reason: "daemon returned 500" });
  });

  it("rejects a 2xx body that does not match the contract", async () => {
    // A daemon from the future (or the past) answering something else must not
    // be laundered into a plausible result.
    const { fetch } = scriptedFetch([new Response(JSON.stringify({ ok: 1 }), { status: 202 })]);
    const outcome = await steerTask(conn, fetch, TASK_ID, "x");
    expect(outcome).toEqual({
      ok: false,
      status: 202,
      reason: "daemon answered with an unexpected shape",
    });
  });
});

describe("resolveApproval", () => {
  it("POSTs approved with an optional note", async () => {
    const { fetch, calls } = scriptedFetch([new Response("{}", { status: 200 })]);
    const outcome = await resolveApproval(conn, fetch, "apr_abcdefghijkl", true, "go ahead");
    expect(outcome).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("http://127.0.0.1:20180/internal/approvals/apr_abcdefghijkl");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ approved: true, note: "go ahead" });
  });

  it("omits an empty note", async () => {
    const { fetch, calls } = scriptedFetch([new Response("{}", { status: 200 })]);
    await resolveApproval(conn, fetch, "apr_abcdefghijkl", false, "");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ approved: false });
  });

  it("relays a failure", async () => {
    const { fetch } = scriptedFetch([
      new Response(JSON.stringify({ error: { message: "approval not pending" } }), { status: 409 }),
    ]);
    const outcome = await resolveApproval(conn, fetch, "apr_abcdefghijkl", true);
    expect(outcome).toEqual({ ok: false, status: 409, reason: "approval not pending" });
  });
});

describe("cancelTask", () => {
  it("POSTs the cancel and reports success", async () => {
    const { fetch, calls } = scriptedFetch([new Response("{}", { status: 200 })]);
    const outcome = await cancelTask(conn, fetch, TASK_ID);
    expect(outcome).toEqual({ ok: true });
    expect(calls[0]?.url).toBe(`http://127.0.0.1:20180/internal/tasks/${TASK_ID}/cancel`);
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("relays a failure", async () => {
    const { fetch } = scriptedFetch([new Response("{}", { status: 404 })]);
    const outcome = await cancelTask(conn, fetch, TASK_ID);
    expect(outcome).toEqual({ ok: false, status: 404, reason: "daemon returned 404" });
  });
});

function project(
  slug: string,
  resources: { kind: "dir" | "repo" | "doc" | "url"; location: string }[],
  archived = false,
): Project {
  return ProjectSchema.parse({
    id: newProjectId(),
    slug,
    name: slug,
    resources,
    archived,
    createdAt: 1_724_800_000_000,
    updatedAt: 1_724_800_000_000,
  });
}

describe("listProjects", () => {
  it("GETs /internal/projects with the connection's headers and parses the list", async () => {
    const p = project("clarity", [{ kind: "repo", location: "/Users/me/projects/clarity" }]);
    const { fetch, calls } = scriptedFetch([
      new Response(JSON.stringify({ projects: [p] }), { status: 200 }),
    ]);
    const outcome = await listProjects(conn, fetch);
    expect(outcome).toEqual({ ok: true, projects: [p] });
    expect(calls[0]?.url).toBe("http://127.0.0.1:20180/internal/projects");
    expect((calls[0]?.init?.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });

  it("is a reason, not a throw, when the daemon refuses or is too old", async () => {
    const refused = scriptedFetch([
      new Response(JSON.stringify({ error: { message: "unauthorised" } }), { status: 401 }),
    ]);
    expect(await listProjects(conn, refused.fetch)).toEqual({ ok: false, reason: "unauthorised" });

    const older = scriptedFetch([new Response("<html>not found</html>", { status: 404 })]);
    expect(await listProjects(conn, older.fetch)).toEqual({
      ok: false,
      reason: "daemon returned 404",
    });

    const down = {
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof globalThis.fetch,
    };
    expect(await listProjects(conn, down.fetch)).toEqual({ ok: false, reason: "ECONNREFUSED" });
  });

  it("rejects an unexpected shape rather than guessing", async () => {
    const notList = scriptedFetch([
      new Response(JSON.stringify({ projects: "nope" }), { status: 200 }),
    ]);
    expect(await listProjects(conn, notList.fetch)).toEqual({
      ok: false,
      reason: "daemon answered with an unexpected shape",
    });
    const badElement = scriptedFetch([
      new Response(JSON.stringify({ projects: [{ slug: "x" }] }), { status: 200 }),
    ]);
    expect(await listProjects(conn, badElement.fetch)).toEqual({
      ok: false,
      reason: "daemon answered with an unexpected shape",
    });
  });
});

describe("projectForCwd", () => {
  const clarity = project("clarity", [{ kind: "repo", location: "/Users/me/projects/clarity" }]);
  const mono = project("mono", [{ kind: "dir", location: "/Users/me/projects/mono" }]);
  const pkg = project("mono-web", [{ kind: "dir", location: "/Users/me/projects/mono/apps/web" }]);
  const docsOnly = project("notes", [
    { kind: "doc", location: "/Users/me/projects/notes/README.md" },
    { kind: "url", location: "https://example.com" },
  ]);

  it("matches the project whose dir/repo contains the cwd, at any depth", () => {
    expect(projectForCwd([clarity, mono], "/Users/me/projects/clarity")?.slug).toBe("clarity");
    expect(projectForCwd([clarity, mono], "/Users/me/projects/clarity/src/deep")?.slug).toBe(
      "clarity",
    );
    expect(projectForCwd([clarity, mono], "/Users/me/projects/clarity/")?.slug).toBe("clarity");
  });

  it("does not match a sibling that merely shares a prefix", () => {
    expect(projectForCwd([clarity], "/Users/me/projects/clarity-fork")).toBeUndefined();
    expect(projectForCwd([clarity], "/Users/me")).toBeUndefined();
  });

  it("prefers the deepest resource when projects nest", () => {
    expect(projectForCwd([mono, pkg], "/Users/me/projects/mono/apps/web/src")?.slug).toBe(
      "mono-web",
    );
    expect(projectForCwd([pkg, mono], "/Users/me/projects/mono/apps/web/src")?.slug).toBe(
      "mono-web",
    );
    expect(projectForCwd([mono, pkg], "/Users/me/projects/mono/packages/x")?.slug).toBe("mono");
  });

  it("ignores doc/url resources and archived projects", () => {
    expect(projectForCwd([docsOnly], "/Users/me/projects/notes")).toBeUndefined();
    const gone = project(
      "clarity",
      [{ kind: "repo", location: "/Users/me/projects/clarity" }],
      true,
    );
    expect(projectForCwd([gone], "/Users/me/projects/clarity")).toBeUndefined();
  });

  it("returns undefined when nothing matches or there are no projects", () => {
    expect(projectForCwd([], "/anywhere")).toBeUndefined();
    expect(projectForCwd([clarity], "/tmp")).toBeUndefined();
  });
});
