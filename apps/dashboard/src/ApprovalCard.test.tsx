/**
 * The approval card, clicked.
 *
 * The acceptance criterion for this milestone is approving from the browser
 * while progress streams into a CLI, so what matters here is that a click
 * reaches the daemon with the right decision — and that the card does *not*
 * pretend the answer landed before the daemon says so.
 */
import { ApprovalSchema, newApprovalId, newTaskId } from "@rewter/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "./ApprovalCard.js";

const approval = ApprovalSchema.parse({
  id: newApprovalId(),
  taskId: newTaskId(),
  workItemId: null,
  workerRunId: null,
  status: "pending",
  kind: "shell",
  summary: "rm -rf ./build",
  detail: null,
  resolvedBy: null,
  resolutionNote: null,
  createdAt: 1_756_252_800_000,
  resolvedAt: null,
});

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ApprovalCard", () => {
  it("shows the exact command rather than a paraphrase of it", () => {
    // Approving a summary of a command is approving something you did not read.
    render(<ApprovalCard approval={approval} />);
    expect(screen.getByText("rm -rf ./build")).toBeDefined();
    expect(screen.getByText("shell command")).toBeDefined();
  });

  it("posts an approval when Approve is clicked", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ resumedWorker: true }));
    vi.stubGlobal("fetch", fetchImpl);

    render(<ApprovalCard approval={approval} />);
    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/internal/approvals/${approval.id}`);
    expect(JSON.parse(String(init.body))).toEqual({ approved: true });
  });

  it("carries the note along with a denial", async () => {
    // A denial note comes back to the worker as a tool result, so it is the
    // difference between "no" and "no, use the staging box" — worth sending.
    const fetchImpl = vi.fn(async () => okResponse({ resumedWorker: true }));
    vi.stubGlobal("fetch", fetchImpl);

    render(<ApprovalCard approval={approval} />);
    fireEvent.change(screen.getByPlaceholderText("note (optional)"), {
      target: { value: "not on the prod box" },
    });
    fireEvent.click(screen.getByText("Deny"));

    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      approved: false,
      note: "not on the prod box",
    });
  });

  it("stays on screen after answering rather than hiding itself", async () => {
    // The card leaves when `approval.resolved` folds, not when the click
    // returns. Hiding optimistically would mean a rejected POST leaves the UI
    // claiming an approval the daemon never recorded.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ resumedWorker: true })),
    );

    render(<ApprovalCard approval={approval} />);
    fireEvent.click(screen.getByText("Approve"));

    await screen.findByText("worker resumed");
    expect(screen.getByText("rm -rf ./build")).toBeDefined();
  });

  it("re-enables the buttons when the daemon could not be reached", async () => {
    // A dead daemon is a retryable situation; leaving the buttons disabled
    // would turn a blip into a card that can never be answered.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    render(<ApprovalCard approval={approval} />);
    const approve = screen.getByText("Approve") as HTMLButtonElement;
    fireEvent.click(approve);

    await screen.findByText("daemon unreachable");
    expect(approve.disabled).toBe(false);
  });

  it("keeps the buttons disabled once an answer landed", async () => {
    // The card is about to be folded away; buttons that come back for a frame
    // invite a second click on a settled row, which the daemon answers with 409.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ resumedWorker: false })),
    );

    render(<ApprovalCard approval={approval} />);
    const approve = screen.getByText("Approve") as HTMLButtonElement;
    fireEvent.click(approve);

    await screen.findByText("recorded — no worker was waiting");
    expect(approve.disabled).toBe(true);
  });
});
