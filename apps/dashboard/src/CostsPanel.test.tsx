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
      vi.fn(async () =>
        ok(
          summary({
            buckets: [],
            totals: {
              costUsd: 0,
              initiatorCostUsd: 0,
              workerCostUsd: 0,
              calls: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          }),
        ),
      ),
    );
    render(<CostsPanel />);
    await screen.findByText("Nothing spent yet.");
  });
});
