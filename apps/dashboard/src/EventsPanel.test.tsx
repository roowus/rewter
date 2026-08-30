/**
 * The event log panel.
 *
 * What is only provable here, at the seam of fetch and render: that a window
 * from the daemon becomes rows newest-first with the summary renderer's line
 * in the "what" column; that "load older" extends history instead of replacing
 * it (and pauses the live tail, saying so); that server-side filters reach the
 * query string; and that a failed refetch keeps the loaded rows up.
 *
 * Envelopes are built through the shared schema's parser, not hand-cast — a
 * hand-built envelope is a second opinion about the shape, and these tests
 * would keep passing after it changed.
 */
import { type EventEnvelope, EventEnvelopeSchema, type EventType, newTaskId } from "@rewter/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventsPanel } from "./EventsPanel.js";
import { useDashboard } from "./store.js";

let seq = 0;
const TASK = newTaskId();

const envelope = (payloadType: EventType, over: Partial<EventEnvelope> = {}): EventEnvelope =>
  EventEnvelopeSchema.parse({
    seq: ++seq,
    ts: 1_756_252_800_000 + seq * 1000,
    taskId: TASK,
    payload:
      payloadType === "task.plan_note"
        ? { type: payloadType, taskId: TASK, note: `note ${seq}` }
        : payloadType === "cost.recorded"
          ? {
              type: payloadType,
              cost: {
                id: `cst_${`${seq}`.padStart(12, "0")}` as never,
                taskId: null,
                workerRunId: null,
                modelId: "zai/glm-5.3",
                inputTokens: 10,
                outputTokens: 2,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: 0.004 * seq,
                pricingSnapshot: {
                  inputPerMTok: 1,
                  outputPerMTok: 2,
                  cacheReadPerMTok: null,
                  cacheWritePerMTok: null,
                },
                createdAt: 1_756_252_800_000,
              },
            }
          : { type: payloadType, taskId: TASK, text: `text ${seq}` },
    ...over,
  });

const window_ = (events: EventEnvelope[], hasMore = false): Response =>
  new Response(JSON.stringify({ events, hasMore }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** The wire sends ascending seq (envelope order); the panel renders newest-first. */
const page = (events: EventEnvelope[], hasMore = false) => window_(events, hasMore);

beforeEach(() => {
  seq = 0;
  useDashboard.setState({ fold: { ...useDashboard.getState().fold, lastSeq: 0 } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open() {
  render(<EventsPanel />);
  (await screen.findByRole("button", { name: "events" })).click();
}

describe("EventsPanel", () => {
  it("renders the window newest-first with one summary line per row", async () => {
    const older = envelope("task.plan_note");
    const newer = envelope("cost.recorded");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => page([older, newer])),
    );
    await open();
    await screen.findByText(/\$0\.0080/); // seq 2 → 0.004×2, the newest row

    const rows = screen.getAllByRole("row");
    // Header + 2 rows; the cost row (newer) sits above the note it followed.
    expect(rows).toHaveLength(3);
    expect(rows[1]?.textContent).toContain("glm-5.3");
    expect(rows[2]?.textContent).toContain("note 1");
  });

  it("sends the type filter to the server rather than filtering client-side", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        urls.push(String(url));
        return page([]);
      }),
    );
    await open();
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));

    // React's controlled select needs the native setter plus a bubbling
    // change event — assigning `.value` alone is swallowed.
    const select = screen.getByLabelText("filter by type") as HTMLSelectElement;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
      select,
      "cost.recorded",
    );
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(urls.some((u) => u.includes("type=cost.recorded"))).toBe(true));
  });

  it("load older extends history and says the live tail is paused", async () => {
    let calls = 0;
    const old = envelope("task.plan_note");
    const fresh = envelope("task.plan_note");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        // First call: the newest window, with history beneath it. Second call
        // ("load older"): the next page back, no more after that.
        return calls === 1 ? page([old, fresh], true) : page([old], false);
      }),
    );
    await open();
    (await screen.findByText("load older")).click();

    await screen.findByText(/live tail paused/);
    // The fresh row is still on screen — extending, not replacing.
    expect(screen.getByText(/note 2/)).toBeTruthy();
  });

  it("keeps loaded rows when a refetch fails", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return page([envelope("task.plan_note")]);
        throw new TypeError("fetch failed");
      }),
    );
    await open();
    await screen.findByText(/note 1/);

    useDashboard.setState({ fold: { ...useDashboard.getState().fold, lastSeq: 5 } });
    await screen.findByText("daemon unreachable");
    expect(screen.getByText(/note 1/)).toBeTruthy();
  });

  it("stays closed until asked — the log is an inspection view, not the front page", async () => {
    const fetchMock = vi.fn(async () => page([]));
    vi.stubGlobal("fetch", fetchMock);
    render(<EventsPanel />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(fetchMock.mock.calls).toHaveLength(0);
  });
});
