/**
 * The practices panel on screen — the same four proofs as the skills panel
 * (count while collapsed, armed reject, 409 → explicit overwrite, refresh
 * after approve), plus the one thing that differs: the fact is what is shown,
 * on the draft card and in the approved table alike.
 */
import type { Practice } from "@rewter/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PracticesPanel } from "./PracticesPanel.js";

const practice = (over: Record<string, unknown> = {}): Practice =>
  ({
    slug: "no-force-push",
    status: "pending",
    scope: "global",
    projectSlug: null,
    path: "/practices/pending/no-force-push/PRACTICE.md",
    fact: "Never force-push a shared branch.",
    learnedFrom: null,
    updatedAt: 1,
    ...over,
  }) as unknown as Practice;

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubFetch(options: {
  practices?: Practice[];
  onWrite?: (url: string) => Response;
}): { writes: Array<{ url: string; body: unknown }> } {
  const writes: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if ((init?.method ?? "GET") === "GET") {
        return ok({ practices: options.practices ?? [practice()] });
      }
      writes.push({
        url: href,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return (
        options.onWrite?.(href) ??
        ok(
          href.endsWith("/reject")
            ? { rejected: "no-force-push" }
            : {
                practice: practice({
                  status: "approved",
                  path: "/practices/global/no-force-push/PRACTICE.md",
                }),
              },
        )
      );
    }),
  );
  return { writes };
}

async function open(): Promise<void> {
  render(<PracticesPanel />);
  fireEvent.click(screen.getByRole("button", { name: "review practices" }));
  await screen.findByText(/Never force-push/);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PracticesPanel", () => {
  it("shows the proposed count in the header even while collapsed", async () => {
    stubFetch({
      practices: [practice(), practice({ slug: "other", status: "approved", path: "/g" })],
    });
    render(<PracticesPanel />);
    await screen.findByText("1 proposed · 1 approved");
    expect(screen.queryByText(/Never force-push/)).toBeNull();
  });

  it("shows the fact, the target scope and the file path on a draft", async () => {
    stubFetch({ practices: [practice({ projectSlug: "rewter", scope: "project" })] });
    await open();
    expect(screen.getByText("proposed → rewter")).toBeTruthy();
    expect(screen.getByText("Never force-push a shared branch.")).toBeTruthy();
    expect(screen.getByText("/practices/pending/no-force-push/PRACTICE.md")).toBeTruthy();
  });

  it("approves with an empty strict body", async () => {
    const { writes } = stubFetch({});
    await open();
    fireEvent.click(screen.getByRole("button", { name: "approve" }));

    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]?.url).toBe("/internal/practices/no-force-push/approve");
    expect(writes[0]?.body).toEqual({});
  });

  it("turns a 409 into an explicit overwrite button, never a silent retry", async () => {
    let approves = 0;
    const { writes } = stubFetch({
      onWrite: (url) => {
        if (!url.endsWith("/approve")) return ok({ rejected: "x" });
        approves += 1;
        return approves === 1
          ? ok({ error: { message: 'an approved "no-force-push" already exists' } }, 409)
          : ok({ practice: practice({ status: "approved" }) });
      },
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "approve" }));

    await screen.findByText(/already exists/);
    expect(writes[0]?.body).toEqual({});
    fireEvent.click(screen.getByRole("button", { name: "approve anyway (overwrite)" }));
    await waitFor(() => expect(writes.length).toBe(2));
    expect(writes[1]?.body).toEqual({ overwrite: true });
  });

  it("asks twice before rejecting", async () => {
    const { writes } = stubFetch({});
    await open();

    fireEvent.click(screen.getByRole("button", { name: "reject" }));
    expect(writes.length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "really reject?" }));

    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]?.url).toBe("/internal/practices/no-force-push/reject");
  });

  it("lists approved practices fact-first, without buttons", async () => {
    stubFetch({
      practices: [
        practice({ status: "approved", path: "/practices/global/no-force-push/PRACTICE.md" }),
      ],
    });
    render(<PracticesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "review practices" }));
    await screen.findByText(/Never force-push/);
    expect(screen.getByText("global")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "reject" })).toBeNull();
  });

  it("explains itself when there are no practices at all", async () => {
    stubFetch({ practices: [] });
    render(<PracticesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "review practices" }));
    await screen.findByText(/No practices yet/);
  });
});
