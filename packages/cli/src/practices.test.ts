/**
 * `rewter practices` — the client half only, like `skills.test.ts`: URL/verb/
 * body construction, auth header, exit codes, and that the output tells
 * proposed from approved and shows the fact itself.
 */
import { describe, expect, it } from "vitest";
import { practicesCommand } from "./practices.js";

const PRACTICE = {
  slug: "conventional-commits",
  status: "pending",
  scope: "project",
  projectSlug: "rewter",
  path: "/practices/pending/conventional-commits/PRACTICE.md",
  fact: "Commit subjects use the conventional-commits form: type(scope): summary.",
  learnedFrom: "task_0123456789ab",
  updatedAt: 1_756_252_800_000,
};

const APPROVED = {
  ...PRACTICE,
  status: "approved",
  path: "/practices/rewter/conventional-commits/PRACTICE.md",
};

function harness(respond: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init !== undefined && { init }) });
    const { status, body } = respond(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  const run = (args: string[], env: Record<string, string> = {}) =>
    practicesCommand(args, {
      env: { REWTER_URL: "http://127.0.0.1:20128", ...env },
      fetch: fetchImpl,
      pidfilePath: "/nonexistent/pidfile.json",
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });

  return { calls, out, err, run };
}

describe("rewter practices list", () => {
  it("marks proposed vs approved, shows the fact, and nudges toward review", async () => {
    const h = harness(() => ({ status: 200, body: { practices: [PRACTICE, APPROVED] } }));
    expect(await h.run(["list"])).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("? conventional-commits  [proposed → rewter]");
    expect(text).toContain("✓ conventional-commits  [rewter]");
    expect(text).toContain("Commit subjects use the conventional-commits form");
    expect(text).toContain("1 proposed");
  });

  it("filters with --pending and says so when empty", async () => {
    const h = harness(() => ({ status: 200, body: { practices: [APPROVED] } }));
    expect(await h.run(["list", "--pending"])).toBe(0);
    expect(h.out.join("\n")).toContain("no proposed practices");
  });

  it("sends the internal key and fails loudly on an unexpected shape", async () => {
    const h = harness(() => ({ status: 200, body: { nope: true } }));
    expect(await h.run(["list"], { REWTER_INTERNAL_KEY: "sekrit" })).toBe(1);
    expect((h.calls[0]?.init?.headers as Record<string, string>)["x-api-key"]).toBe("sekrit");
    expect(h.err.join("\n")).toContain("unexpected shape");
  });
});

describe("rewter practices approve/reject", () => {
  it("POSTs approve with an empty strict body, and relays where it landed", async () => {
    const h = harness((url) =>
      url.endsWith("/approve")
        ? { status: 200, body: { practice: APPROVED } }
        : { status: 200, body: { practices: [] } },
    );
    expect(await h.run(["approve", "conventional-commits"])).toBe(0);
    const call = h.calls[0];
    expect(call?.url).toBe(
      "http://127.0.0.1:20128/internal/practices/conventional-commits/approve",
    );
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.body).toBe("{}");
    expect(h.out.join("\n")).toContain("approved conventional-commits into rewter");
  });

  it("carries --overwrite in the body", async () => {
    const h = harness(() => ({ status: 200, body: { practice: APPROVED } }));
    await h.run(["approve", "conventional-commits", "--overwrite"]);
    expect(h.calls[0]?.init?.body).toBe('{"overwrite":true}');
  });

  it("relays the daemon's refusal and exits 1", async () => {
    const h = harness(() => ({
      status: 409,
      body: { error: { message: 'an approved "x" already exists in global/' } },
    }));
    expect(await h.run(["approve", "x"])).toBe(1);
    expect(h.err.join("\n")).toContain("already exists");
  });

  it("rejects with a POST and confirms the deletion", async () => {
    const h = harness(() => ({ status: 200, body: {} }));
    expect(await h.run(["reject", "conventional-commits"])).toBe(0);
    expect(h.calls[0]?.url).toContain("/reject");
    expect(h.out.join("\n")).toContain("rejected conventional-commits");
  });

  it("requires a slug", async () => {
    const h = harness(() => ({ status: 200, body: {} }));
    expect(await h.run(["approve"])).toBe(1);
    expect(h.calls).toHaveLength(0);
    expect(h.err.join("\n")).toContain("name a practice");
  });
});

describe("rewter practices show", () => {
  it("prints the path and provenance so the owner can open the file", async () => {
    const h = harness(() => ({ status: 200, body: { practices: [PRACTICE] } }));
    expect(await h.run(["show", "conventional-commits"])).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain(PRACTICE.path);
    expect(text).toContain(`learned from task ${PRACTICE.learnedFrom}`);
  });

  it("unknown slug exits 1", async () => {
    const h = harness(() => ({ status: 200, body: { practices: [] } }));
    expect(await h.run(["show", "nope"])).toBe(1);
    expect(h.err.join("\n")).toContain("no such practice");
  });
});

describe("dispatch", () => {
  it("bare `rewter practices` lists; unknown subcommand shows usage", async () => {
    const h = harness(() => ({ status: 200, body: { practices: [] } }));
    expect(await h.run([])).toBe(0);
    expect(await h.run(["frobnicate"])).toBe(1);
    expect(h.err.join("\n")).toContain("unknown subcommand");
  });
});
