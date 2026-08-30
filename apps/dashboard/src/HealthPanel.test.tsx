/**
 * The daemon health strip.
 *
 * What is only provable here: that the facts from `/internal/health` actually
 * reach the screen (uptime measured against the passed clock, the registry's
 * enabled/total split, the db footprint), that a pending approval makes itself
 * loud, and that a transient refetch failure keeps the last good facts up
 * instead of blanking — a health strip that empties reads as "daemon gone".
 */
import type { DaemonHealth } from "@rewter/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HealthPanel } from "./HealthPanel.js";
import { useDashboard } from "./store.js";

const NOW = 1_756_252_800_000;

const health = (over: Partial<DaemonHealth> = {}): DaemonHealth => ({
  status: "ok",
  version: "0.1.0",
  models: 3,
  providers: 2,
  uptimeMs: 246_000,
  startedAt: NOW - 246_000,
  pid: 4242,
  url: "http://localhost:2746",
  registry: {
    providersTotal: 8,
    providersEnabled: 2,
    modelsTotal: 180,
    modelsEnabled: 3,
    cards: 41,
  },
  db: { path: "/home/o/.rewter/rewter.db", sizeBytes: 421_888 },
  events: { count: 1234, lastSeq: 1240 },
  tasks: { running: 1, pendingApprovals: 0 },
  ...over,
});

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  useDashboard.setState({ fold: { ...useDashboard.getState().fold, lastSeq: 1240 } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HealthPanel", () => {
  it("shows the daemon's facts, uptime measured against the passed clock", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(health())),
    );
    render(<HealthPanel now={NOW} />);
    // 246_000ms against the clock, not the server's copy of the same number.
    await screen.findByText("4m 06s");
    expect(screen.getByText("v0.1.0")).toBeTruthy();
    expect(screen.getByText("http://localhost:2746")).toBeTruthy();
    expect(screen.getByText("412 KB")).toBeTruthy();
  });

  it("shows the registry's enabled/total split, not just the totals", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(health())),
    );
    render(<HealthPanel now={NOW} />);
    const registry = (await screen.findByText(/providers/)).closest("dd");
    // 2 of 8 providers with keys configured is the number that explains why a
    // model 404s; 8 alone would read as fully stocked.
    expect(registry?.textContent).toContain("2/8 providers");
    expect(registry?.textContent).toContain("3/180 models");
    expect(registry?.textContent).toContain("41 cards");
  });

  it("names the db file when it has no size to quote (in-memory or missing)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(health({ db: { path: ":memory:", sizeBytes: null } }))),
    );
    render(<HealthPanel now={NOW} />);
    await screen.findByText(":memory:");
  });

  it("makes a pending approval impossible to read as quiet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(health({ tasks: { running: 2, pendingApprovals: 1 } }))),
    );
    render(<HealthPanel now={NOW} />);
    const pending = await screen.findByText(/1 awaiting approval/);
    expect(pending.dataset.pending).toBe("true");
  });

  it("says how far behind the view is when the daemon's log is ahead of the fold", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(health())),
    );
    useDashboard.setState({ fold: { ...useDashboard.getState().fold, lastSeq: 1237 } });
    render(<HealthPanel now={NOW} />);
    await screen.findByText(/catching up — 3 events behind/);
  });

  it("keeps the last good facts when a refetch fails", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return ok(health());
        throw new TypeError("fetch failed");
      }),
    );
    render(<HealthPanel now={NOW} />);
    await screen.findByText("4m 06s");

    useDashboard.setState({ fold: { ...useDashboard.getState().fold, lastSeq: 1241 } });
    await screen.findByText("daemon unreachable");
    expect(screen.getByText("4m 06s")).toBeTruthy();
  });
});
