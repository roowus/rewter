/**
 * The practices drafter: turn the *corrections* in a finished task's event log
 * into pending PRACTICE.md facts (docs/design/practices-memory.md).
 *
 * Skills are distilled from what worked; practices are distilled from what the
 * owner pushed back on. The event log carries exactly three kinds of pushback,
 * none of which needed new instrumentation: a steering message mid-run
 * (`steering.received`), a denied approval and its note (`approval.resolved`
 * with `status: "denied"`), and — the softest — a task that failed and says
 * why. Only the first two are corrections in the owner's own words, and only
 * they trigger a draft; a task with neither costs nothing here.
 *
 * Everything the drafter writes lands in `pending/`, which no prompt ever
 * reads. Same unattended-but-inert posture as the skills distiller: the gate
 * is that a fact is used only after a human moves it.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ChatMessage,
  type ChatResponse,
  type EventEnvelope,
  type Model,
  PRACTICE_MAX_CHARS,
  type Practice,
  PracticeSlugSchema,
  type Project,
  type Task,
  type TaskId,
  type WorkItem,
} from "@rewter/shared";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { clamp, collapse, extractJsonObject } from "../llm/text.js";
import { estimateTokens } from "../registry/tokens.js";
import { PRACTICE_FILENAME, parsePracticeMd } from "./store.js";

/** Bumped when the prompt changes shape; snapshot-tested for stability. */
export const PRACTICES_DISTILL_PROMPT_VERSION = 1;

/** A task's log rarely holds more than one or two real corrections. */
export const MAX_PRACTICES_PER_TASK = 3;

/** The corrections are short; the surrounding context need not be long. */
const TRANSCRIPT_BUDGET_TOKENS = 3_000;
/** Runaway guard that still clears a reasoning model's thinking spend. */
const MAX_TOKENS = 4_000;

export class PracticeDistillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PracticeDistillError";
  }
}

// ── Prompt ──────────────────────────────────────────────────────────────────

export const PRACTICES_DISTILL_SYSTEM_PROMPT = `You extract standing rules from the corrections a user made during an AI-agent task.

A practice is one short durable fact that every future task should honour: a correction
("do not force-push on this repo"), a convention ("tests sit next to the source file"),
or a tool preference ("use pnpm, never npm"). It is NOT a procedure and NOT a summary of
this task — it is the sentence the user would put in a CLAUDE.md so they never have to
say it again.

Reply with a single JSON object and nothing else — no prose, no code fence. Either:

{"skip": true, "reason": "why nothing here is a durable rule"}

or:

{"practices": [
  {"name": "kebab-case-slug", "fact": "the rule, one or two sentences, under ${PRACTICE_MAX_CHARS} characters", "scope": "global" | "project"}
]}

Rules:
- Skip freely. Steering that only redirected *this* task ("actually compare against v2")
  is not a rule. A denial with no stated reason is not a rule. Only keep what the user
  would want applied to every future task.
- One fact per practice, at most ${MAX_PRACTICES_PER_TASK}. Write the fact as an instruction, in the
  imperative, generalized past this run's filenames.
- "scope" is "project" when the rule is about this codebase or project (its tools, its
  layout, its policies) and "global" when the user would want it everywhere. When the
  task has no project, everything is global.
- State nothing the log does not show. A rule the user never expressed will be obeyed.
- If a fact you were shown as an existing practice already covers it, leave it out.`;

// ── Trigger ─────────────────────────────────────────────────────────────────

export interface PracticesTrigger {
  distill: boolean;
  /** Steering messages plus denied approvals — the owner's corrections. */
  corrections: number;
}

/** Log-only and cheap, so the daemon decides before spending anything. */
export function shouldDraftPractices(events: EventEnvelope[]): PracticesTrigger {
  let corrections = 0;
  for (const e of events) {
    const p = e.payload;
    if (p.type === "steering.received") corrections++;
    else if (p.type === "approval.resolved" && p.status === "denied") corrections++;
  }
  return { distill: corrections > 0, corrections };
}

// ── Transcript ──────────────────────────────────────────────────────────────

/**
 * The corrections, each with just enough of what it was correcting. The plan
 * and the worker briefs give the model the "before"; the steering, denials
 * and outcome give it the "not like that". Progress lines, costs and run
 * bookkeeping are noise for this reader.
 */
function eventLine(e: EventEnvelope, items: Map<string, WorkItem>): string | null {
  const p = e.payload;
  switch (p.type) {
    case "task.plan_note":
      return `plan: ${clip(p.note, 300)}`;
    case "work_item.created": {
      const w = p.workItem;
      return `worker "${w.title}" briefed: ${clip(w.instructions, 200)}`;
    }
    case "approval.requested":
      return `approval requested (${p.approval.kind}): ${clip(p.approval.summary, 300)}`;
    case "approval.resolved":
      if (p.status !== "denied") return null;
      return `USER DENIED${p.note === null ? "" : `: ${clip(p.note, 300)}`}`;
    case "steering.received":
      return `USER STEERED: ${clip(p.text, 400)}`;
    case "work_item.status_changed": {
      if (p.to !== "failed") return null;
      const w = items.get(p.workItemId);
      return w === undefined ? null : `worker "${w.title}" failed: ${clip(w.error ?? "", 200)}`;
    }
    default:
      return null;
  }
}

export function condenseCorrections(
  task: Task,
  events: EventEnvelope[],
  workItems: WorkItem[],
  budgetTokens = TRANSCRIPT_BUDGET_TOKENS,
): string {
  const items = new Map(workItems.map((w) => [w.id, w]));
  const header = [
    `task: ${clip(task.title, 300)}`,
    `outcome: ${task.status}${
      task.resultSummary === null ? "" : ` — ${clip(task.resultSummary, 300)}`
    }${task.error === null ? "" : ` — error: ${clip(task.error, 300)}`}`,
    "",
  ];
  let body = events.map((e) => eventLine(e, items)).filter((l): l is string => l !== null);

  while (body.length > 8 && estimateTokens([...header, ...body].join("\n")) > budgetTokens) {
    const keep = Math.max(4, Math.floor(body.length / 4));
    const dropped = body.length - keep * 2;
    body = [...body.slice(0, keep), `[… ${dropped} lines elided …]`, ...body.slice(-keep)];
    if (dropped <= 0) break;
  }
  return [...header, ...body].join("\n");
}

function clip(s: string, max: number): string {
  return clamp(collapse(s), max);
}

// ── Messages ────────────────────────────────────────────────────────────────

export function buildPracticesDistillMessages(
  transcript: string,
  existing: Practice[],
  projectSlug: string | null,
): ChatMessage[] {
  const known =
    existing.length === 0
      ? "(none yet)"
      : existing
          .slice(0, 50)
          .map((p) => `- ${p.slug}${p.status === "pending" ? " (pending review)" : ""}: ${p.fact}`)
          .join("\n");
  const scope =
    projectSlug === null
      ? "The task ran with no project, so every practice you draft is global."
      : `The task ran under project "${projectSlug}"; a "project" scope means that project.`;

  return [
    { role: "system", content: PRACTICES_DISTILL_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Extract standing rules from the corrections in this task log, or skip it.

${scope}

Practices that already exist (do not re-draft these):
${known}

Task log:
${transcript}`,
    },
  ];
}

// ── Parsing ─────────────────────────────────────────────────────────────────

const DraftSchema = z.union([
  z.object({ skip: z.literal(true), reason: z.string().default("") }),
  z.object({
    practices: z
      .array(
        z.object({
          name: z.string().min(1),
          fact: z.string().min(1),
          scope: z.enum(["global", "project"]).default("global"),
        }),
      )
      .min(1),
  }),
]);

export interface PracticeDraftItem {
  slug: string;
  fact: string;
  scope: "global" | "project";
}

export type PracticesDraft =
  | { skip: true; reason: string }
  | { skip: false; practices: PracticeDraftItem[] };

/**
 * Loose on purpose: a near-miss name is slugified, an over-long fact is
 * clamped, a surplus item past the cap is dropped. Only an unusable reply is
 * fatal — a garbage draft costs one warn line, never a crash.
 */
export function parsePracticesDraft(raw: string): PracticesDraft {
  const json = extractJsonObject(raw);
  if (json === undefined) throw new PracticeDistillError("no JSON object in the drafter's reply");

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    throw new PracticeDistillError(`drafter produced invalid JSON: ${message(err)}`);
  }

  const parsed = DraftSchema.safeParse(value);
  if (!parsed.success) {
    throw new PracticeDistillError(
      `drafter's reply does not fit the schema: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}`,
    );
  }
  if ("skip" in parsed.data) return { skip: true, reason: collapse(parsed.data.reason) };

  const practices: PracticeDraftItem[] = [];
  const seen = new Set<string>();
  for (const item of parsed.data.practices.slice(0, MAX_PRACTICES_PER_TASK)) {
    const slug = slugifyPractice(item.name);
    if (slug === null) {
      throw new PracticeDistillError(
        `cannot make a slug of the practice name ${JSON.stringify(item.name)}`,
      );
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    // `clamp` appends "…" past the cut, and the cap is the parser's hard limit —
    // leave room so an over-long draft still survives `composePracticeMd`.
    const fact = clamp(collapse(item.fact), PRACTICE_MAX_CHARS - 1);
    practices.push({ slug, fact, scope: item.scope });
  }
  return { skip: false, practices };
}

/** Best-effort repair into `PracticeSlugSchema`'s shape; null when nothing survives. */
export function slugifyPractice(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return PracticeSlugSchema.safeParse(slug).success ? slug : null;
}

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * Compose the PRACTICE.md and prove it round-trips through our own parser
 * before it touches disk.
 */
export function composePracticeMd(
  draft: { slug: string; fact: string },
  learnedFrom: TaskId,
  projectSlug: string | null,
): string {
  const frontmatter = stringifyYaml({
    name: draft.slug,
    learned_from: learnedFrom,
    ...(projectSlug === null ? {} : { project: projectSlug }),
  });
  const text = `---\n${frontmatter}---\n\n${draft.fact}\n`;
  try {
    parsePracticeMd(text);
  } catch (err) {
    throw new PracticeDistillError(
      `composed draft does not survive the practice parser: ${message(err)}`,
    );
  }
  return text;
}

// ── The job ─────────────────────────────────────────────────────────────────

export interface PracticesGenerator {
  resolve(model: string): { model: Model };
  complete(
    req: {
      model: string;
      messages: ChatMessage[];
      maxTokens?: number;
      temperature?: number;
      taskId?: TaskId | null;
    },
    signal?: AbortSignal,
  ): Promise<ChatResponse>;
}

export interface PracticesSource {
  eventsAfter(afterSeq: number, taskId?: string): EventEnvelope[];
  listWorkItems(taskId: string): WorkItem[];
  getProject(id: string): Project | undefined;
  listPractices(): Practice[];
}

export interface PracticesDistillOptions {
  using: string;
  signal?: AbortSignal | undefined;
}

export interface PracticesDistillResult {
  taskId: TaskId;
  outcome: "drafted" | "skipped" | "failed";
  /** Slugs that landed in `pending/` (drafted). */
  slugs?: string[];
  /** Slugs the drafter proposed that already had a pending twin, left alone. */
  alreadyPending?: string[];
  reason?: string;
}

/**
 * Read → decide → draft → stage. Never throws: a task that fails to yield a
 * practice is a log line, and the daemon's bus subscriber must not die.
 */
export async function draftPractices(
  generator: PracticesGenerator,
  source: PracticesSource,
  practicesRoot: string,
  task: Task,
  opts: PracticesDistillOptions,
): Promise<PracticesDistillResult> {
  try {
    const { model } = generator.resolve(opts.using);
    const events = source.eventsAfter(0, task.id);
    const trigger = shouldDraftPractices(events);
    if (!trigger.distill) {
      return { taskId: task.id, outcome: "skipped", reason: "no corrections in the task log" };
    }

    const projectSlug =
      task.projectId === null ? null : (source.getProject(task.projectId)?.slug ?? null);
    const transcript = condenseCorrections(task, events, source.listWorkItems(task.id));
    const messages = buildPracticesDistillMessages(transcript, source.listPractices(), projectSlug);

    const response = await generator.complete(
      { model: model.id, messages, maxTokens: MAX_TOKENS, temperature: 0, taskId: task.id },
      opts.signal,
    );

    let draft: PracticesDraft;
    try {
      draft = parsePracticesDraft(response.message.content ?? "");
    } catch (err) {
      const suffix =
        response.finishReason === "length"
          ? ` (the reply hit the ${MAX_TOKENS}-token ceiling and was cut off)`
          : "";
      return { taskId: task.id, outcome: "failed", reason: `${message(err)}${suffix}` };
    }
    if (draft.skip) {
      return {
        taskId: task.id,
        outcome: "skipped",
        reason: draft.reason === "" ? "drafter judged nothing durable" : draft.reason,
      };
    }

    const slugs: string[] = [];
    const alreadyPending: string[] = [];
    for (const item of draft.practices) {
      const dir = join(practicesRoot, "pending", item.slug);
      const path = join(dir, PRACTICE_FILENAME);
      if (existsSync(path)) {
        alreadyPending.push(item.slug);
        continue;
      }
      // A "project" fact for a task with no project is global — the prompt said so,
      // and a draft with a scope it cannot have would be refused at approval.
      const target = item.scope === "project" ? projectSlug : null;
      const text = composePracticeMd(item, task.id, target);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, text, "utf8");
      slugs.push(item.slug);
    }

    if (slugs.length === 0) {
      return {
        taskId: task.id,
        outcome: "skipped",
        alreadyPending,
        reason: `every proposed practice is already pending review (${alreadyPending.join(", ")})`,
      };
    }
    return { taskId: task.id, outcome: "drafted", slugs, alreadyPending };
  } catch (err) {
    return { taskId: task.id, outcome: "failed", reason: message(err) };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
