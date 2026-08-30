/**
 * The translation panel.
 *
 * What is only provable here, at the seam of fetch and render: that the three
 * panes show the three stages; that a model which does not resolve still gets
 * two real panes plus the daemon's reason for the missing third, rather than a
 * blank; that a half-typed brace does not blank the panes it is being typed
 * into; that the Test button sends the model from the box and prints what it
 * billed; and that an unpriced answer says so instead of claiming `$0`.
 *
 * The one thing worth stating about the harness: describing is debounced, so
 * these tests run on fake timers and step the clock. A test that waits on wall
 * time here would be a test that is slow when it passes and flaky when it does
 * not.
 */
import type { TranslateResponse } from "@rewter/shared";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranslatePanel } from "./TranslatePanel.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const NORMALIZED = {
  model: "openai/gpt-5",
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "hello" },
  ],
  maxTokens: 100,
};

const described = (over: Partial<TranslateResponse> = {}): TranslateResponse =>
  ({
    dialect: "openai",
    normalized: NORMALIZED,
    resolution: {
      modelId: "openai/gpt-5",
      providerId: "prv_openai",
      providerName: "OpenAI",
      providerKind: "openai-compat",
      upstreamId: "gpt-5",
      baseUrl: "https://api.openai.com/v1",
    },
    upstream: {
      kind: "openai-compat",
      path: "/chat/completions",
      // The quirk this panel exists to make visible: the field the client set
      // is not the field the upstream is handed.
      body: { model: "gpt-5", max_completion_tokens: 100 },
    },
    note: null,
    ...over,
  }) as TranslateResponse;

const TEST_RESULT = {
  modelId: "openai/gpt-5",
  text: "Hello there.",
  finishReason: "stop",
  usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costUsd: 0.000_096,
  latencyMs: 840,
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Open the panel and let the debounced describe fire. */
async function open() {
  render(<TranslatePanel />);
  screen.getByRole("button", { name: "inspect a request" }).click();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
}

describe("TranslatePanel", () => {
  it("stays shut, and sends nothing, until asked", async () => {
    const fetchImpl = vi.fn(async () => json(described()));
    vi.stubGlobal("fetch", fetchImpl);

    render(<TranslatePanel />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("as sent")).toBeNull();
  });

  it("shows the three stages, including the field the quirk renamed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(described())),
    );
    await open();

    // Stage one is what the user typed; stages two and three are the answer.
    expect((screen.getByLabelText("as sent") as HTMLTextAreaElement).value).toContain(
      '"max_tokens": 100',
    );
    const panes = document.querySelectorAll(".translate-pane pre");
    expect(panes[0]?.textContent).toContain('"maxTokens": 100');
    expect(panes[1]?.textContent).toContain('"max_completion_tokens": 100');
    // Where it would have gone, base URL and path joined.
    expect(document.querySelector(".translate-target")?.textContent).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("names the provider the request resolved to", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(described())),
    );
    await open();

    await screen.findByText(/OpenAI · openai-compat/);
  });

  /**
   * A model that does not resolve is the common case for this panel — it is
   * often *why* someone opened it. The first two panes are still real answers,
   * so they stay, and the third says why it is missing.
   */
  it("keeps the first two panes when there is no upstream, and says why", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(described({ resolution: null, upstream: null, note: "no such model: openai/gpt-5" })),
      ),
    );
    await open();

    await screen.findByText("no such model: openai/gpt-5");
    // Stage two survived the missing stage three.
    expect(document.querySelector(".translate-pane pre")?.textContent).toContain(
      '"maxTokens": 100',
    );
  });

  it("switching dialect swaps in that dialect's sample and re-describes it", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return json(described());
      }),
    );
    await open();

    screen.getByRole("tab", { name: "Anthropic" }).click();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    const last = bodies.at(-1) as { dialect: string; body: Record<string, unknown> };
    expect(last.dialect).toBe("anthropic");
    // The Anthropic sample, whose system prompt is a top-level parameter rather
    // than a message — which is the difference the toggle exists to show.
    expect(last.body.system).toBe("be brief");
  });

  it("an unbalanced brace reports itself without blanking the panes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(described())),
    );
    await open();
    await waitFor(() => expect(document.querySelector(".translate-pane pre")).not.toBeNull());

    const box = screen.getByLabelText("as sent") as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, '{"a"');
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    await screen.findByText(/^invalid JSON: /);
    // The last good render is still on screen — otherwise the panel is
    // unusable to type into.
    expect(document.querySelector(".translate-pane pre")?.textContent).toContain(
      '"maxTokens": 100',
    );
  });

  it("Test sends the model from the box and prints what it billed", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push({ url: String(url), body });
        return json(String(url).endsWith("chat-test") ? TEST_RESULT : described());
      }),
    );
    await open();

    screen.getByRole("button", { name: /^Test/ }).click();
    await screen.findByText("Hello there.");

    const test = calls.find((c) => c.url.endsWith("/internal/chat-test"));
    expect(test?.body).toMatchObject({ model: "openai/gpt-5" });
    // Usage and cost together: a tester that hides the bill is one people use
    // once and then distrust.
    const meta = document.querySelector(".translate-result .dim")?.textContent ?? "";
    expect(meta).toContain("12 → 4 tok");
    expect(meta).toContain("840ms");
    expect(meta).toContain("$0.0001");
  });

  it("an unpriced model reads 'unpriced', never '$0.00'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) =>
        json(String(url).endsWith("chat-test") ? { ...TEST_RESULT, costUsd: null } : described()),
      ),
    );
    await open();

    screen.getByRole("button", { name: /^Test/ }).click();
    await screen.findByText("Hello there.");

    const meta = document.querySelector(".translate-result .dim")?.textContent ?? "";
    expect(meta).toContain("unpriced");
    expect(meta).not.toContain("$");
  });

  it("a refused test shows the upstream's sentence and no answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) =>
        String(url).endsWith("chat-test")
          ? json({ error: { message: "invalid x-api-key" } }, 401)
          : json(described()),
      ),
    );
    await open();

    screen.getByRole("button", { name: /^Test/ }).click();
    await screen.findByText("invalid x-api-key");
    expect(document.querySelector(".translate-result")).toBeNull();
  });
});
