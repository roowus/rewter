/**
 * Reading approval decisions out of an ordinary chat reply.
 *
 * The dashboard has buttons; a client talking to `/v1/chat/completions` has
 * only the conversation, so "approve apr_x" typed as the next user turn has to
 * mean the same thing as clicking. That makes a steering message two things at
 * once — some of it may be commands, the rest is a note for the initiator — and
 * this module is the split, kept away from both the HTTP layer and the engine so
 * it can be tested as pure text in and structure out.
 *
 * The parse is deliberately **conservative**. Swallowing a line is not free: a
 * consumed line never reaches the initiator, so "approve the plan and carry on"
 * being read as a command would silently drop real instruction. A line is a
 * command only if it is `approve`/`deny` (or the one-letter `a`/`d`) followed by
 * approval ids, worker labels (`w1`), or the literal word `all`, and nothing
 * else. Everything it is unsure about stays steering.
 *
 * Worker labels are the TUI's keystroke form (`a w1` / `d w1 reason`) — the
 * feed names workers `w<n>`, and copying an `apr_…` id off a paused line is
 * what you do from a log, not from a live prompt. The parse still only
 * *names* the label; resolving it to a pending approval is the apply step's
 * job, because labels live on the running session, not in the text.
 */
import type { ApprovalId } from "@rewter/shared";

export interface ApprovalCommand {
  decision: "approve" | "deny";
  /**
   * `"all"` for the blanket form; otherwise the approval ids named on the line.
   * Empty when the line named worker labels instead — see `labels`.
   */
  ids: ApprovalId[] | "all";
  /**
   * Worker labels named on the line (`w1`, `w2`, …), lowercased. Empty when the
   * line named ids or `all`. The apply step looks each one up on the live
   * session; an unknown or already-settled label is a no-op, same as a stale id.
   */
  labels: string[];
  /** Free text after a `:` or `—` (or, for `d w1 reason`, after the label). */
  note: string | null;
  /** The line as typed, for echoing back what was understood. */
  source: string;
}

export interface ParsedSteering {
  commands: ApprovalCommand[];
  /** What is left for the initiator; empty when the whole message was commands. */
  remainder: string;
}

/** Matches the id format `newApprovalId` mints, and nothing looser. */
const APPROVAL_ID = /apr_[0-9a-z]{12}/gi;

/** The feed's worker names: `w1`, `w2`, … — a number, never a word. */
const WORKER_LABEL = /w[1-9][0-9]*/gi;

/**
 * `approve`/`deny`/`a`/`d`, then either `all`, a run of ids, or a run of worker
 * labels, then optionally a note.
 *
 * The id/label run is matched as a blob and re-scanned rather than being
 * enumerated here, because separators in the wild are "and", commas, or
 * nothing at all, and a regex that tried to spell them out would be the part
 * that breaks.
 *
 * Two shapes, one idea. The long verbs (`approve`/`deny`/`reject`) take a
 * note only after `:` / `—` / `-`, same as they always have, so
 * "approve the plan and carry on" stays leftover. The one-letter form is a
 * keystroke (`a w1` / `d w1 too dangerous`): a trailing space *is* the note
 * separator, because nobody types a colon on a live prompt. `a`/`d` are
 * whole-token only — the `$`/`^` anchors plus `\s+` after the letter keep
 * "and then" from matching.
 */
const LONG_COMMAND =
  /^\s*(approve|deny|reject)\s+(all|(?:[\s,]*(?:and\s+)?(?:apr_[0-9a-z]{12}|w[1-9][0-9]*))+)\s*(?:[:—-]\s*(.*))?$/i;
const SHORT_COMMAND =
  /^\s*([ad])\s+(all|(?:[\s,]*(?:and\s+)?(?:apr_[0-9a-z]{12}|w[1-9][0-9]*))+)\s*(.*)$/i;

/**
 * Split a user message into approval commands and leftover steering.
 *
 * Line by line, because the two genuinely mix: "approve apr_x" on one line and
 * "then move on to the tests" on the next is one message a person would expect
 * to do both things.
 */
export function parseSteering(message: string): ParsedSteering {
  const commands: ApprovalCommand[] = [];
  const leftover: string[] = [];

  for (const line of message.split("\n")) {
    const command = parseCommandLine(line);
    if (command === null) leftover.push(line);
    else commands.push(command);
  }

  return { commands, remainder: leftover.join("\n").trim() };
}

function parseCommandLine(line: string): ApprovalCommand | null {
  const m = LONG_COMMAND.exec(line) ?? SHORT_COMMAND.exec(line);
  if (m === null) return null;

  const verb = (m[1] ?? "").toLowerCase();
  const target = m[2] ?? "";
  const note = (m[3] ?? "").trim();
  // "reject" is accepted because people type it; it is not a third decision.
  // `a` is the keystroke for approve; everything else that matched is a deny.
  const decision = verb === "approve" || verb === "a" ? "approve" : "deny";

  if (target.toLowerCase() === "all") {
    return {
      decision,
      ids: "all",
      labels: [],
      note: note === "" ? null : note,
      source: line.trim(),
    };
  }

  // Lowercased on the way in: the ids we mint are lowercase, and a user copying
  // one out of a terminal that upcased it should still be understood. Labels
  // are the same — the engine stores `w1`, never `W1`.
  const ids = [...target.matchAll(APPROVAL_ID)].map((hit) => hit[0].toLowerCase() as ApprovalId);
  const labels = [...target.matchAll(WORKER_LABEL)].map((hit) => hit[0].toLowerCase());
  if (ids.length === 0 && labels.length === 0) return null;
  return {
    decision,
    ids,
    labels,
    note: note === "" ? null : note,
    source: line.trim(),
  };
}
