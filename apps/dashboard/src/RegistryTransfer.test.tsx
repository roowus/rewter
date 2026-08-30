/**
 * Pick, preview, apply — clicked.
 *
 * The parsing is tested in `transfer.test.ts` and the merge in the daemon, so
 * what is only visible here is the sequencing: that picking a file does not
 * write, that the numbers on screen always belong to the button underneath
 * them, and that a file the dashboard cannot read never reaches the daemon at
 * all. Those three are the whole reason this control has three steps instead of
 * one.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistryTransfer } from "./RegistryTransfer.js";

const NOW = 1_787_784_000_000; // 2026-08-26

const MODEL = {
  id: "anthropic/claude-sonnet-5",
  providerId: "prv_aaaaaaaaaaaa",
  upstreamId: "claude-sonnet-5",
  displayName: "Claude Sonnet 5",
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  modalities: ["text"],
  supports: { tools: true, streaming: true, vision: false, caching: true },
  source: "synced",
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

const BUNDLE = {
  version: 1,
  exportedAt: NOW,
  note: null,
  providers: [{ id: "prv_aaaaaaaaaaaa", name: "Anthropic", kind: "anthropic", baseUrl: null }],
  models: [MODEL],
  cards: [],
};

const report = (over: Record<string, unknown> = {}) => ({
  dryRun: true,
  onConflict: "skip",
  models: [{ id: MODEL.id, outcome: "added", reason: null }],
  cards: [],
  missingProviders: [],
  ...over,
});

/** happy-dom's `File.prototype.text` is not dependable; this is the two bits of
    a `File` that `readBundleFile` actually touches. */
const bundleFile = (name = "registry.json", text = JSON.stringify(BUNDLE)): File =>
  ({ name, text: async () => text }) as unknown as File;

/** Answers every call with JSON, and records what it was asked. */
const daemon = (...bodies: unknown[]) => {
  let i = 0;
  return vi.fn(async () => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
};

const pick = (file: File): void => {
  const input = screen.getByLabelText("registry bundle file");
  fireEvent.change(input, { target: { files: [file] } });
};

/** The POST bodies, in order, ignoring any GET. */
const posts = (fetchImpl: ReturnType<typeof daemon>): Array<Record<string, unknown>> =>
  (fetchImpl.mock.calls as unknown as Array<[string, RequestInit | undefined]>)
    .filter(([, init]) => init?.method === "POST")
    .map(([, init]) => JSON.parse(init?.body as string) as Record<string, unknown>);

afterEach(cleanup);

describe("RegistryTransfer", () => {
  it("previews a picked bundle without writing anything", async () => {
    const fetchImpl = daemon(report());
    render(
      <RegistryTransfer onImported={vi.fn()} fetchImpl={fetchImpl as unknown as typeof fetch} />,
    );

    pick(bundleFile());

    await screen.findByRole("alertdialog");
    expect(posts(fetchImpl)).toEqual([{ bundle: BUNDLE, onConflict: "skip", dryRun: true }]);
  });

  it("says what the import would do, in the bundle's own numbers", async () => {
    const fetchImpl = daemon(report());
    render(
      <RegistryTransfer onImported={vi.fn()} fetchImpl={fetchImpl as unknown as typeof fetch} />,
    );

    pick(bundleFile());

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("1 models and 0 cards");
    expect(dialog.textContent).toContain("1 added");
    // The promise that makes the button safe to press.
    expect(dialog.textContent).toContain("Nothing already here is deleted");
  });

  it("names a provider this machine does not have, and what to do about it", async () => {
    // The one failure with a fix. A wall of `no_provider` rows is not it.
    const fetchImpl = daemon(
      report({
        models: [{ id: MODEL.id, outcome: "no_provider", reason: "provider not configured" }],
        missingProviders: [{ id: "prv_aaaaaaaaaaaa", name: "OpenRouter", modelCount: 14 }],
      }),
    );
    render(
      <RegistryTransfer onImported={vi.fn()} fetchImpl={fetchImpl as unknown as typeof fetch} />,
    );

    pick(bundleFile());

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("OpenRouter is not configured here — 14 models skipped");
    expect(dialog.textContent).toContain("Add the provider and import again");
  });

  it("re-previews when the conflict mode changes, rather than importing", async () => {
    // The counts under the button have to describe the button. Applying here
    // would write a merge the user has not been shown.
    const fetchImpl = daemon(report());
    render(
      <RegistryTransfer onImported={vi.fn()} fetchImpl={fetchImpl as unknown as typeof fetch} />,
    );

    pick(bundleFile());
    await screen.findByRole("alertdialog");

    fireEvent.change(screen.getByLabelText("what to do about models already here"), {
      target: { value: "overwrite" },
    });

    await waitFor(() => expect(posts(fetchImpl)).toHaveLength(2));
    expect(posts(fetchImpl)[1]).toMatchObject({ onConflict: "overwrite", dryRun: true });
  });

  it("writes only on the second, explicit press — with the mode that was previewed", async () => {
    const onImported = vi.fn();
    const fetchImpl = daemon(report(), report({ dryRun: false }));
    render(
      <RegistryTransfer onImported={onImported} fetchImpl={fetchImpl as unknown as typeof fetch} />,
    );

    pick(bundleFile());
    fireEvent.click(await screen.findByText("import"));

    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(posts(fetchImpl)[1]).toMatchObject({ onConflict: "skip", dryRun: false });
    expect((await screen.findByText(/Imported/)).textContent).toContain("1 added");
  });

  it("cancels back to the buttons without writing", async () => {
    const fetchImpl = daemon(report());
    render(
      <RegistryTransfer onImported={vi.fn()} fetchImpl={fetchImpl as unknown as typeof fetch} />,
    );

    pick(bundleFile());
    fireEvent.click(await screen.findByText("cancel"));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(posts(fetchImpl).filter((b) => b.dryRun === false)).toEqual([]);
    expect(screen.getByText("import bundle…")).toBeDefined();
  });

  it("never posts a file it could not read, and says which file", async () => {
    // The whole point of parsing client-side: the daemon would have said the
    // same thing, one round-trip later and without the filename.
    const fetchImpl = daemon(report());
    render(
      <RegistryTransfer onImported={vi.fn()} fetchImpl={fetchImpl as unknown as typeof fetch} />,
    );

    pick(bundleFile("notes.txt", "not json at all"));

    await screen.findByText("notes.txt is not JSON");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("shows the daemon's complaint when the preview itself fails", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "database is locked" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    render(
      <RegistryTransfer onImported={vi.fn()} fetchImpl={fetchImpl as unknown as typeof fetch} />,
    );

    pick(bundleFile());

    await screen.findByText("database is locked");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
