/**
 * The landing card.
 *
 * `readiness.test.ts` proves the verdict; this proves the card says it out loud
 * — including the case before any health has arrived, where the honest thing is
 * the old sentence and not a verdict nobody has earned yet.
 */
import type { DaemonHealth } from "@rewter/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReadinessCard } from "./ReadinessCard.js";

const health = (registry: Partial<DaemonHealth["registry"]> = {}): DaemonHealth => ({
  status: "ok",
  version: "0.1.0",
  models: 3,
  providers: 2,
  uptimeMs: 246_000,
  startedAt: 1_756_252_800_000 - 246_000,
  pid: 4242,
  url: "http://localhost:2746",
  registry: {
    providersTotal: 8,
    providersEnabled: 2,
    modelsTotal: 180,
    modelsEnabled: 3,
    cards: 41,
    ...registry,
  },
  db: { path: "/home/o/.rewter/rewter.db", sizeBytes: 421_888 },
  events: { count: 1234, lastSeq: 1240 },
  tasks: { running: 1, pendingApprovals: 0 },
});

afterEach(cleanup);

describe("ReadinessCard", () => {
  it("falls back to the invitation before any health has arrived", () => {
    render(<ReadinessCard health={null} />);
    expect(screen.getByText(/No tasks yet/)).toBeTruthy();
    expect(screen.queryByLabelText("readiness")).toBeNull();
  });

  it("says ready, and where to point a client, when nothing is blocking", () => {
    render(<ReadinessCard health={health()} />);
    const card = screen.getByLabelText("readiness");
    expect(card.getAttribute("data-ready")).toBe("true");
    expect(card.textContent).toContain("ready for a task");
    expect(card.textContent).toContain("auto/orchestrator");
  });

  it("says a task would fail, and prints the fix, when a check is blocked", () => {
    render(<ReadinessCard health={health({ modelsTotal: 0, modelsEnabled: 0 })} />);
    const card = screen.getByLabelText("readiness");
    expect(card.getAttribute("data-ready")).toBe("false");
    expect(card.textContent).toContain("a task would fail right now");
    expect(card.textContent).toContain("rewter sync-models");
  });

  // The level rides on an attribute rather than on colour alone, so the warn
  // row is distinguishable from the ok rows around it.
  it("marks each row with its level", () => {
    render(<ReadinessCard health={health({ cards: 0 })} />);
    const rows = screen.getByLabelText("readiness").querySelectorAll(".check");
    expect([...rows].map((r) => r.getAttribute("data-level"))).toEqual(["ok", "ok", "warn"]);
    expect(screen.getByLabelText("readiness").getAttribute("data-ready")).toBe("true");
  });
});
