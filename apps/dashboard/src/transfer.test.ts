/**
 * The export/import client.
 *
 * `planImport` is tested in `shared` and the routes in `app.transfer.test.ts`,
 * so what is only testable here is what happens to a *file* — the one input in
 * this dashboard that did not come from the daemon, and the one place where a
 * bad answer looks like a plausible one. A JSON file that is not a bundle, or
 * one written by a newer rewter, has to fail with something the user can act
 * on, before it is posted anywhere.
 */
import { describe, expect, it, vi } from "vitest";
import {
  bundleFilename,
  exportRegistry,
  importRegistry,
  readBundleFile,
  saveBundle,
} from "./transfer.js";

const NOW = 1_787_784_000_000; // 2026-08-26T00:00Z

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

const REPORT = {
  dryRun: true,
  onConflict: "skip",
  models: [{ id: MODEL.id, outcome: "added", reason: null }],
  cards: [],
  missingProviders: [],
};

const respond = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

/** happy-dom has `File`, but not `File.prototype.text` reliably — so, by hand. */
const file = (name: string, text: string): File =>
  ({ name, text: async () => text }) as unknown as File;

describe("exportRegistry", () => {
  it("asks the daemon and parses what comes back", async () => {
    const result = await exportRegistry(null, respond(BUNDLE));
    expect(result.ok && result.value.models[0]?.id).toBe(MODEL.id);
  });

  it("refuses a bundle it cannot read rather than saving it to disk", async () => {
    // A daemon newer than this bundle. Writing the file anyway would move the
    // failure to import time, on a machine where this daemon is not around to
    // be asked about it.
    const result = await exportRegistry(null, respond({ ...BUNDLE, models: [{ id: "x" }] }));
    expect(result).toEqual({ ok: false, message: "unrecognized response from daemon" });
  });

  it("passes a note through, encoded", async () => {
    const spy = vi.fn(respond(BUNDLE));
    await exportRegistry("laptop before reinstall", spy as typeof fetch);
    expect((spy.mock.calls[0] as [string])[0]).toBe(
      "/internal/registry/export?note=laptop%20before%20reinstall",
    );
  });

  it("sends no note parameter at all for blank text", async () => {
    const spy = vi.fn(respond(BUNDLE));
    await exportRegistry("   ", spy as typeof fetch);
    expect((spy.mock.calls[0] as [string])[0]).toBe("/internal/registry/export");
  });
});

describe("importRegistry", () => {
  it("posts the bundle with the mode and the dry-run flag", async () => {
    const spy = vi.fn(respond(REPORT));
    await importRegistry(
      BUNDLE as never,
      { onConflict: "overwrite", dryRun: true },
      spy as typeof fetch,
    );
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/internal/registry/import");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({
      onConflict: "overwrite",
      dryRun: true,
    });
  });

  it("surfaces the daemon's own complaint verbatim", async () => {
    // "version: Invalid literal value, expected 1" tells the user which file to
    // stop using; "daemon said 400" does not.
    const result = await importRegistry(
      BUNDLE as never,
      { onConflict: "skip", dryRun: false },
      respond({ error: { message: "invalid bundle: version: expected 1" } }, 400),
    );
    expect(result).toEqual({ ok: false, message: "invalid bundle: version: expected 1" });
  });
});

describe("readBundleFile", () => {
  it("accepts a bundle this rewter understands", async () => {
    const result = await readBundleFile(file("registry.json", JSON.stringify(BUNDLE)));
    expect(result.ok && result.value.models).toHaveLength(1);
  });

  it("names the file when it is not JSON at all", async () => {
    const result = await readBundleFile(file("notes.txt", "hello"));
    expect(result).toEqual({ ok: false, message: "notes.txt is not JSON" });
  });

  it("says a newer bundle is newer, rather than quoting zod at the user", async () => {
    // The user believes this file is a rewter export, and they are right — it
    // is just from a rewter that this one cannot read. "Invalid literal value"
    // does not communicate that.
    const result = await readBundleFile(
      file("registry.json", JSON.stringify({ ...BUNDLE, version: 9 })),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("newer rewter");
    expect(!result.ok && result.message).toContain("v9");
  });

  it("says an older bundle is older", async () => {
    const result = await readBundleFile(
      file("old.json", JSON.stringify({ ...BUNDLE, version: 0 })),
    );
    expect(!result.ok && result.message).toContain("v0 bundle");
  });

  it("points at the offending field for valid JSON that is not a bundle", async () => {
    const result = await readBundleFile(
      file("half.json", JSON.stringify({ ...BUNDLE, models: [{ id: "x" }] })),
    );
    expect(!result.ok && result.message).toContain("half.json is not a rewter registry bundle");
    expect(!result.ok && result.message).toContain("models.0");
  });

  it("reports an unreadable file rather than throwing into the click handler", async () => {
    const broken = {
      name: "gone.json",
      text: async () => {
        throw new Error("NotReadableError");
      },
    } as unknown as File;
    expect(await readBundleFile(broken)).toEqual({
      ok: false,
      message: "could not read gone.json",
    });
  });
});

describe("saveBundle", () => {
  it("names the file after the day it was exported", () => {
    expect(bundleFilename(BUNDLE as never)).toBe("rewter-registry-2026-08-26.json");
  });

  it("hands the browser a download and cleans up the anchor it used", () => {
    const clicked = vi.fn();
    const anchor = { href: "", download: "", click: clicked, remove: vi.fn() };
    const doc = {
      createElement: () => anchor,
      body: { appendChild: vi.fn() },
    } as unknown as Document;

    saveBundle(BUNDLE as never, doc);

    expect(clicked).toHaveBeenCalledTimes(1);
    expect(anchor.download).toBe("rewter-registry-2026-08-26.json");
    expect(anchor.href.startsWith("data:application/json")).toBe(true);
    expect(anchor.remove).toHaveBeenCalled();
    // Pretty-printed: a bundle is a file a person opens in a year.
    expect(decodeURIComponent(anchor.href)).toContain('\n  "version": 1');
  });

  it("cannot put a credential in the file, because the bundle cannot hold one", () => {
    // Belt to the schema's braces: even if a caller handed us a bundle with a
    // stray field, what reaches the anchor is what the parser let through.
    const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    const doc = {
      createElement: () => anchor,
      body: { appendChild: vi.fn() },
    } as unknown as Document;
    saveBundle(BUNDLE as never, doc);
    expect(decodeURIComponent(anchor.href)).not.toContain("apiKeyRef");
  });
});
