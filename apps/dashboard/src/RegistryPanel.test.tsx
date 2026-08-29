/**
 * The registry editor on screen.
 *
 * Three things are only provable here, and all three are about the promotion
 * rule reaching the user rather than staying an implementation detail:
 *
 * 1. A `synced` row says so, and warns *before* the save that correcting a fact
 *    takes the model off the sync path. A promotion nobody was told about is a
 *    model that quietly stops tracking its provider's prices.
 * 2. Toggling `enabled` sends `{enabled}` alone — never bundled with the facts,
 *    because that would promote the row for the sin of being switched off.
 * 3. `changed: false` is reported as "no change", not as "saved". The daemon
 *    compares by value; a form showing stale values gets that answer, and a
 *    user told "saved" walks away believing a price is fixed.
 */
import type { CapabilityCard, Model, Provider } from "@rewter/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistryPanel } from "./RegistryPanel.js";

// `Record<string, unknown>` rather than `Partial<Model>`: ids are branded, and
// a fixture spelling one out as a plain string is the readable thing here.
const model = (over: Record<string, unknown> = {}): Model =>
  ({
    id: "anthropic/claude-sonnet-5",
    providerId: "prv_aaaaaaaaaaaa",
    upstreamId: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    },
    modalities: ["text"],
    supports: { tools: true, streaming: true, vision: false, caching: true },
    source: "synced",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as Model;

const card = (over: Record<string, unknown> = {}): CapabilityCard =>
  ({
    modelId: "anthropic/claude-sonnet-5",
    summary: "strong generalist",
    strengths: ["coding"],
    weaknesses: [],
    bestAt: ["coding", "planning"],
    notes: null,
    userOverrides: null,
    generatedBy: null,
    generatedAt: null,
    updatedAt: 1,
    ...over,
  }) as unknown as CapabilityCard;

const provider = (): Provider =>
  ({
    id: "prv_aaaaaaaaaaaa",
    name: "Anthropic",
    kind: "anthropic",
    baseUrl: null,
    apiKeyRef: "ANTHROPIC_API_KEY",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }) as Provider;

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Routes the three GETs the panel makes, and records writes for assertions. */
function stubFetch(options: {
  models?: Model[];
  cards?: CapabilityCard[];
  onWrite?: (url: string, init: RequestInit) => Response;
}): { calls: Array<[string, RequestInit]> } {
  const calls: Array<[string, RequestInit]> = [];
  const impl = vi.fn(async (url: unknown, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    if (method === "GET") {
      if (href.startsWith("/internal/providers")) return ok({ providers: [provider()] });
      return ok({ models: options.models ?? [model()], cards: options.cards ?? [] });
    }
    calls.push([href, init ?? {}]);
    return options.onWrite?.(href, init ?? {}) ?? ok({ model: model(), changed: true });
  });
  vi.stubGlobal("fetch", impl);
  return { calls };
}

/** Opens the panel and waits for the named row to arrive. */
async function open(row = "claude-sonnet-5"): Promise<void> {
  render(<RegistryPanel />);
  fireEvent.click(screen.getByRole("button", { name: "edit models" }));
  await screen.findByText(row);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RegistryPanel", () => {
  it("does not ask the daemon anything until it is opened", () => {
    const impl = vi.fn(async () => ok({ models: [], cards: [] }));
    vi.stubGlobal("fetch", impl);
    render(<RegistryPanel />);
    expect(impl).not.toHaveBeenCalled();
  });

  it("shows the price, the context window and — the important one — the source", async () => {
    stubFetch({});
    await open();
    const row = screen.getByText("claude-sonnet-5").closest("tr");
    expect(row?.textContent).toContain("$3.00 / $15.00");
    expect(row?.textContent).toContain("200K");
    // `synced` means the next sync overwrites these numbers. Knowing that
    // before typing one in is the point.
    expect(row?.textContent).toContain("synced");
  });

  it("shows what a model is for beside what it costs", async () => {
    // One round-trip carries both because the card is the half that actually
    // steers the orchestrator.
    stubFetch({ cards: [card()] });
    await open();
    expect(screen.getByText("coding · planning")).toBeTruthy();
  });

  it("says a model is unpriced rather than showing it as free", async () => {
    // A local Ollama model costs nothing; one whose price we never learned is
    // a different fact, and $0 would read as the first.
    stubFetch({
      models: [
        model({
          id: "ollama/qwen3-coder",
          pricing: {
            inputPerMTok: null,
            outputPerMTok: null,
            cacheReadPerMTok: null,
            cacheWritePerMTok: null,
          },
        }),
      ],
    });
    await open("qwen3-coder");
    expect(screen.getByText("unpriced")).toBeTruthy();
  });

  it("warns that saving a fact takes a synced model off the sync path", async () => {
    stubFetch({});
    await open();
    fireEvent.click(screen.getByRole("button", { name: "edit" }));

    const input = screen.getByLabelText("$ in /MTok");
    fireEvent.change(input, { target: { value: "2.5" } });
    expect(screen.getByText(/off the sync path/)).toBeTruthy();
  });

  it("does not warn a model that is already manual", async () => {
    stubFetch({ models: [model({ source: "manual" })] });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.change(screen.getByLabelText("$ in /MTok"), { target: { value: "2.5" } });
    expect(screen.queryByText(/off the sync path/)).toBeNull();
  });

  it("sends only the edited fields, with pricing whole", async () => {
    const { calls } = stubFetch({});
    await open();
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.change(screen.getByLabelText("$ in /MTok"), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: /^save/ }));

    await waitFor(() => expect(calls.length).toBe(1));
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe("/internal/models/anthropic/claude-sonnet-5");
    // Pricing goes as a whole object — a partial price cannot half-apply — but
    // no other field rides along, so a rejection names the field that was wrong.
    expect(JSON.parse(String(init.body))).toEqual({
      pricing: {
        inputPerMTok: 2.5,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
      },
    });
  });

  it("says the model is now manual after a promoting save", async () => {
    stubFetch({
      onWrite: () => ok({ model: model({ source: "manual" }), changed: true }),
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.change(screen.getByLabelText("$ in /MTok"), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: /^save/ }));
    await screen.findByText(/now manual and sync will leave it alone/);
  });

  it("reports a no-op save as no change, not as saved", async () => {
    stubFetch({ onWrite: () => ok({ model: model(), changed: false }) });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.change(screen.getByLabelText("display name"), { target: { value: "Other" } });
    fireEvent.click(screen.getByRole("button", { name: /^save/ }));
    await screen.findByText(/no change/);
  });

  it("sends enabled on its own, never bundled with the facts", async () => {
    // Bundled, it would promote the row: turning a model off would silently
    // take its prices off the sync path forever.
    const { calls } = stubFetch({});
    await open();
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.change(screen.getByLabelText("$ in /MTok"), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "disable" }));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(JSON.parse(String((calls[0] as [string, RequestInit])[1].body))).toEqual({
      enabled: false,
    });
  });

  it("shows the daemon's rejection verbatim", async () => {
    stubFetch({
      onWrite: () => ok({ error: { message: "pricing.inputPerMTok: must be >= 0" } }, 400),
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.change(screen.getByLabelText("$ in /MTok"), { target: { value: "-1" } });
    fireEvent.click(screen.getByRole("button", { name: /^save/ }));
    await screen.findByText("pricing.inputPerMTok: must be >= 0");
  });

  it("refuses a non-numeric price locally rather than clearing a real one", async () => {
    // An empty field means "we do not know this price". `abc` means a typo,
    // and sending it as null would silently delete a price that was correct.
    const { calls } = stubFetch({});
    await open();
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.change(screen.getByLabelText("$ in /MTok"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: /^save/ }));
    await screen.findByText(/inputPerMTok is not a number/);
    expect(calls.length).toBe(0);
  });

  it("needs a second click to delete a model and its card", async () => {
    const { calls } = stubFetch({ onWrite: () => ok({ deleted: "anthropic/claude-sonnet-5" }) });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "edit" }));

    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    expect(calls.length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: /really delete/ }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect((calls[0] as [string, RequestInit])[1].method).toBe("DELETE");
  });

  it("points at the card command when a model has none", async () => {
    stubFetch({ cards: [] });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    expect(screen.getByText(/rewter card anthropic\/claude-sonnet-5/)).toBeTruthy();
  });

  it("offers to clear overrides only when there are some", async () => {
    stubFetch({ cards: [card({ userOverrides: { summary: "hand written" } })] });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    expect(screen.getByText("has your overrides")).toBeTruthy();
    expect(screen.getByRole("button", { name: "clear overrides" })).toBeTruthy();
  });

  it("clears overrides with an explicit null", async () => {
    const { calls } = stubFetch({
      cards: [card({ userOverrides: { summary: "hand written" } })],
      onWrite: () => ok({ card: card() }),
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "clear overrides" }));

    await waitFor(() => expect(calls.length).toBe(1));
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe("/internal/card-overrides/anthropic/claude-sonnet-5");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ overrides: null });
  });

  it("creates a hand-typed model without offering to call it synced", async () => {
    // Offering `synced` would hand sync permission to overwrite a model
    // nothing upstream has ever heard of.
    const { calls } = stubFetch({
      onWrite: () => ok({ model: model({ id: "ollama/qwen3-coder", source: "manual" }) }, 201),
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "add a model by hand" }));
    expect(screen.queryByLabelText(/source/i)).toBeNull();

    fireEvent.change(screen.getByLabelText("id (provider/name)"), {
      target: { value: "ollama/qwen3-coder" },
    });
    fireEvent.change(screen.getByLabelText("provider"), { target: { value: "prv_aaaaaaaaaaaa" } });
    fireEvent.change(screen.getByLabelText("upstream id"), { target: { value: "qwen3-coder" } });
    fireEvent.change(screen.getByLabelText("display name"), { target: { value: "Qwen3 Coder" } });
    fireEvent.click(screen.getByRole("button", { name: "create" }));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(JSON.parse(String((calls[0] as [string, RequestInit])[1].body))).toEqual({
      id: "ollama/qwen3-coder",
      providerId: "prv_aaaaaaaaaaaa",
      upstreamId: "qwen3-coder",
      displayName: "Qwen3 Coder",
    });
  });

  it("keeps the rows on screen when a reload fails", async () => {
    // A registry that empties on a transient failure reads as "no models
    // configured", which is a very different problem.
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        calls += 1;
        if (calls > 2) throw new TypeError("fetch failed");
        if (String(url).startsWith("/internal/providers")) return ok({ providers: [provider()] });
        return ok({ models: [model()], cards: [] });
      }),
    );
    render(<RegistryPanel />);
    fireEvent.click(screen.getByRole("button", { name: "edit models" }));
    await screen.findByText("claude-sonnet-5");

    fireEvent.click(screen.getByRole("button", { name: "hide" }));
    fireEvent.click(screen.getByRole("button", { name: "edit models" }));
    await screen.findByText("daemon unreachable");
    expect(screen.getByText("claude-sonnet-5")).toBeTruthy();
  });
});
