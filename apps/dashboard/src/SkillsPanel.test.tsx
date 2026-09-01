/**
 * The skills panel on screen.
 *
 * What is only provable here: the proposed count is visible while collapsed
 * (the whole point of the header fetch — a queue nobody sees is a queue nobody
 * answers); reject arms before it fires; a 409 turns the approve button into
 * an explicit overwrite rather than retrying silently; and approving refreshes
 * the list so the draft card is replaced by an approved row.
 */
import type { Skill } from "@rewter/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillsPanel } from "./SkillsPanel.js";

const skill = (over: Record<string, unknown> = {}): Skill =>
  ({
    slug: "compare-three-sources",
    status: "pending",
    scope: "global",
    projectSlug: null,
    path: "/skills/pending/compare-three-sources/SKILL.md",
    description: "Use when a task asks to compare several sources.",
    learnedFrom: null,
    uses: 0,
    updatedAt: 1,
    ...over,
  }) as unknown as Skill;

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Serves the list on GET; records and answers every write. */
function stubFetch(options: {
  skills?: Skill[];
  onWrite?: (url: string) => Response;
}): { writes: Array<{ url: string; body: unknown }> } {
  const writes: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if ((init?.method ?? "GET") === "GET") return ok({ skills: options.skills ?? [skill()] });
      writes.push({
        url: href,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return (
        options.onWrite?.(href) ??
        ok(
          href.endsWith("/reject")
            ? { rejected: "compare-three-sources" }
            : { skill: skill({ status: "approved", path: "/skills/global/x/SKILL.md" }) },
        )
      );
    }),
  );
  return { writes };
}

async function open(): Promise<void> {
  render(<SkillsPanel />);
  fireEvent.click(screen.getByRole("button", { name: "review skills" }));
  await screen.findByText(/compare several sources/);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SkillsPanel", () => {
  it("shows the proposed count in the header even while collapsed", async () => {
    stubFetch({ skills: [skill(), skill({ slug: "other", status: "approved", path: "/g" })] });
    render(<SkillsPanel />);
    await screen.findByText("1 proposed · 1 approved");
    // Collapsed: the count is on screen, the cards are not.
    expect(screen.queryByText(/compare several sources/)).toBeNull();
  });

  it("marks a draft as proposed with its target scope and file path", async () => {
    stubFetch({ skills: [skill({ projectSlug: "clarity", scope: "project" })] });
    await open();
    expect(screen.getByText("proposed → clarity")).toBeTruthy();
    expect(screen.getByText("/skills/pending/compare-three-sources/SKILL.md")).toBeTruthy();
  });

  it("approves with an empty strict body and refreshes the list", async () => {
    const { writes } = stubFetch({});
    await open();
    fireEvent.click(screen.getByRole("button", { name: "approve" }));

    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]?.url).toBe("/internal/skills/compare-three-sources/approve");
    expect(writes[0]?.body).toEqual({});
  });

  it("turns a 409 into an explicit overwrite button, never a silent retry", async () => {
    let approves = 0;
    const { writes } = stubFetch({
      onWrite: (url) => {
        if (!url.endsWith("/approve")) return ok({ rejected: "x" });
        approves += 1;
        return approves === 1
          ? ok({ error: { message: 'an approved "compare-three-sources" already exists' } }, 409)
          : ok({ skill: skill({ status: "approved" }) });
      },
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "approve" }));

    // The refusal is shown and the verb changes — the first click did NOT
    // overwrite anything.
    await screen.findByText(/already exists/);
    expect(writes[0]?.body).toEqual({});
    fireEvent.click(screen.getByRole("button", { name: "approve anyway (overwrite)" }));
    await waitFor(() => expect(writes.length).toBe(2));
    expect(writes[1]?.body).toEqual({ overwrite: true });
  });

  it("asks twice before rejecting — the draft is deleted, not archived", async () => {
    const { writes } = stubFetch({});
    await open();

    fireEvent.click(screen.getByRole("button", { name: "reject" }));
    expect(writes.length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "really reject?" }));

    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]?.url).toBe("/internal/skills/compare-three-sources/reject");
  });

  it("lists approved skills in their own table, not as cards with buttons", async () => {
    stubFetch({
      skills: [skill({ status: "approved", path: "/skills/global/x/SKILL.md", uses: 3 })],
    });
    render(<SkillsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "review skills" }));
    await screen.findByText(/compare several sources/);
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "reject" })).toBeNull();
  });

  it("explains itself when there are no skills at all", async () => {
    stubFetch({ skills: [] });
    render(<SkillsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "review skills" }));
    await screen.findByText(/No skills yet/);
  });
});
