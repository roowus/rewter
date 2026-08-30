/**
 * Taking the registry off this machine, and putting one back.
 *
 * The registry is the part of rewter a person actually *works on* — prices
 * corrected by hand, models no catalog lists, capability cards argued with —
 * and until this file existed the only way to have it on a second machine was
 * to do all of that again. Everything here is a thin client over two routes;
 * the interesting decisions live in `@rewter/shared`'s `transfer.ts`, which is
 * also what the daemon runs, so a preview here and a write there cannot drift.
 *
 * Two things are deliberate:
 *
 * **The file is parsed before it is sent.** A bundle from the wrong version, or
 * a JSON file that was never a bundle at all, is caught here with the field
 * named — rather than being posted so the daemon can say the same thing one
 * round-trip later. The daemon still validates; this is not a substitute for
 * that, it is the difference between "line 3 of the file you picked" and "400".
 *
 * **Download is a data URL, not `createObjectURL`.** An object URL is a
 * resource with a lifetime, and revoking it correctly across a click handler
 * that may never fire is more machinery than a registry-sized JSON file earns.
 */
import {
  REGISTRY_BUNDLE_VERSION,
  type RegistryBundle,
  RegistryBundleSchema,
  type RegistryImportReport,
  RegistryImportReportSchema,
} from "@rewter/shared";
import { type Result, request } from "./registry.js";

/**
 * Ask the daemon for its registry as a bundle.
 *
 * Parsed on arrival like everything else in this dashboard: a bundle that does
 * not satisfy the schema is a daemon of a different version, and saving it to
 * disk anyway would produce a file that fails on import instead of failing
 * here, where the daemon is still around to be asked about.
 */
export function exportRegistry(
  note: string | null = null,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Result<RegistryBundle>> {
  const query = note === null || note.trim() === "" ? "" : `?note=${encodeURIComponent(note)}`;
  return request(
    `/internal/registry/export${query}`,
    signal === undefined ? {} : { signal },
    RegistryBundleSchema,
    fetchImpl,
  );
}

export interface ImportOptions {
  onConflict: "skip" | "overwrite";
  dryRun: boolean;
}

/**
 * Send a bundle to be merged.
 *
 * `dryRun` runs the identical planner and writes nothing, so the preview the
 * user confirms is the same set of decisions the write will make — not a
 * separate estimate of them.
 */
export function importRegistry(
  bundle: RegistryBundle,
  opts: ImportOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<RegistryImportReport>> {
  return request(
    "/internal/registry/import",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle, ...opts }),
    },
    RegistryImportReportSchema,
    fetchImpl,
  );
}

/**
 * A picked file, turned into a bundle or into a sentence about why it is not one.
 *
 * The version check is spelled out rather than left to zod's `z.literal`
 * message, because "Invalid literal value, expected 1" is a true thing to say
 * about a file the user believes is a rewter export, and "made by a newer
 * rewter" is a useful one.
 */
export async function readBundleFile(file: File): Promise<Result<RegistryBundle>> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, message: `could not read ${file.name}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: `${file.name} is not JSON` };
  }

  const version = (raw as { version?: unknown } | null)?.version;
  if (typeof version === "number" && version !== REGISTRY_BUNDLE_VERSION) {
    return {
      ok: false,
      message:
        version > REGISTRY_BUNDLE_VERSION
          ? `${file.name} was made by a newer rewter (bundle v${version}, this one reads v${REGISTRY_BUNDLE_VERSION})`
          : `${file.name} is a v${version} bundle; this rewter reads v${REGISTRY_BUNDLE_VERSION}`,
    };
  }

  const parsed = RegistryBundleSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined ? "" : ` (${first.path.join(".")}: ${first.message})`;
    return { ok: false, message: `${file.name} is not a rewter registry bundle${where}` };
  }
  return { ok: true, value: parsed.data };
}

/** `rewter-registry-2026-08-30.json` — dated, because these accumulate. */
export function bundleFilename(bundle: RegistryBundle): string {
  const day = new Date(bundle.exportedAt).toISOString().slice(0, 10);
  return `rewter-registry-${day}.json`;
}

/**
 * Hand the bundle to the browser as a download.
 *
 * Takes its `document` so a test can watch the anchor rather than the file
 * system. Pretty-printed with two spaces: a bundle is a file a person opens in
 * a year to see what a price used to be, and one long line is not that.
 */
export function saveBundle(bundle: RegistryBundle, doc: Document = document): void {
  const anchor = doc.createElement("a");
  anchor.href = `data:application/json;charset=utf-8,${encodeURIComponent(
    JSON.stringify(bundle, null, 2),
  )}`;
  anchor.download = bundleFilename(bundle);
  // Appended because Firefox ignores a click on an anchor that is not in the
  // document, and removed immediately because it is a mechanism, not content.
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
