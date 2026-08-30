/**
 * One human line per event payload — the event table's "what happened" column.
 *
 * The rule that decides most of these: render the record, not a paraphrase of
 * it. An approval request shows `approval.summary` verbatim (approving a
 * paraphrase of a command is approving something you did not read), progress
 * and steering lines show their text as written, and a handoff shows the model
 * and the reason the initiator gave. Where an event is a transition, the line
 * is the transition itself (`running → succeeded`) — the table already has a
 * type column, so repeating the type in the detail adds nothing.
 */
import type { EventPayload } from "@rewter/shared";
import { shortModelId, usd } from "./format.js";

export function describeEvent(payload: EventPayload): string {
  switch (payload.type) {
    case "task.created":
      return payload.task.title;
    case "task.status_changed":
      return `${payload.from} → ${payload.to}`;
    case "task.plan_note":
      return payload.note;
    case "work_item.created":
      return `${payload.workItem.title} · T${payload.workItem.tier} ${shortModelId(payload.workItem.modelId)}`;
    case "work_item.status_changed":
      return `${payload.from} → ${payload.to}`;
    case "worker_run.created":
      return `attempt ${payload.workerRun.attempt} · ${shortModelId(payload.workerRun.modelId)} · T${payload.workerRun.tier}`;
    case "worker_run.status_changed":
      return `${payload.from} → ${payload.to}`;
    case "worker_run.progress":
      return payload.text;
    case "approval.requested":
      // Verbatim. This string is the thing a person is deciding to allow.
      return payload.approval.summary;
    case "approval.resolved":
      return `${payload.status} via ${payload.resolvedBy}${
        payload.note === null ? "" : ` — ${payload.note}`
      }`;
    case "cost.recorded":
      return `${usd(payload.cost.costUsd)} · ${shortModelId(payload.cost.modelId)}`;
    case "steering.received":
      return payload.text;
    case "handoff.initiated":
      return `→ ${shortModelId(payload.toModelId)} — ${payload.reason}`;
  }
}

/**
 * A table row holds one line, not a paragraph. Cut on a word boundary with an
 * ellipsis; the full text stays available to the row's title attribute.
 */
export function oneLine(text: string, max = 140): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
