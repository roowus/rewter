/**
 * The advice half of the shutdown payload.
 *
 * Pure, and tested here rather than through the route, because the claim it
 * makes is the one thing about Shutdown that is easy to get subtly wrong:
 * "nothing will restart this" has to stay true against the plist that
 * `install-service` actually writes, and the two live in different packages.
 */
import { describe, expect, it } from "vitest";
import { ShutdownResultSchema, restartAdvice } from "./shutdown.js";

const LABEL = "com.roowus.rewter";

describe("restartAdvice", () => {
  it("promises no automatic restart under launchd, and names the command", () => {
    // Not an oversight: the generated plist sets KeepAlive to
    // { SuccessfulExit: false } precisely so that `rewter stop` is not undone a
    // second later. `kickstart`, not the deprecated `launchctl start`.
    expect(restartAdvice("launchd", LABEL)).toEqual({
      willRestart: false,
      restartWith: `launchctl kickstart gui/$(id -u)/${LABEL}`,
    });
  });

  it("sends a hand-started daemon back to `rewter start`", () => {
    expect(restartAdvice("standalone", LABEL)).toEqual({
      willRestart: false,
      restartWith: "rewter start",
    });
  });

  it("answers null — not false — when the supervisor is unrecognised", () => {
    // A container or a third-party manager may bring it straight back. Saying
    // "nothing will restart this" there would be a guess printed as a fact.
    expect(restartAdvice("unknown", LABEL)).toEqual({
      willRestart: null,
      restartWith: "rewter start",
    });
  });
});

describe("ShutdownResultSchema", () => {
  it("accepts a null willRestart and rejects an absent one", () => {
    const base = {
      ok: true as const,
      pid: 1234,
      supervisor: "unknown" as const,
      restartWith: "rewter start",
    };
    expect(ShutdownResultSchema.parse({ ...base, willRestart: null }).willRestart).toBeNull();
    // Nullable, not optional: a client reading `undefined` cannot tell a daemon
    // that declined to guess from one too old to have been asked.
    expect(ShutdownResultSchema.safeParse(base).success).toBe(false);
  });

  it("refuses a result that is not ok — there is no failure shape here", () => {
    // A shutdown that could not start is a status code (501), not an `ok:false`
    // body: the route has nothing partial to report.
    expect(
      ShutdownResultSchema.safeParse({
        ok: false,
        pid: 1,
        supervisor: "launchd",
        willRestart: false,
        restartWith: "x",
      }).success,
    ).toBe(false);
  });
});
