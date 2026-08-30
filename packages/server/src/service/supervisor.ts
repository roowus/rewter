/**
 * Who started this process?
 *
 * Only one thing depends on the answer: the sentence the dashboard shows after
 * you press Shutdown. A daemon someone launched in a terminal comes back with
 * `rewter start`; one launched by the LaunchAgent comes back with `launchctl
 * kickstart`, and typing the wrong one at the wrong daemon does nothing visible
 * and looks like the button lied.
 *
 * launchd tells us, if indirectly. Every job it starts gets `XPC_SERVICE_NAME`
 * set to the job's label; a process descended from a login shell inherits the
 * placeholder `0` instead. So the check is an equality against rewter's own
 * label rather than "is this set" — a rewter started by hand *inside* some other
 * launchd job would otherwise claim to be the agent, and print a `kickstart`
 * line naming a service that is not running.
 *
 * Three outcomes, and `unknown` is a real one. A container, a third-party
 * process manager, someone's hand-written plist: rewter genuinely cannot tell
 * whether that will bring it back, and the payload says `null` rather than
 * guessing. Everything here reads an injected environment — there is nothing to
 * mock and no reason for a test to touch the real one.
 */
import type { Supervisor } from "@rewter/shared";
import { SERVICE_LABEL } from "./launchd.js";

export interface SupervisorProbe {
  env?: NodeJS.ProcessEnv;
  /** `process.ppid`. 1 means something adopted us — init, launchd, a supervisor. */
  ppid?: number;
  platform?: NodeJS.Platform;
}

export function detectSupervisor(probe: SupervisorProbe = {}): Supervisor {
  const env = probe.env ?? process.env;
  const ppid = probe.ppid ?? process.ppid;
  const platform = probe.platform ?? process.platform;

  if (platform === "darwin") {
    const xpc = env.XPC_SERVICE_NAME;
    if (xpc === SERVICE_LABEL) return "launchd";
    // `0` is what a process under a login shell inherits, and a shell is the
    // only other way rewter is started on a Mac. An unset value on a parent
    // that is not launchd means the same thing by a different route.
    if ((xpc === undefined || xpc === "0") && ppid !== 1) return "standalone";
    return "unknown";
  }

  // Elsewhere there is no launchd to be under, so the question collapses to
  // "did a shell start this". ppid 1 means something else did, and we do not
  // pretend to know what.
  return ppid === 1 ? "unknown" : "standalone";
}
