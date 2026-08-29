import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOG_DIR,
  SERVICE_LABEL,
  installService,
  renderPlist,
  uninstallService,
} from "./launchd.js";

let dir: string;
let plistPath: string;
let logDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewter-launchd-"));
  plistPath = join(dir, "LaunchAgents", `${SERVICE_LABEL}.plist`);
  logDir = join(dir, "Logs", "rewter");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function opts(extra: Record<string, unknown> = {}) {
  return {
    nodePath: "/opt/homebrew/bin/node",
    cliPath: "/Users/x/projects/rewter/packages/cli/dist/index.js",
    logDir,
    plistPath,
    ...extra,
  };
}

describe("renderPlist", () => {
  it("runs `rewter start` with an absolute node — there is no PATH under launchd", () => {
    const xml = renderPlist(opts());
    expect(xml).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(xml).toContain("<string>/Users/x/projects/rewter/packages/cli/dist/index.js</string>");
    expect(xml).toContain("<string>start</string>");
  });

  it("carries no EnvironmentVariables — `launchctl print` reads this file back", () => {
    // Keys live in ~/.rewter/env, whose mode rewter can check. This is the
    // single most important assertion in the file.
    const xml = renderPlist(opts());
    expect(xml).not.toContain("EnvironmentVariables");
    expect(xml).not.toContain("API_KEY");
  });

  it("restarts a crash but not a clean exit", () => {
    // KeepAlive true would resurrect the daemon a second after `rewter stop`,
    // making `stop` look broken.
    const xml = renderPlist(opts());
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<key>SuccessfulExit</key>");
    expect(xml).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(xml).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it("throttles restarts so a config error is a slow retry, not a spin", () => {
    expect(renderPlist(opts())).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  });

  it("starts at login and points both streams into the log directory", () => {
    const xml = renderPlist(opts());
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(xml).toContain(`<string>${join(logDir, "rewter.log")}</string>`);
    expect(xml).toContain(`<string>${join(logDir, "rewter.err.log")}</string>`);
  });

  it("passes --config through only when one was given", () => {
    expect(renderPlist(opts())).not.toContain("--config");
    const pinned = renderPlist(opts({ configPath: "/Users/x/.rewter/other.json" }));
    expect(pinned).toContain("<string>--config</string>");
    expect(pinned).toContain("<string>/Users/x/.rewter/other.json</string>");
  });

  it("escapes XML metacharacters in paths", () => {
    // `~/projects/a & b/` is a legal directory name and an illegal plist.
    const xml = renderPlist(opts({ cliPath: "/Users/x/a & b/<cli>.js" }));
    expect(xml).toContain("/Users/x/a &amp; b/&lt;cli&gt;.js");
    expect(xml).not.toContain("a & b");
  });

  it("uses the reverse-DNS label every other LaunchAgent uses", () => {
    expect(SERVICE_LABEL).toBe("com.roowus.rewter");
    expect(renderPlist(opts())).toContain(`<string>${SERVICE_LABEL}</string>`);
  });

  it("names the log directory under ~/Library/Logs", () => {
    expect(LOG_DIR).toBe("~/Library/Logs/rewter");
  });
});

describe("installService", () => {
  it("writes the plist and the log directory launchd will not create", () => {
    // A StandardOutPath launchd cannot open makes the job fail with nowhere to
    // say so — the worst possible failure mode for a login daemon.
    const result = installService(opts());

    expect(result.action).toBe("written");
    expect(readFileSync(plistPath, "utf8")).toBe(result.contents);
    expect(existsSync(logDir)).toBe(true);
  });

  it("tells the user the launchctl lines rather than running them", () => {
    const { next } = installService(opts());
    expect(next[0]).toContain("bootout");
    expect(next[1]).toContain("bootstrap");
    // bootout first, because bootstrap on a loaded label fails with a bare code.
    expect(next[0]).toContain("|| true");
    expect(next[1]).toContain(plistPath);
  });

  it("writes nothing on a dry run", () => {
    const result = installService(opts({ dryRun: true }));
    expect(result.action).toBe("dry-run");
    expect(result.contents).toContain(SERVICE_LABEL);
    expect(existsSync(plistPath)).toBe(false);
  });

  it("refuses to clobber a hand-edited plist", () => {
    installService(opts());
    writeFileSync(plistPath, "<!-- I added an EnvironmentVariables key -->");

    const result = installService(opts());

    expect(result.action).toBe("exists");
    expect(readFileSync(plistPath, "utf8")).toContain("I added an");
  });

  it("replaces it with --force", () => {
    installService(opts());
    writeFileSync(plistPath, "<!-- mine -->");

    const result = installService(opts({ force: true }));

    expect(result.action).toBe("replaced");
    expect(readFileSync(plistPath, "utf8")).toContain(SERVICE_LABEL);
  });

  it("is quiet when re-run after an upgrade changed nothing", () => {
    installService(opts());
    expect(installService(opts()).action).toBe("unchanged");
  });
});

describe("uninstallService", () => {
  it("removes the plist and says how to unload it", () => {
    installService(opts());

    const result = uninstallService(plistPath);

    expect(result.removed).toBe(true);
    expect(existsSync(plistPath)).toBe(false);
    expect(result.next[0]).toContain("bootout");
  });

  it("is a no-op when there was nothing installed", () => {
    const result = uninstallService(plistPath);
    expect(result.removed).toBe(false);
    expect(result.next).toEqual([]);
  });
});
