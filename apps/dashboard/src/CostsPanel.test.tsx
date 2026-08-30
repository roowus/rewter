/**
 * The costs panel.
 *
 * Two things are only provable here. First, that the initiator/worker split
 * survives all the way onto the screen — it is the reason the endpoint exists,
 * and a panel that renders one total would pass every test upstream of this
 * one. Second, that a failed refetch leaves the last good numbers up: this
 * panel refetches on every socket event, so a transient failure is routine, and
 * a panel that blanked would say "spent nothing" once an hour.
 */
import type { CostSummary } from "@rewter/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostsPanel } from "./CostsPanel.js";
import { useDashboard } from "./store.js";

const summary = (over: Partial<CostSummary> = {}): CostSummary => ({
  groupBy: "model",
  timeZone: "UTC",
  since: null,
  until: null,
  totals: {
    costUsd: 0.55,
    initiatorCostUsd: 0.4,
    workerCostUsd: 0.15,
    calls: 3,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  buckets: [
    {
      key: "anthropic/claude-opus-5",
      costUsd: 0.4,
      initiatorCostUsd: 0.4,
      workerCostUsd: 0,
      calls: 1,
      inputTokens: 60,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    {
      key: "zai/glm-5.3",
      costUsd: 0.15,
      initiatorCostUsd: 0,
      workerCostUsd: 0.15,
      calls: 2,
      inputTokens: 40,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ],
  ...over,
});

const zero = (): CostSummary["totals"] => ({
  costUsd: 0,
  initiatorCostUsd: 0,
  workerCostUsd: 0,
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
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

describe("CostsPanel", () => {
  it("shows the total and the planning/work split", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(summary())),
    );
    render(<CostsPanel />);
    await screen.findByText("$0.55");
    // The split, not just the total: an orchestrator that spends more deciding
    // than its workers spend doing is the failure this number exists to show.
    expect(screen.getByText(/\$0\.40 planning/)).toBeTruthy();
    expect(screen.getByText(/\$0\.15 work/)).toBeTruthy();
  });

  it("renders a row per bucket with the split preserved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(summary())),
    );
    render(<CostsPanel />);
    // Model ids shorten in the label; the full id stays as the title attribute.
    const row = (await screen.findByText("claude-opus-5")).closest("tr");
    expect(row?.textContent).toContain("$0.40");
    expect(screen.getByText("glm-5.3")).toBeTruthy();
  });

  it("asks the daemon for the grouping the selected tab names", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        urls.push(String(url));
        return ok(summary({ groupBy: "day" }));
      }),
    );
    render(<CostsPanel />);
    await screen.findByText("$0.55");

    screen.getByRole("tab", { name: "by day" }).click();
    await waitFor(() => expect(urls.some((u) => u.includes("groupBy=day"))).toBe(true));
  });

  it("names the zone the day column was bucketed in", async () => {
    // Relabelling a UTC bucket with a local date is how a night's spend moves.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(summary({ groupBy: "day", timeZone: "America/Los_Angeles" }))),
    );
    render(<CostsPanel />);
    screen.getByRole("tab", { name: "by day" }).click();
    await screen.findByText(/days in America\/Los_Angeles/);
  });

  it("refetches when the socket advances", async () => {
    const fetchMock = vi.fn(async () => ok(summary()));
    vi.stubGlobal("fetch", fetchMock);
    render(<CostsPanel />);
    await screen.findByText("$0.55");
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
    render(<CostsPanel />);
    await screen.findByText("$0.55");

    useDashboard.setState({ fold: { ...useDashboard.getState().fold, lastSeq: 9 } });
    await screen.findByText("daemon unreachable");
    // Still there. Blanking would read as "spent nothing".
    expect(screen.getByText("$0.55")).toBeTruthy();
  });

  it("says nothing was spent rather than showing an empty table", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(summary({ buckets: [], totals: zero() }))),
    );
    render(<CostsPanel />);
    // `since: null` — an unbounded query really did find nothing.
    await screen.findByText("Nothing spent yet.");
  });

  it("distinguishes an empty window from an empty daemon", async () => {
    // The default range is 7D, so the first thing anyone sees is a window. If
    // both said "Nothing spent yet." a busy month-old daemon would look unused
    // for the first week after a quiet weekend.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(summary({ buckets: [], totals: zero(), since: 1_700_000_000_000 }))),
    );
    render(<CostsPanel />);
    await screen.findByText("Nothing spent in this range.");
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
    render(<CostsPanel />);
    await screen.findByText("$0.55");
    // 7D is the default: a lifetime total stops being interesting on day three.
    expect(urls[0]).toContain("since=");
    expect(screen.getByRole("tab", { name: "7D" }).getAttribute("aria-selected")).toBe("true");

    screen.getByRole("tab", { name: "All" }).click();
    await waitFor(() => expect(urls.length).toBeGreaterThan(1));
    expect(urls[urls.length - 1]).not.toContain("since=");
  });

  it("re-anchors the window on each fetch instead of freezing it at mount", async () => {
    // A rolling window that keeps its original start is a growing window.
    const sinces: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const value = new URL(String(url), "http://x").searchParams.get("since");
        if (value !== null) sinces.push(Number(value));
        return ok(summary());
      }),
    );
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(1_000_000_000_000);
    render(<CostsPanel />);
    await screen.findByText("$0.55");

    clock.mockReturnValue(1_000_000_060_000);
    useDashboard.setState({ fold: { ...useDashboard.getState().fold, lastSeq: 4 } });
    await waitFor(() => expect(sinces.length).toBeGreaterThan(1));
    const [first] = sinces;
    const latest = sinces[sinces.length - 1];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(latest).toBe(first + 60_000);
    clock.mockRestore();
  });

  it("fills the stat cards only from figures the summary carries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(summary())),
    );
    render(<CostsPanel />);
    // $0.55 over 3 calls, through the same `usd` as every other figure here.
    await screen.findByText("$0.18");
    expect(screen.getByText("100 → 20")).toBeTruthy();
    // Top bucket of the current grouping — the first row, which is cost-sorted.
    expect(screen.getByText("claude-opus-5 · $0.40")).toBeTruthy();
  });

  it("shows a dash rather than a fabricated average when nothing was called", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(summary({ buckets: [], totals: zero() }))),
    );
    render(<CostsPanel />);
    await screen.findByText("Nothing spent yet.");
    // Zero calls is not a zero cost-per-request; `$0` would claim a measurement.
    const card = screen.getByText("cost / request").closest(".cost-card");
    expect(card?.textContent).toContain("—");
  });
});
