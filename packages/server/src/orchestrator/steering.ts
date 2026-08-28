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
 * command only if it is `approve`/`deny` followed by approval ids or the literal
 * word `all`, and nothing else. Everything it is unsure about stays steering.
 */
import type { ApprovalId } from "@rewter/shared";

export interface ApprovalCommand {
  decision: "approve" | "deny";
  /** `"all"` for the blanket form; otherwise the ids named on the line. */
  ids: ApprovalId[] | "all";
  /** Free text after a `:` or `—`, handed on as the resolution note. */
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

/**
 * `approve`/`deny`, then either `all` or a run of ids, then optionally a note.
 *
 * The id run is matched as a blob and re-scanned rather than being enumerated
 * here, because separators in the wild are "and", commas, or nothing at all,
 * and a regex that tried to spell them out would be the part that breaks.
 */
const COMMAND =
  /^\s*(approve|deny|reject)\s+(all|(?:[\s,]*(?:and\s+)?apr_[0-9a-z]{12})+)\s*(?:[:—-]\s*(.*))?$/i;

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
  const m = COMMAND.exec(line);
  if (m === null) return null;

  const verb = (m[1] ?? "").toLowerCase();
  const target = m[2] ?? "";
  const note = (m[3] ?? "").trim();
  // "reject" is accepted because people type it; it is not a third decision.
  const decision = verb === "approve" ? "approve" : "deny";

  if (target.toLowerCase() === "all") {
    return { decision, ids: "all", note: note === "" ? null : note, source: line.trim() };
  }

  // Lowercased on the way in: the ids we mint are lowercase, and a user copying
  // one out of a terminal that upcased it should still be understood.
  const ids = [...target.matchAll(APPROVAL_ID)].map((hit) => hit[0].toLowerCase() as ApprovalId);
  if (ids.length === 0) return null;
  return { decision, ids, note: note === "" ? null : note, source: line.trim() };
}
