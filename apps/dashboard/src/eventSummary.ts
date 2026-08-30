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
import type { EventPayload, TaskSettings } from "@rewter/shared";
import { shortModelId, usd } from "./format.js";

/**
 * The fields that moved, not the whole object.
 *
 * The payload carries both settings wholesale (the fold needs the complete
 * object), but a row that restated all four every time would bury the one that
 * changed. An empty diff is still worth a line: the event happened, and saying
 * "no change" is more honest than an empty cell that reads as a render bug.
 */
function describeSettingsChange(from: TaskSettings, to: TaskSettings): string {
  const parts: string[] = [];
  if (from.maxSpendUsd !== to.maxSpendUsd) {
    parts.push(`budget ${capLabel(from.maxSpendUsd)} → ${capLabel(to.maxSpendUsd)}`);
  }
  if (from.autoApprove !== to.autoApprove) {
    parts.push(`auto-approve ${from.autoApprove} → ${to.autoApprove}`);
  }
  if (from.concurrency !== to.concurrency) {
    parts.push(`concurrency ${from.concurrency} → ${to.concurrency}`);
  }
  if (from.workspaceDir !== to.workspaceDir) {
    parts.push(`workspace ${from.workspaceDir ?? "default"} → ${to.workspaceDir ?? "default"}`);
  }
  return parts.length === 0 ? "no change" : parts.join(", ");
}

/** `null` is an uncapped task, which `usd(0)`-style formatting would hide. */
export function capLabel(cap: number | null): string {
  return cap === null ? "uncapped" : usd(cap);
}

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
    case "task.settings_changed":
      return describeSettingsChange(payload.from, payload.to);
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
