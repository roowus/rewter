/**
 * The failures panel.
 *
 * What only this layer can get wrong: keeping before-output and mid-stream
 * apart all the way to the screen (a single "errors" count would pass every
 * test upstream of this one), showing the rate as a rate over the window's
 * calls rather than a bare count, and refusing to invent a percentage when
 * nothing was called.
 */
import type { FailureSummary } from "@rewter/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FailuresPanel } from "./FailuresPanel.js";
import { useDashboard } from "./store.js";

const summary = (over: Partial<FailureSummary> = {}): FailureSummary => ({
  since: null,
  until: null,
  totals: {
    failures: 4,
    beforeOutput: 3,
    midStream: 1,
    retried: 2,
    successes: 16,
    byStatus: { "503": 3, none: 1 },
  },
  buckets: [
    {
      key: "zai/glm-5.3",
      failures: 3,
      beforeOutput: 2,
      midStream: 1,
      retried: 1,
      successes: 7,
      byStatus: { "503": 2, none: 1 },
      lastMessage: "connection reset",
      lastAt: 1_756_800_000_000,
    },
    {
      key: "anthropic/claude-opus-5",
      failures: 1,
      beforeOutput: 1,
      midStream: 0,
      retried: 1,
      successes: 9,
      byStatus: { "503": 1 },
      lastMessage: "503 overloaded",
      lastAt: 1_756_800_000_000,
    },
  ],
  ...over,
});

const zero = (): FailureSummary["totals"] => ({
  failures: 0,
  beforeOutput: 0,
  midStream: 0,
  retried: 0,
  successes: 0,
  byStatus: {},
});

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  useDashboard.setState({ fold: { ...useDashboard.getState().fold, lastSeq: 0 } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FailuresPanel", () => {
  it("keeps before-output and mid-stream apart in the headline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(summary())),
    );
    render(<FailuresPanel />);
    await screen.findByText("4");
    expect(screen.getByText(/3 before output · 1 mid-stream · 16 ok/)).toBeTruthy();
  });

  it("shows the mid-stream rate over all calls — the number #9 asked for", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(summary())),
    );
    render(<FailuresPanel />);
    // 1 mid-stream failure over 16 + 4 = 20 calls. The label also heads a
    // table column, so the card is found by its term element.
    const card = (await screen.findByText("mid-stream rate", { selector: "dt" })).closest(
      ".cost-card",
    );
    expect(card?.textContent).toContain("5.0%");
    // 4 failures over 20 calls.
    expect(screen.getByText("failure rate").closest(".cost-card")?.textContent).toContain("20.0%");
    expect(screen.getByText("503 × 3")).toBeTruthy();
  });

  it("renders a row per model with successes beside the failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(summary())),
    );
    render(<FailuresPanel />);
    const row = (await screen.findByText("glm-5.3")).closest("tr");
    // ok, before output, mid-stream, rate (1 of 10), last message.
    expect(row?.textContent).toContain("7");
    expect(row?.textContent).toContain("10.0%");
    expect(row?.textContent).toContain("connection reset");
    expect(screen.getByText("claude-opus-5")).toBeTruthy();
  });

  it("shows a dash rather than a fabricated rate when nothing was called", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(summary({ buckets: [], totals: zero() }))),
    );
    render(<FailuresPanel />);
    await screen.findByText("No upstream calls yet.");
    const card = screen.getByText("mid-stream rate", { selector: "dt" }).closest(".cost-card");
    expect(card?.textContent).toContain("—");
  });

  it("distinguishes an empty window from an empty daemon", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(summary({ buckets: [], totals: zero(), since: 1_700_000_000_000 }))),
    );
    render(<FailuresPanel />);
    await screen.findByText("No upstream calls in this range.");
  });

  it("windows the query on the selected range, and drops it for all", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        urls.push(String(url));
        return ok(summary());
      }),
    );
    render(<FailuresPanel />);
    await screen.findByText("4");
    expect(urls[0]).toContain("/internal/failures?since=");

    screen.getByRole("tab", { name: "All" }).click();
    await waitFor(() => expect(urls.length).toBeGreaterThan(1));
    expect(urls[urls.length - 1]).toBe("/internal/failures");
  });

  it("refetches when the socket advances", async () => {
    const fetchMock = vi.fn(async () => ok(summary()));
    vi.stubGlobal("fetch", fetchMock);
    render(<FailuresPanel />);
    await screen.findByText("4");
    const before = fetchMock.mock.calls.length;

    useDashboard.setState({ fold: { ...useDashboard.getState().fold, lastSeq: 7 } });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });

  it("keeps the last good numbers when a refetch fails", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return ok(summary());
        throw new TypeError("fetch failed");
      }),
    );
    render(<FailuresPanel />);
    await screen.findByText("4");

    useDashboard.setState({ fold: { ...useDashboard.getState().fold, lastSeq: 9 } });
    await screen.findByText("daemon unreachable");
    // Blanking would read as "no failures".
    expect(screen.getByText("4")).toBeTruthy();
  });

  it("rejects a response it does not recognise rather than rendering zeroes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok({ totals: { failures: "many" } })),
    );
    render(<FailuresPanel />);
    await screen.findByText("unrecognized response from daemon");
  });
});
