/**
 * `rewter skills` — the client half only. The routes it calls are tested in
 * the server (`app.skills.test.ts`); these check what only the CLI can get
 * wrong: URL/verb/body construction, the auth header, the exit codes, and
 * that a person reading the output can tell proposed from approved.
 */
import { describe, expect, it } from "vitest";
import { skillsCommand } from "./skills.js";

const SKILL = {
  slug: "compare-three-sources",
  status: "pending",
  scope: "global",
  projectSlug: null,
  path: "/skills/pending/compare-three-sources/SKILL.md",
  description: "Use when a task asks to compare several sources.",
  learnedFrom: null,
  uses: 0,
  updatedAt: 1_756_252_800_000,
};

const APPROVED = {
  ...SKILL,
  status: "approved",
  path: "/skills/global/compare-three-sources/SKILL.md",
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
    skillsCommand(args, {
      env: { REWTER_URL: "http://127.0.0.1:20128", ...env },
      fetch: fetchImpl,
      pidfilePath: "/nonexistent/pidfile.json",
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });

  return { calls, out, err, run };
}

describe("rewter skills list", () => {
  it("marks proposed vs approved, and nudges toward review", async () => {
    const h = harness(() => ({ status: 200, body: { skills: [SKILL, APPROVED] } }));
    expect(await h.run(["list"])).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("? compare-three-sources  [proposed → global]");
    expect(text).toContain("✓ compare-three-sources  [global]");
    expect(text).toContain("1 proposed");
  });

  it("filters with --pending and says so when empty", async () => {
    const h = harness(() => ({ status: 200, body: { skills: [APPROVED] } }));
    expect(await h.run(["list", "--pending"])).toBe(0);
    expect(h.out.join("\n")).toContain("no proposed skills");
  });

  it("sends the internal key and fails loudly on an unexpected shape", async () => {
    const h = harness(() => ({ status: 200, body: { nope: true } }));
    expect(await h.run(["list"], { REWTER_INTERNAL_KEY: "sekrit" })).toBe(1);
    expect((h.calls[0]?.init?.headers as Record<string, string>)["x-api-key"]).toBe("sekrit");
    expect(h.err.join("\n")).toContain("unexpected shape");
  });
});

describe("rewter skills approve/reject", () => {
  it("POSTs approve with an empty strict body, and relays where it landed", async () => {
    const h = harness((url) =>
      url.endsWith("/approve")
        ? { status: 200, body: { skill: APPROVED } }
        : { status: 200, body: { skills: [] } },
    );
    expect(await h.run(["approve", "compare-three-sources"])).toBe(0);
    const call = h.calls[0];
    expect(call?.url).toBe("http://127.0.0.1:20128/internal/skills/compare-three-sources/approve");
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.body).toBe("{}");
    expect(h.out.join("\n")).toContain("approved compare-three-sources into global");
  });

  it("carries --overwrite in the body", async () => {
    const h = harness(() => ({ status: 200, body: { skill: APPROVED } }));
    await h.run(["approve", "compare-three-sources", "--overwrite"]);
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
    expect(await h.run(["reject", "compare-three-sources"])).toBe(0);
    expect(h.calls[0]?.url).toContain("/reject");
    expect(h.out.join("\n")).toContain("rejected compare-three-sources");
  });

  it("requires a slug", async () => {
    const h = harness(() => ({ status: 200, body: {} }));
    expect(await h.run(["approve"])).toBe(1);
    expect(h.calls).toHaveLength(0);
    expect(h.err.join("\n")).toContain("name a skill");
  });
});

describe("rewter skills show", () => {
  it("prints the path so the owner can open the file", async () => {
    const h = harness(() => ({ status: 200, body: { skills: [SKILL] } }));
    expect(await h.run(["show", "compare-three-sources"])).toBe(0);
    expect(h.out.join("\n")).toContain(SKILL.path);
  });

  it("404-equivalent: unknown slug exits 1", async () => {
    const h = harness(() => ({ status: 200, body: { skills: [] } }));
    expect(await h.run(["show", "nope"])).toBe(1);
    expect(h.err.join("\n")).toContain("no such skill");
  });
});

describe("dispatch", () => {
  it("bare `rewter skills` lists; unknown subcommand shows usage", async () => {
    const h = harness(() => ({ status: 200, body: { skills: [] } }));
    expect(await h.run([])).toBe(0);
    expect(await h.run(["frobnicate"])).toBe(1);
    expect(h.err.join("\n")).toContain("unknown subcommand");
  });
});
