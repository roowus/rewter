/**
 * Stopping the daemon from its own dashboard.
 *
 * The survey's verdict was "adopt Shutdown; think hard about Restart", and the
 * thinking lands on: there is no Restart button, because under rewter's launchd
 * agent there is nothing to restart *to*. The generated plist sets `KeepAlive`
 * to `{ SuccessfulExit: false }` — a crash comes back, a clean exit stays down —
 * precisely so that `rewter stop` is not silently undone a second later. A
 * dashboard button that said "Restart" would therefore be a button that stops
 * the daemon and then waits for something that is deliberately not coming.
 *
 * What the button owes the operator instead is the sentence that is true after
 * they press it. That is the whole of this payload: which supervisor this
 * process is under, whether anything will bring it back on its own (today,
 * nothing will — but the field is the claim, not a constant, so a future
 * unconditional KeepAlive changes the answer rather than the docs), and the
 * exact command that does. It is the same honesty the kill button's
 * `aborted: true|false` already gives: say which of the two things happened.
 *
 * The reply is sent *before* the process stops, which is the only order that
 * can work — a socket cannot deliver a body after the server closes it. So
 * `ok: true` means "this daemon accepted the request and is now draining", not
 * "the port is closed". The dashboard reports it that way.
 */
import { z } from "zod";

/**
 * Who started this process, as far as it can tell from its own environment.
 *
 * Nothing here changes *what* shutdown does — a clean exit is a clean exit —
 * only which command is printed for getting back. `unknown` is a real answer
 * and not a failure: on a non-macOS host there is no launchd to be under.
 */
export const SupervisorSchema = z.enum(["launchd", "standalone", "unknown"]);
export type Supervisor = z.infer<typeof SupervisorSchema>;

export const ShutdownResultSchema = z.object({
  /** Accepted and draining — not "already stopped". See the note above. */
  ok: z.literal(true),
  /** The process about to go. Worth echoing: it is what an operator would `ps`. */
  pid: z.number().int().positive(),
  supervisor: SupervisorSchema,
  /**
   * Whether anything is expected to start it again by itself.
   *
   * False under today's launchd plist, because the exit is clean and `KeepAlive`
   * is conditional. Stated as a fact about this daemon rather than left for the
   * reader to know, so that a UI never has to guess.
   *
   * `null` where the process genuinely cannot tell — an unrecognised supervisor
   * on a host with no launchd. A boolean there would be a guess printed as a
   * fact, which is the one thing this payload exists to avoid.
   */
  willRestart: z.boolean().nullable(),
  /** The command that brings it back — shown next to the confirmation. */
  restartWith: z.string().min(1),
});
export type ShutdownResult = z.infer<typeof ShutdownResultSchema>;

/**
 * What to tell someone who just stopped the daemon and wants it back.
 *
 * Lives here rather than in the route so that the two halves of the sentence —
 * "nothing will restart this" and "here is what does" — cannot disagree, and so
 * that the mapping is testable without a daemon. The service label is a
 * parameter because it belongs to the server's launchd module; passing it keeps
 * one definition of the string rather than a second copy that drifts.
 *
 * Under launchd the command is `kickstart` rather than `launchctl start`:
 * `start` on an agent that is loaded-but-not-running is the older spelling and
 * is deprecated, and `kickstart` says the same thing on every macOS that rewter
 * supports. Not `-k`: nothing is running to kill.
 */
export function restartAdvice(
  supervisor: Supervisor,
  serviceLabel: string,
): { willRestart: boolean | null; restartWith: string } {
  // Deliberately not `true` for launchd: the plist rewter generates sets
  // `KeepAlive` to `{ SuccessfulExit: false }`, so a clean exit — which this is
  // — stays down on purpose.
  if (supervisor === "launchd") {
    return {
      willRestart: false,
      restartWith: `launchctl kickstart gui/$(id -u)/${serviceLabel}`,
    };
  }
  // A daemon started by `rewter start` in a terminal has nothing above it, so
  // "nothing will restart this" is knowledge rather than a guess.
  if (supervisor === "standalone") return { willRestart: false, restartWith: "rewter start" };
  // Something started it that this process does not recognise — a container, a
  // process manager, someone else's plist. It may well come straight back; we
  // do not know, and `rewter start` is still the answer if it does not.
  return { willRestart: null, restartWith: "rewter start" };
}
