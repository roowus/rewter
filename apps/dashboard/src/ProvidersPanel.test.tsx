/**
 * The providers panel on screen.
 *
 * What is only provable here is the panel's honesty about what it knows:
 *
 * 1. Before anyone presses anything the summary is "none tested yet" — not a
 *    verdict inferred from `enabled`, which only records that a human has not
 *    switched the provider off.
 * 2. A verdict about an upstream (`refused`) and a failure of rewter itself
 *    (`ok: false` from the client) land in different places. Collapsing them
 *    would send someone to rotate a key because the daemon was down.
 * 3. "test enabled" tests the enabled ones. On a registry seeded from the full
 *    preset table the difference is seventy-five outbound requests.
 */
import type { Provider, ProviderTestResult } from "@rewter/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProvidersPanel } from "./ProvidersPanel.js";

const provider = (over: Record<string, unknown> = {}): Provider =>
  ({
    id: "prv_aaaaaaaaaaaa",
    name: "Anthropic",
    kind: "anthropic",
    baseUrl: null,
    apiKeyRef: "ANTHROPIC_API_KEY",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as Provider;

const verdict = (over: Record<string, unknown> = {}): ProviderTestResult =>
  ({
    providerId: "prv_aaaaaaaaaaaa",
    verdict: "ok",
    message: "reachable, 12 models listed",
    statusCode: null,
    models: 12,
    checkedAt: 1,
    ...over,
  }) as ProviderTestResult;

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Serves the provider list, and answers each probe from `onTest`. */
function stubFetch(options: {
  providers?: Provider[];
  onTest?: (id: string) => Response;
}): { tested: string[] } {
  const tested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if ((init?.method ?? "GET") === "GET")
        return ok({ providers: options.providers ?? [provider()] });
      // `/internal/providers/<id>/test`
      const id = href.split("/")[3] ?? "";
      tested.push(id);
      return options.onTest?.(id) ?? ok(verdict({ providerId: id }));
    }),
  );
  return { tested };
}

/** Opens the panel and waits for the first row. */
async function open(row = "Anthropic"): Promise<void> {
  render(<ProvidersPanel />);
  fireEvent.click(screen.getByRole("button", { name: "check providers" }));
  await screen.findByText(row);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProvidersPanel", () => {
  it("does not ask the daemon anything until it is opened", () => {
    const impl = vi.fn(async () => ok({ providers: [] }));
    vi.stubGlobal("fetch", impl);
    render(<ProvidersPanel />);
    expect(impl).not.toHaveBeenCalled();
  });

  it("says nothing has been tested rather than calling enabled providers ready", async () => {
    // The whole reason this panel exists: `enabled` is a switch a human set, not
    // evidence that the upstream would answer.
    stubFetch({});
    await open();
    expect(screen.getByText(/1 of 1 enabled · none tested yet/)).toBeTruthy();
  });

  it("shows the env var name, never a key", async () => {
    stubFetch({});
    await open();
    expect(screen.getByText("ANTHROPIC_API_KEY")).toBeTruthy();
  });

  it("says a keyless local runtime needs none, rather than leaving a gap", async () => {
    stubFetch({
      providers: [provider({ name: "9router", kind: "openai-compat", apiKeyRef: null })],
    });
    await open("9router");
    expect(screen.getByText("none needed")).toBeTruthy();
  });

  it("reports the catalog size when a provider answers", async () => {
    stubFetch({});
    await open();
    fireEvent.click(screen.getByRole("button", { name: "test" }));
    await screen.findByText("ok");
    expect(screen.getByText(/12 models/)).toBeTruthy();
  });

  it("counts verdicts once there are some", async () => {
    stubFetch({
      providers: [provider(), provider({ id: "prv_bbbbbbbbbbbb", name: "OpenAI" })],
      onTest: (id) =>
        ok(
          id === "prv_aaaaaaaaaaaa"
            ? verdict({ providerId: id })
            : verdict({ providerId: id, verdict: "no_key", models: null }),
        ),
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "test 2 enabled" }));
    // Triage order, not registry order: the actionable one reads first.
    await screen.findByText(/1 no key · 1 ok/);
  });

  it("keeps a refused key as a verdict, not as a panel error", async () => {
    // The daemon answered perfectly; the news is about the upstream. Putting it
    // on the error line would read as "rewter is broken".
    stubFetch({
      onTest: () =>
        ok(
          verdict({
            verdict: "refused",
            message: "anthropic rejected the key (401) — it is set, but wrong or revoked",
            statusCode: 401,
            models: null,
          }),
        ),
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "test" }));
    const cell = await screen.findByText("refused");
    expect(cell.getAttribute("title")).toContain("wrong or revoked");
  });

  it("puts a rewter-side failure on the error line instead", async () => {
    // The other half of the same rule: `ok: false` from the client means the
    // probe never happened, so there is no verdict to show in the row.
    stubFetch({ onTest: () => ok({ error: { message: "unknown provider: prv_x" } }, 404) });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "test" }));
    await screen.findByText("unknown provider: prv_x");
    expect(screen.queryByText("refused")).toBeNull();
  });

  it("tests the enabled providers and leaves the disabled one alone", async () => {
    const { tested } = stubFetch({
      providers: [provider(), provider({ id: "prv_bbbbbbbbbbbb", name: "Off", enabled: false })],
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "test 1 enabled" }));
    await waitFor(() => expect(tested).toEqual(["prv_aaaaaaaaaaaa"]));
  });

  it("says the button spends nothing, before it is pressed", async () => {
    stubFetch({});
    await open();
    expect(screen.getByText(/no tokens are spent/)).toBeTruthy();
  });

  it("keeps the rows on screen when a reload fails", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls > 1) throw new TypeError("fetch failed");
        return ok({ providers: [provider()] });
      }),
    );
    render(<ProvidersPanel />);
    fireEvent.click(screen.getByRole("button", { name: "check providers" }));
    await screen.findByText("Anthropic");

    fireEvent.click(screen.getByRole("button", { name: "hide" }));
    fireEvent.click(screen.getByRole("button", { name: "check providers" }));
    await screen.findByText("daemon unreachable");
    expect(screen.getByText("Anthropic")).toBeTruthy();
  });
});
