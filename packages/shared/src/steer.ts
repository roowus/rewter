/**
 * Steering a running task by its id.
 *
 * Steering has existed since M5, but only through the front door: re-POSTing
 * the conversation to `/v1/chat/completions` and letting the daemon match it
 * back to the live task. That is the right mechanism for an OpenAI client,
 * which has nothing *but* the conversation — and the wrong one for a client
 * that knows the task id, because it drags the whole transcript over the wire
 * to say one sentence, and a fingerprint match is an inference where an id is
 * a fact. The TUI is that client: its input line stays live while a task runs,
 * and what it types must land in *this* task, exactly, or nowhere.
 *
 * The message goes through the same parser the re-POST path uses, so
 * `approve apr_…` typed into the TUI resolves the approval instead of being
 * read aloud to the initiator — one grammar, not one per door.
 */
import { z } from "zod";
import { TaskIdSchema } from "./ids.js";

export const SteerTaskRequestSchema = z.object({
  /**
   * What the user typed. Trimmed before the length check — an accidental
   * bare newline is refused here, not injected as an empty instruction.
   */
  message: z.string().trim().min(1),
});
export type SteerTaskRequest = z.infer<typeof SteerTaskRequestSchema>;

/**
 * What the parser did with the message — not what the task did with it.
 *
 * `queued` means the steering text is in the task's queue; the engine injects
 * it at the next turn boundary and appends `steering.received` to the event
 * log at that moment, so "did it reach the initiator" is answered by the log,
 * not by this response. `approvals` counts commands the parser recognised and
 * routed to the approval gate; whether each one released a worker is the
 * approvals API's story.
 */
export const SteerTaskResultSchema = z.object({
  taskId: TaskIdSchema,
  /** True when a non-command remainder was queued for injection. */
  queued: z.boolean(),
  /** The steering text actually queued, "" when the message was all commands. */
  remainder: z.string(),
  /** How many approval commands were parsed out and applied. */
  approvals: z.number().int().nonnegative(),
});
export type SteerTaskResult = z.infer<typeof SteerTaskResultSchema>;
