/**
 * Starting an orchestration from the dashboard.
 *
 * Every task until now has come from a client — Claude Code, curl, a script —
 * because the only door into the engine is `POST /v1/chat/completions` with
 * `model: "auto/orchestrator"`. That makes the dashboard a place you *watch*
 * orchestrations from and never one you try them in, so the obvious question —
 * "does this prompt fan out the way I expect?" — costs a terminal, an env var
 * and a client round-trip to ask.
 *
 * The deliberate contrast is with `ChatTestRequest`. That one tests a *model*:
 * one prompt, one completion, one bill, answered inline. This one starts a
 * *task*: it returns as soon as the row exists and the answer arrives later, in
 * the tree, over the socket the dashboard is already folding. The two refuse
 * each other's model strings for exactly that reason — an orchestration in the
 * chat tester would answer a different question at an unbounded price, and a
 * concrete model here would be a completion with a task row wrapped round it.
 */
import { z } from "zod";
import { ModelIdSchema, TaskIdSchema } from "./ids.js";

export const RunTaskRequestSchema = z.object({
  /**
   * The task, as a user would type it to a client. It becomes the single user
   * message of the conversation, and its first line becomes the task title.
   *
   * Trimmed before the length check, so a textarea holding a stray newline is
   * refused here rather than starting a task whose title is blank.
   */
  prompt: z.string().trim().min(1),
  /**
   * Which orchestrator: `auto`, `auto/orchestrator`, or
   * `auto/orchestrator:<modelId>` to pin the initiator. Anything else is
   * refused — see the note above.
   */
  model: z.string().min(1).default("auto/orchestrator"),
  /**
   * The settings worth choosing per run, and only those.
   *
   * `maxSpendUsd` because a run started on a whim is precisely the one that
   * wants a ceiling, and `autoApprove` because a fan-out you are watching in
   * the browser is where waving through the gates is a reasonable choice to
   * make deliberately. `workspaceDir` is absent on purpose: a filesystem path
   * typed into a web form is a different feature with a different threat model,
   * and the config file already sets it. Omitted fields fall through to the
   * daemon's configured defaults exactly as a client's would.
   */
  settings: z
    .object({
      maxSpendUsd: z.number().positive().nullable().optional(),
      autoApprove: z.boolean().optional(),
      concurrency: z.number().int().positive().max(16).optional(),
    })
    .optional(),
});
export type RunTaskRequest = z.infer<typeof RunTaskRequestSchema>;

/**
 * What comes back the instant the row exists — not what the task produced.
 *
 * There is no result field here and there should not be: the answer, every
 * progress line and every cost arrive as events, and a response that also
 * carried them would be a second copy of the fold that could disagree with it.
 * The id is the handle for everything else (kill, budget, the tree row).
 */
export const RunTaskResultSchema = z.object({
  taskId: TaskIdSchema,
  /** Derived from the prompt by the engine — echoed so the caller can confirm. */
  title: z.string(),
  /** Which model is actually leading, after any pin and the registry's say. */
  initiatorModelId: ModelIdSchema,
});
export type RunTaskResult = z.infer<typeof RunTaskResultSchema>;
