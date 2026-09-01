/**
 * The run panel.
 *
 * What is only provable here, at the seam of form and fetch: that the button
 * refuses to fire on an empty prompt (a stray click starting an unbounded
 * fan-out is the failure mode worth designing against); that a bad budget is
 * caught in place rather than costing a round-trip to be told the same thing;
 * that a refusal shows the daemon's own sentence, because "use the chat tester"
 * is the entire answer someone needs; and that a successful start names the
 * initiator, which is the one thing the user did not choose and the tree below
 * will not spell out.
 *
 * The registry fetch that fills the pin dropdown is stubbed but never asserted
 * on beyond "the form still works without it" — a dashboard that would not let
 * you start a task because the model list failed to load would have the
 * dependency backwards.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunPanel } from "./RunPanel.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ACCEPTED = {
  taskId: "task_a1b2c3d4e5f6",
  title: "compare these three things",
  initiatorModelId: "anthropic/claude-opus-5",
};

const REGISTRY = {
  models: [
    {
      id: "zai/glm-5.3",
      providerId: "prv_aaaaaaaaaaaa",
      upstreamId: "glm-5.3",
      displayName: "GLM 5.3",
      contextWindow: 1_000_000,
      maxOutputTokens: 32_000,
      pricing: {
        inputPerMTok: 0.1,
        outputPerMTok: 0.3,
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
      },
      modalities: ["text"],
      supports: { tools: true, streaming: true, vision: false, caching: null },
      source: "synced",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  cards: [],
};

// Minimal rows; ProjectSchema's defaults fill the rest on parse. One live and
// one archived, so the picker's filtering is observable rather than vacuous.
const PROJECTS = {
  projects: [
    { id: "proj_aaaaaaaaaaaa", slug: "my-proj", name: "My Project", createdAt: 1, updatedAt: 1 },
    {
      id: "proj_bbbbbbbbbbbb",
      slug: "old-proj",
      name: "Old Project",
      archived: true,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
};

/** Route the three URLs this panel touches; default to an empty registry. */
function stubFetch(runResponse: Response): ReturnType<typeof vi.fn> {
  return vi.fn((url: string) => {
    if (url === "/internal/run") return Promise.resolve(runResponse);
    if (url.startsWith("/internal/projects")) return Promise.resolve(json(PROJECTS));
    return Promise.resolve(json(REGISTRY));
  });
}

const open = () => fireEvent.click(screen.getByRole("button", { name: "start a task" }));

afterEach(cleanup);

describe("RunPanel", () => {
  it("will not start on an empty prompt", async () => {
    const fetchImpl = stubFetch(json(ACCEPTED, 202));
    vi.stubGlobal("fetch", fetchImpl);
    render(<RunPanel />);
    open();

    // Disabled, not merely validated on click: an unbounded fan-out started by
    // a stray click on an empty box is the failure this guards.
    expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(true);
  });

  it("starts the task and names the model that ended up leading", async () => {
    const fetchImpl = stubFetch(json(ACCEPTED, 202));
    vi.stubGlobal("fetch", fetchImpl);
    render(<RunPanel />);
    open();

    fireEvent.change(screen.getByLabelText("task"), {
      target: { value: "compare these three things" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(screen.getByText(/started/)).toBeTruthy();
    });
    // The initiator, not the prompt: the tree below shows the title already.
    expect(screen.getByText(/anthropic\/claude-opus-5/)).toBeTruthy();
  });

  it("clears the prompt but keeps the settings, for the next wording of the same run", async () => {
    const fetchImpl = stubFetch(json(ACCEPTED, 202));
    vi.stubGlobal("fetch", fetchImpl);
    render(<RunPanel />);
    open();

    fireEvent.change(screen.getByLabelText("budget"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("task"), { target: { value: "do it" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(screen.getByText(/started/)).toBeTruthy());
    expect((screen.getByLabelText("task") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText("budget") as HTMLInputElement).value).toBe("5");
  });

  it("catches a bad budget without sending anything", async () => {
    const fetchImpl = stubFetch(json(ACCEPTED, 202));
    vi.stubGlobal("fetch", fetchImpl);
    render(<RunPanel />);
    open();

    fireEvent.change(screen.getByLabelText("task"), { target: { value: "do it" } });
    fireEvent.change(screen.getByLabelText("budget"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(screen.getByText(/must be positive/)).toBeTruthy());
    // The registry call may have happened; the run must not have.
    expect(fetchImpl.mock.calls.every(([url]) => url !== "/internal/run")).toBe(true);
  });

  it("shows the daemon's refusal verbatim", async () => {
    const message = "anthropic/claude-opus-5 is a single model — use the chat tester";
    const fetchImpl = stubFetch(json({ error: { message } }, 400));
    vi.stubGlobal("fetch", fetchImpl);
    render(<RunPanel />);
    open();

    fireEvent.change(screen.getByLabelText("task"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
  });

  it("sends the pinned initiator chosen in the dropdown", async () => {
    const fetchImpl = stubFetch(json({ ...ACCEPTED, initiatorModelId: "zai/glm-5.3" }, 202));
    vi.stubGlobal("fetch", fetchImpl);
    render(<RunPanel />);
    open();

    // The dropdown fills from the registry, so wait for the option to exist.
    await waitFor(() => expect(screen.getByRole("option", { name: "zai/glm-5.3" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("initiator"), { target: { value: "zai/glm-5.3" } });
    fireEvent.change(screen.getByLabelText("task"), {
      target: { value: "lead with the cheap one" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(screen.getByText(/started/)).toBeTruthy());
    const call = fetchImpl.mock.calls.find(([url]) => url === "/internal/run");
    const body = JSON.parse((call?.[1] as RequestInit).body as string) as { model: string };
    expect(body.model).toBe("auto/orchestrator:zai/glm-5.3");
  });

  it("sends the chosen project as an @suffix, and hides archived ones from the picker", async () => {
    const fetchImpl = stubFetch(json(ACCEPTED, 202));
    vi.stubGlobal("fetch", fetchImpl);
    render(<RunPanel />);
    open();

    await waitFor(() => expect(screen.getByRole("option", { name: "my-proj" })).toBeTruthy());
    // Archived projects refuse a run with a 400, so offering one would be
    // offering an error.
    expect(screen.queryByRole("option", { name: "old-proj" })).toBeNull();

    fireEvent.change(screen.getByLabelText("project"), { target: { value: "my-proj" } });
    fireEvent.change(screen.getByLabelText("task"), { target: { value: "run under the project" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(screen.getByText(/started/)).toBeTruthy());
    const call = fetchImpl.mock.calls.find(([url]) => url === "/internal/run");
    const body = JSON.parse((call?.[1] as RequestInit).body as string) as { model: string };
    expect(body.model).toBe("auto/orchestrator@my-proj");
  });

  it("still starts tasks when the model list will not load", async () => {
    // The pin is optional and the common case is no pin at all, so a registry
    // that is down must not take the form with it.
    const fetchImpl = vi.fn((url: string) =>
      url === "/internal/run"
        ? Promise.resolve(json(ACCEPTED, 202))
        : Promise.reject(new TypeError("failed to fetch")),
    );
    vi.stubGlobal("fetch", fetchImpl);
    render(<RunPanel />);
    open();

    fireEvent.change(screen.getByLabelText("task"), { target: { value: "do it anyway" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(screen.getByText(/started/)).toBeTruthy());
  });
});
