/**
 * The skills fetch client.
 *
 * The request plumbing is `registry.ts`'s helper, tested there. What is only
 * provable here: the approve body is strict (`{}` or `{"overwrite":true}`,
 * nothing else), reject POSTs with no body, and the daemon's refusals reach
 * the caller as sentences rather than status codes.
 */
import { describe, expect, it, vi } from "vitest";
import { approveSkill, fetchSkills, rejectSkill } from "./skills.js";

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

const respond = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

describe("fetchSkills", () => {
  it("unwraps the envelope to the rows themselves", async () => {
    const result = await fetchSkills(respond({ skills: [SKILL] }));
    expect(result.ok && result.value[0]?.slug).toBe("compare-three-sources");
  });

  it("refuses a shape it does not recognize rather than rendering blanks", async () => {
    const result = await fetchSkills(respond({ skills: [{ slug: "x" }] }));
    expect(result).toEqual({ ok: false, message: "unrecognized response from daemon" });
  });
});

describe("approveSkill", () => {
  it("POSTs an empty strict body by default", async () => {
    const spy = vi.fn(respond({ skill: { ...SKILL, status: "approved" } }));
    const result = await approveSkill("compare-three-sources", false, spy as typeof fetch);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/internal/skills/compare-three-sources/approve");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(result.ok && result.value.status).toBe("approved");
  });

  it("carries overwrite only when the caller chose it", async () => {
    const spy = vi.fn(respond({ skill: { ...SKILL, status: "approved" } }));
    await approveSkill("compare-three-sources", true, spy as typeof fetch);
    expect((spy.mock.calls[0]?.[1] as RequestInit).body).toBe('{"overwrite":true}');
  });

  it("surfaces the daemon's refusal sentence", async () => {
    const result = await approveSkill(
      "compare-three-sources",
      false,
      respond({ error: { message: 'an approved "compare-three-sources" already exists' } }, 409),
    );
    expect(result).toEqual({
      ok: false,
      message: 'an approved "compare-three-sources" already exists',
    });
  });
});

describe("rejectSkill", () => {
  it("POSTs and reports the slug the daemon says it deleted", async () => {
    const spy = vi.fn(respond({ rejected: "compare-three-sources" }));
    const result = await rejectSkill("compare-three-sources", spy as typeof fetch);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/internal/skills/compare-three-sources/reject");
    expect(init.method).toBe("POST");
    expect(result.ok && result.value).toBe("compare-three-sources");
  });
});
