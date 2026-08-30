/**
 * Which supervisor started this — the one input to the sentence the dashboard
 * prints after Shutdown.
 *
 * The failure this guards against is not a crash: it is a daemon someone
 * started in a terminal telling them to run `launchctl kickstart` on a service
 * that is not loaded, which does nothing and reads as the button having lied.
 */
import { describe, expect, it } from "vitest";
import { SERVICE_LABEL } from "./launchd.js";
import { detectSupervisor } from "./supervisor.js";

const darwin = { platform: "darwin" as NodeJS.Platform };

describe("detectSupervisor", () => {
  it("recognises rewter's own LaunchAgent by label", () => {
    expect(detectSupervisor({ ...darwin, env: { XPC_SERVICE_NAME: SERVICE_LABEL }, ppid: 1 })).toBe(
      "launchd",
    );
  });

  it("does not claim launchd for someone else's job", () => {
    // A rewter started by hand inside another launchd job inherits *that* job's
    // label. Answering "launchd" there would print a kickstart line naming a
    // service that is not rewter's.
    expect(
      detectSupervisor({ ...darwin, env: { XPC_SERVICE_NAME: "com.example.other" }, ppid: 1 }),
    ).toBe("unknown");
  });

  it("reads the shell placeholder as standalone", () => {
    // `0` is what a process under a login shell inherits — not an absent value,
    // which is why the check is an equality and not a presence test.
    expect(detectSupervisor({ ...darwin, env: { XPC_SERVICE_NAME: "0" }, ppid: 4242 })).toBe(
      "standalone",
    );
  });

  it("treats an unset variable under a real parent as standalone", () => {
    expect(detectSupervisor({ ...darwin, env: {}, ppid: 4242 })).toBe("standalone");
  });

  it("declines to guess when something adopted the process", () => {
    // ppid 1 with no label: reparented, or started by something that is not a
    // shell. Either way this process does not know what will bring it back.
    expect(detectSupervisor({ ...darwin, env: {}, ppid: 1 })).toBe("unknown");
  });

  it("has no launchd to be under off macOS", () => {
    const linux = { platform: "linux" as NodeJS.Platform };
    expect(
      detectSupervisor({ ...linux, env: { XPC_SERVICE_NAME: SERVICE_LABEL }, ppid: 4242 }),
    ).toBe("standalone");
    expect(detectSupervisor({ ...linux, env: {}, ppid: 1 })).toBe("unknown");
  });
});
