/**
 * The initiator's tool surface.
 *
 * Each tool is declared twice on purpose: once as JSON Schema (what the model is
 * shown) and once as a zod schema (what we trust). They are written side by side
 * in one object so the pair cannot drift apart unnoticed, and a test asserts
 * that every JSON-Schema property has a zod counterpart and vice versa.
 *
 * Nothing here throws on bad input. A model that mis-calls a tool must get a
 * tool *result* saying what was wrong, not an exception that kills the task —
 * the correction is one cheap turn away, and a task that dies because the model
 * passed a number where a string was wanted is the worst possible trade. That is
 * the same "unreliable narrator" discipline `registry/cards.ts` applies to card
 * generation, applied to arguments instead of output.
 *
 * `send_to_worker` is declared here even though it works for only two of the
 * three tiers that can be spawned: a tier-1 worker is a single model call with
 * no turn boundary to deliver a message at, and the engine refuses the call for
 * one, naming tier 2 as the alternative. Offering the tool and refusing the
 * case beats withholding it — the model can read a refusal, and a tool it never
 * sees is a capability it cannot ask about.
 */
import type { ToolDefinition } from "@rewter/shared";
import { z } from "zod";

/** Bumped when the tool surface changes shape; snapshot-tested. */
export const ORCHESTRATOR_TOOLS_VERSION = 6;

const str = (description: string) => ({ type: "string", description }) as const;

/**
 * A worker is addressed by its label (`w1`), never by its `wi_…` id — the label
 * is what the user sees in the progress feed, so the initiator and the feed
 * agree on names, and in-band steering ("cancel w2") reads the same way.
 */
const LABEL_PATTERN = /^w\d+$/;
const LabelSchema = z
  .string()
  .trim()
  .transform((s) => s.toLowerCase())
  .refine((s) => LABEL_PATTERN.test(s), { message: 'expected a worker label like "w1"' });

export const PlanNoteArgs = z.object({
  note: z.string().trim().min(1).max(500),
});

export const SpawnWorkerArgs = z.object({
  title: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1),
  instructions: z.string().trim().min(1),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  resume_session_id: z.string().trim().min(1).max(200).optional(),
});

export const WaitArgs = z.object({
  /** Omitted means "every worker still running". */
  labels: z.array(LabelSchema).optional(),
  mode: z.enum(["all", "any"]).default("all"),
});

export const GetResultArgs = z.object({
  label: LabelSchema,
});

export const CancelWorkerArgs = z.object({
  label: LabelSchema,
  reason: z.string().trim().max(300).optional(),
});

export const SendToWorkerArgs = z.object({
  label: LabelSchema,
  message: z.string().trim().min(1).max(2000),
});

export const LoadSkillArgs = z.object({
  slug: z.string().trim().min(1).max(100),
});

export const AskUserArgs = z.object({
  question: z.string().trim().min(1).max(500),
});

export const HandoffArgs = z.object({
  to_model: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(500),
  context_summary: z.string().trim().min(1),
});

export const FinishArgs = z.object({
  answer: z.string().min(1),
});

export interface InitiatorTool {
  definition: ToolDefinition;
  schema: z.ZodTypeAny;
}

/**
 * Descriptions are load-bearing: they are the only place the model learns that
 * `spawn_worker` returns immediately, which is what makes fan-out happen at all.
 * Keep them behavioural ("returns immediately"), not restating the parameter
 * names the schema already gives.
 */
export const INITIATOR_TOOLS: Record<string, InitiatorTool> = {
  plan_note: {
    schema: PlanNoteArgs,
    definition: {
      name: "plan_note",
      description:
        "Tell the user, in one sentence, what you are about to do. Shown at the top of " +
        "their progress feed. Call this once early; call it again only if the plan changes.",
      parameters: {
        type: "object",
        properties: { note: str("One sentence describing your plan.") },
        required: ["note"],
      },
    },
  },

  spawn_worker: {
    schema: SpawnWorkerArgs,
    definition: {
      name: "spawn_worker",
      description:
        "Start a subtask on a model of your choosing. Returns immediately with a label " +
        "(w1, w2, …) while the worker runs in the background — call this several times in " +
        "one turn to run subtasks in parallel, then call wait. The worker sees only the " +
        "instructions you give it, so they must be self-contained.",
      parameters: {
        type: "object",
        properties: {
          title: str("Short label for the progress feed, e.g. 'summarize the changelog'."),
          model: str("Exact model id from the registry above."),
          instructions: str(
            "The complete, self-contained task: the input, the job, and the shape of the answer.",
          ),
          tier: {
            type: "integer",
            enum: [1, 2, 3],
            description:
              "1 = one model call, no tools (default) — use it for anything that is just " +
              "thinking, writing or summarizing. 2 = agent loop with file, shell and web " +
              "tools in a workspace — use it when the subtask has to read or change something. " +
              "3 = external coding harness (brings its own model; `model` is ignored) — " +
              "reserve it for substantial multi-file coding work; starting one may pause " +
              "for the user's approval.",
          },
          resume_session_id: str(
            "Tier 3 only: resume an interrupted harness session instead of starting fresh. " +
              "Use the session id the task header lists under resumable sessions. The harness " +
              "reloads its previous conversation, so write instructions that continue the " +
              "work — verify what was already done, then finish — rather than restating the " +
              "original task.",
          ),
        },
        required: ["title", "model", "instructions"],
      },
    },
  },

  wait: {
    schema: WaitArgs,
    definition: {
      name: "wait",
      description:
        "Block until workers finish, then return their one-line summaries. Use mode 'all' " +
        "to wait for every named worker, 'any' to continue as soon as one finishes.",
      parameters: {
        type: "object",
        properties: {
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Worker labels to wait for. Omit to wait for all running workers.",
          },
          mode: {
            type: "string",
            enum: ["all", "any"],
            description: "Default 'all'.",
          },
        },
        required: [],
      },
    },
  },

  get_result: {
    schema: GetResultArgs,
    definition: {
      name: "get_result",
      description:
        "Return a finished worker's full output. Costs you context — only call it when " +
        "the summary you already have is genuinely not enough.",
      parameters: {
        type: "object",
        properties: { label: str("Worker label, e.g. 'w1'.") },
        required: ["label"],
      },
    },
  },

  send_to_worker: {
    schema: SendToWorkerArgs,
    definition: {
      name: "send_to_worker",
      description:
        "Send a running tier-2 or tier-3 worker a message — a correction, a constraint you forgot, " +
        "an answer it needs. Returns immediately; the worker reads it at its next step, " +
        "so it does not interrupt work already in flight. Tier-1 workers cannot receive " +
        "messages: cancel and respawn one instead.",
      parameters: {
        type: "object",
        properties: {
          label: str("Worker label, e.g. 'w1'."),
          message: str("What to tell it. Write it as an instruction, not a question."),
        },
        required: ["label", "message"],
      },
    },
  },

  cancel_worker: {
    schema: CancelWorkerArgs,
    definition: {
      name: "cancel_worker",
      description: "Stop a running worker whose result you no longer need. Stops the billing too.",
      parameters: {
        type: "object",
        properties: {
          label: str("Worker label, e.g. 'w1'."),
          reason: str("Optional short reason, shown to the user."),
        },
        required: ["label"],
      },
    },
  },

  load_skill: {
    schema: LoadSkillArgs,
    definition: {
      name: "load_skill",
      description:
        "Fetch the full text of a skill from the Skills list above. Skills are learned " +
        "procedures — when one matches the task, load it before planning and follow it, " +
        "or paste the relevant part into a worker's instructions.",
      parameters: {
        type: "object",
        properties: { slug: str("The skill's slug, exactly as listed under Skills.") },
        required: ["slug"],
      },
    },
  },

  ask_user: {
    schema: AskUserArgs,
    definition: {
      name: "ask_user",
      description:
        "Ask the user one question and wait for their reply. Expensive in wall-clock time — " +
        "a human has to read it. Prefer stating an assumption and continuing.",
      parameters: {
        type: "object",
        properties: { question: str("The question, in one sentence.") },
        required: ["question"],
      },
    },
  },

  handoff: {
    schema: HandoffArgs,
    definition: {
      name: "handoff",
      description:
        "Give the task to a stronger model listed in the registry. You end here; it " +
        "continues with your context_summary and nothing else, so the summary must " +
        "contain everything it needs.",
      parameters: {
        type: "object",
        properties: {
          to_model: str("Exact model id from the registry above."),
          reason: str("Why that model and not you."),
          context_summary: str(
            "Everything the successor needs: the request, what you have learned, what is left.",
          ),
        },
        required: ["to_model", "reason", "context_summary"],
      },
    },
  },

  finish: {
    schema: FinishArgs,
    definition: {
      name: "finish",
      description:
        "Deliver the final answer to the user and end the task. Write it as if you did " +
        "the work yourself; do not mention workers.",
      parameters: {
        type: "object",
        properties: {
          answer: str("The complete answer for the user."),
        },
        required: ["answer"],
      },
    },
  },
};

export const INITIATOR_TOOL_DEFINITIONS: ToolDefinition[] = Object.values(INITIATOR_TOOLS).map(
  (t) => t.definition,
);

export type ParsedArgs = { ok: true; args: unknown } | { ok: false; error: string };

/**
 * Parse a tool call's raw argument string.
 *
 * Two failure modes are handled the same way — as a message back to the model:
 * a name we do not know (models hallucinate tools), and arguments that do not
 * fit. Both messages name the fix, because a bare "invalid arguments" costs an
 * extra round trip while the model guesses which field was wrong.
 */
export function parseToolArgs(name: string, rawArguments: string): ParsedArgs {
  const tool = INITIATOR_TOOLS[name];
  if (tool === undefined) {
    return {
      ok: false,
      error: `no such tool "${name}". Available: ${Object.keys(INITIATOR_TOOLS).join(", ")}.`,
    };
  }

  // An argument-less call may arrive as "", "{}", or whitespace depending on the
  // provider; all three mean the same thing and none should look like a syntax error.
  const trimmed = rawArguments.trim();
  let value: unknown;
  try {
    value = trimmed === "" ? {} : JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      error: `arguments were not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = tool.schema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: `invalid arguments: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}`,
    };
  }
  return { ok: true, args: parsed.data };
}
