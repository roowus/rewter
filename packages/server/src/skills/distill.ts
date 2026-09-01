/**
 * The distiller: turn a finished task's event log into a draft SKILL.md
 * (phase-2 M4, docs/design/phase2-direction.md §2, step "distill").
 *
 * The pipeline is the capability-card generator's (`registry/cards.ts`) aimed
 * at a different artifact: a cheap model reads a condensed transcript of what
 * actually happened — the same event log the dashboard replays, no new
 * instrumentation — and drafts a reusable procedure. Same unreliable-narrator
 * posture: the reply is extracted, zod-parsed defensively, normalized, and a
 * refusal is a first-class outcome ("nothing reusable here" beats a junk
 * skill in the review queue).
 *
 * What the distiller may do ends at `pending/`. Drafts land in the staging
 * directory, which retrieval never reads (`visibleSkills` filters on status);
 * promotion into a scoped directory is the owner's approval act, by hand or
 * through the coming `/internal/skills` routes. So the distiller can run
 * unattended after every qualifying task without a gate of its own — the gate
 * is that nothing it writes is ever used until a human moves it.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ChatMessage,
  type ChatResponse,
  type EventEnvelope,
  type Model,
  type ModelId,
  type Project,
  type Skill,
  SkillSlugSchema,
  type Task,
  type TaskId,
  type WorkItem,
} from "@rewter/shared";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { clamp, collapse, extractJsonObject } from "../llm/text.js";
import { estimateTokens } from "../registry/tokens.js";
import { SKILL_FILENAME, parseSkillMd } from "./store.js";

/** Bumped when the prompt changes shape; snapshot-tested for stability. */
export const DISTILL_PROMPT_VERSION = 1;

/**
 * The spec's trigger is "≥5 tool calls across the task's workers", but
 * individual tool calls are not events. The closest signal the log does carry
 * is `cost.recorded` with a worker attribution: one per worker LLM turn, and a
 * tier-2 loop only takes another turn after a tool round-trip — so worker
 * turns ≈ tool calls + one opening turn per run. Six turns is the same bar,
 * measured in the currency we actually mint.
 */
export const DEFAULT_MIN_WORKER_TURNS = 6;

/**
 * The transcript the model reads. Enough for a long fan-out; past it the
 * middle is elided rather than the tail — the setup and the outcome teach the
 * procedure, a hundred identical progress lines do not.
 */
const TRANSCRIPT_BUDGET_TOKENS = 6_000;

const DESCRIPTION_MAX_CHARS = 1_024; // the agentskills.io ceiling, enforced by SkillFrontmatterSchema
/** Same runaway guard as cards: must clear a reasoning model's thinking spend. */
const MAX_TOKENS = 8_000;

export class DistillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DistillError";
  }
}

// ── Prompt ──────────────────────────────────────────────────────────────────

export const DISTILL_SYSTEM_PROMPT = `You distill reusable skills from finished AI-agent task logs.

A skill is a SKILL.md an orchestrator loads the next time similar work comes in. Write for
that reader: a procedure it can follow, not a story about this run.

Reply with a single JSON object and nothing else — no prose, no code fence. Either:

{"skip": true, "reason": "why nothing here is worth keeping"}

or:

{
  "name": "kebab-case-slug-for-the-skill",
  "description": "one line: when to reach for this skill, under ${DESCRIPTION_MAX_CHARS} characters",
  "body": "the SKILL.md body as markdown"
}

Rules:
- Skip freely. A one-off task, a task whose value was its answer rather than its method,
  or a run that mostly failed teaches nothing — say so. A junk skill costs a human a review.
- The body is the procedure: the steps that worked, in order, generalized past this task's
  specifics (name the *kind* of input, not this run's filenames).
- Include a "Pitfalls" section when the log shows any: denied approvals, failed attempts,
  retries, handoffs. What went wrong here is exactly what the next run must not repeat.
- Include a "Verification" section: how the result was (or should be) checked.
- "description" is what a router decides from — say when to use this skill, not what it is.
- State nothing the log does not show. An invented step will be followed.
- If the log already matches an existing skill you were shown, skip and name it in "reason".`;

// ── Trigger ─────────────────────────────────────────────────────────────────

export interface DistillTrigger {
  distill: boolean;
  /** `cost.recorded` events attributed to a worker run — the turn count. */
  workerTurns: number;
}

/** Cheap and log-only, so the daemon can decide before spending anything. */
export function shouldDistill(
  events: EventEnvelope[],
  minWorkerTurns = DEFAULT_MIN_WORKER_TURNS,
): DistillTrigger {
  let workerTurns = 0;
  for (const e of events) {
    if (e.payload.type === "cost.recorded" && e.payload.cost.workerRunId !== null) workerTurns++;
  }
  return { distill: workerTurns >= minWorkerTurns, workerTurns };
}

// ── Transcript ──────────────────────────────────────────────────────────────

/**
 * One line per event the model can learn from. Costs, run bookkeeping, and
 * settings churn are noise for this reader and are dropped; approvals are the
 * opposite — a denial is the log saying "not like that", which is precisely
 * the pitfall the skill must carry.
 */
function eventLine(e: EventEnvelope, items: Map<string, WorkItem>): string | null {
  const p = e.payload;
  switch (p.type) {
    case "task.plan_note":
      return `plan: ${clip(p.note, 400)}`;
    case "work_item.created": {
      const w = p.workItem;
      return `worker "${w.title}" → ${w.modelId} (tier ${w.tier}): ${clip(w.instructions, 400)}`;
    }
    case "work_item.status_changed": {
      if (p.to !== "succeeded" && p.to !== "failed" && p.to !== "handed_off") return null;
      const w = items.get(p.workItemId);
      const label = w === undefined ? p.workItemId : `"${w.title}"`;
      const outcome =
        p.to === "failed"
          ? `failed${w?.error !== null && w?.error !== undefined ? `: ${clip(w.error, 300)}` : ""}`
          : p.to === "handed_off"
            ? "handed off"
            : `succeeded${w?.resultSummary !== null && w?.resultSummary !== undefined ? `: ${clip(w.resultSummary, 400)}` : ""}`;
      return `worker ${label} ${outcome}`;
    }
    case "worker_run.progress":
      return `progress: ${clip(p.text, 300)}`;
    case "approval.requested":
      return `approval requested (${p.approval.kind}): ${clip(p.approval.summary, 300)}`;
    case "approval.resolved":
      return `approval ${p.status}${p.note === null ? "" : `: ${clip(p.note, 300)}`}`;
    case "handoff.initiated":
      return `handoff → ${p.toModelId}: ${clip(p.reason, 300)}`;
    case "steering.received":
      return `user steering: ${clip(p.text, 400)}`;
    default:
      return null;
  }
}

function clip(s: string, max: number): string {
  return clamp(collapse(s), max);
}

/**
 * The condensed transcript: header facts, then the event lines in order,
 * middle-elided to the token budget. Elision says how much it dropped —
 * a transcript that silently skipped the interesting part would produce a
 * skill that confidently omits it.
 */
export function condenseTaskLog(
  task: Task,
  events: EventEnvelope[],
  workItems: WorkItem[],
  budgetTokens = TRANSCRIPT_BUDGET_TOKENS,
): string {
  const items = new Map<string, WorkItem>(workItems.map((w) => [w.id, w]));
  const lines: string[] = [];
  for (const e of events) {
    const line = eventLine(e, items);
    if (line !== null) lines.push(line);
  }

  const header = [
    `task: ${clip(task.title, 300)}`,
    `outcome: ${task.status}${task.resultSummary === null ? "" : ` — ${clip(task.resultSummary, 600)}`}`,
    `workers: ${workItems.length}`,
    "",
  ];

  let body = lines;
  while (body.length > 8 && estimateTokens([...header, ...body].join("\n")) > budgetTokens) {
    // Halve the middle each pass: keeps the plan (head) and the outcome (tail).
    const keep = Math.max(4, Math.floor(body.length / 4));
    const dropped = body.length - keep * 2;
    body = [...body.slice(0, keep), `[… ${dropped} lines elided …]`, ...body.slice(-keep)];
    if (dropped <= 0) break;
  }

  return [...header, ...body].join("\n");
}

// ── Messages ────────────────────────────────────────────────────────────────

export function buildDistillMessages(
  task: Task,
  transcript: string,
  existing: Skill[],
  projectSlug: string | null,
): ChatMessage[] {
  const known =
    existing.length === 0
      ? "none yet"
      : existing
          .slice(0, 50)
          .map(
            (s) =>
              `- ${s.slug}${s.status === "pending" ? " (pending review)" : ""}: ${clip(s.description, 160)}`,
          )
          .join("\n");
  const scope =
    projectSlug === null
      ? "This was a bare task; the skill would be global."
      : `This task ran in project "${projectSlug}"; prefer scoping the skill to it unless the procedure is clearly general.`;
  return [
    { role: "system", content: DISTILL_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Distill a skill from this task log, or skip it.

${scope}

Skills that already exist (do not re-draft these):
${known}

Task log:
${transcript}`,
    },
  ];
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Loose on purpose, like the card draft: `name` is a string here, not the
 * branded slug — a near-miss name gets slugified rather than costing the
 * whole draft, and only an unrecoverable one is fatal.
 */
const DraftSchema = z.union([
  z.object({ skip: z.literal(true), reason: z.string().default("") }),
  z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    body: z.string().min(1),
  }),
]);

export type SkillDraft =
  | { skip: true; reason: string }
  | { skip: false; slug: string; description: string; body: string };

export function parseSkillDraft(raw: string): SkillDraft {
  const json = extractJsonObject(raw);
  if (json === undefined) throw new DistillError("no JSON object in the distiller's reply");

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    throw new DistillError(`distiller produced invalid JSON: ${message(err)}`);
  }

  const parsed = DraftSchema.safeParse(value);
  if (!parsed.success) {
    throw new DistillError(
      `distiller's draft does not fit the schema: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}`,
    );
  }
  if ("skip" in parsed.data) return { skip: true, reason: collapse(parsed.data.reason) };

  const slug = slugify(parsed.data.name);
  if (slug === null) {
    throw new DistillError(
      `cannot make a slug of the skill name ${JSON.stringify(parsed.data.name)}`,
    );
  }
  return {
    skip: false,
    slug,
    description: clamp(collapse(parsed.data.description), DESCRIPTION_MAX_CHARS),
    body: parsed.data.body.trim(),
  };
}

/** Best-effort repair into `SkillSlugSchema`'s shape; null when nothing survives. */
export function slugify(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return SkillSlugSchema.safeParse(slug).success ? slug : null;
}

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * Compose the SKILL.md and prove it round-trips through our own parser before
 * it touches disk — a draft the scanner would refuse belongs in an error, not
 * in `pending/` as a per-boot "skill not indexed" warning forever.
 */
export function composeSkillMd(
  draft: { slug: string; description: string; body: string },
  learnedFrom: TaskId,
  projectSlug: string | null,
): string {
  const frontmatter = stringifyYaml({
    name: draft.slug,
    description: draft.description,
    learned_from: learnedFrom,
    ...(projectSlug === null ? {} : { project: projectSlug }),
  });
  const text = `---\n${frontmatter}---\n\n${draft.body}\n`;
  try {
    parseSkillMd(text);
  } catch (err) {
    throw new DistillError(`composed draft does not survive the skill parser: ${message(err)}`);
  }
  return text;
}

// ── The job ─────────────────────────────────────────────────────────────────

/** The slice of `Router` the distiller needs — same seam as `CardGenerator`. */
export interface DistillGenerator {
  resolve(model: string): { model: Model };
  complete(
    req: {
      model: string;
      messages: ChatMessage[];
      maxTokens?: number;
      temperature?: number;
      /** Attributes the distillation spend to the task it learned from. */
      taskId?: TaskId | null;
    },
    signal?: AbortSignal,
  ): Promise<ChatResponse>;
}

/** Everything the distiller reads and writes, as one narrow seam for tests. */
export interface DistillSource {
  eventsAfter(afterSeq: number, taskId?: string): EventEnvelope[];
  listWorkItems(taskId: string): WorkItem[];
  getProject(id: string): Project | undefined;
  listSkills(): Skill[];
}

export interface DistillOptions {
  /** Model that drafts. Resolved up front, so a typo fails before spending. */
  using: string;
  /** Trigger floor; see DEFAULT_MIN_WORKER_TURNS. */
  minWorkerTurns?: number;
  signal?: AbortSignal;
}

export interface DistillResult {
  taskId: TaskId;
  outcome: "drafted" | "skipped" | "failed";
  /** Set when outcome = "drafted". */
  slug?: string;
  path?: string;
  /** Why it was skipped or how it failed. */
  reason?: string;
}

/**
 * Distill one task into a pending draft. Never throws: a failed distillation
 * is a log line, not a daemon problem — the task it learned from already
 * succeeded, and nothing downstream depends on the draft existing.
 *
 * The caller reindexes after a "drafted" outcome; this function only lands
 * the file. Cost is recorded by the Router like every other completion, and
 * `taskId` on the request books it against the task that taught us.
 */
export async function distillTask(
  generator: DistillGenerator,
  source: DistillSource,
  skillsRoot: string,
  task: Task,
  opts: DistillOptions,
): Promise<DistillResult> {
  try {
    const model = generator.resolve(opts.using).model.id;

    const events = source.eventsAfter(0, task.id);
    const trigger = shouldDistill(events, opts.minWorkerTurns ?? DEFAULT_MIN_WORKER_TURNS);
    if (!trigger.distill) {
      return {
        taskId: task.id,
        outcome: "skipped",
        reason: `only ${trigger.workerTurns} worker turn(s) — below the distill floor`,
      };
    }

    const workItems = source.listWorkItems(task.id);
    const project = task.projectId === null ? undefined : source.getProject(task.projectId);
    const projectSlug = project === undefined ? null : project.slug;
    const transcript = condenseTaskLog(task, events, workItems);
    const messages = buildDistillMessages(task, transcript, source.listSkills(), projectSlug);

    const response = await generator.complete(
      {
        model,
        messages,
        maxTokens: MAX_TOKENS,
        // A skill is a record of what happened, not prose to vary.
        temperature: 0,
        taskId: task.id,
      },
      opts.signal,
    );

    let draft: SkillDraft;
    try {
      draft = parseSkillDraft(response.message.content ?? "");
    } catch (err) {
      const truncated =
        response.finishReason === "length"
          ? ` (the reply hit the ${MAX_TOKENS}-token ceiling and was cut off)`
          : "";
      return { taskId: task.id, outcome: "failed", reason: `${message(err)}${truncated}` };
    }

    if (draft.skip) {
      return {
        taskId: task.id,
        outcome: "skipped",
        reason: draft.reason === "" ? "distiller judged nothing reusable" : draft.reason,
      };
    }

    // A pending twin of an *approved* skill is a legitimate replacement draft
    // (SkillSchema documents exactly that); a second pending draft under the
    // same slug would silently overwrite one nobody has reviewed yet.
    const dir = join(skillsRoot, "pending", draft.slug);
    const path = join(dir, SKILL_FILENAME);
    if (existsSync(path)) {
      return {
        taskId: task.id,
        outcome: "skipped",
        reason: `a draft named "${draft.slug}" is already pending review`,
      };
    }

    const text = composeSkillMd(draft, task.id, projectSlug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, text, "utf8");
    return { taskId: task.id, outcome: "drafted", slug: draft.slug, path };
  } catch (err) {
    return { taskId: task.id, outcome: "failed", reason: message(err) };
  }
}

// ── Picking the cheap model ─────────────────────────────────────────────────

/**
 * The initiator heuristic inverted: distillation is summarization, so when no
 * model is configured, take the *cheapest* enabled one with a known price —
 * known-cheap beats unknown, because "unknown" is usually a hand-authored
 * local entry nobody priced, not a free lunch. Tools don't matter here; the
 * distiller only needs JSON out.
 */
export function pickDistillModel(models: Model[]): ModelId | undefined {
  const best = [...models].sort((a, b) => {
    const pa = a.pricing.outputPerMTok;
    const pb = b.pricing.outputPerMTok;
    const ka = pa === null ? 1 : 0;
    const kb = pb === null ? 1 : 0;
    return ka - kb || (pa ?? 0) - (pb ?? 0) || a.id.localeCompare(b.id);
  })[0];
  return best?.id;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
