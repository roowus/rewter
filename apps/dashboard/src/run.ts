/**
 * Starting a task from the dashboard — the fetch half.
 *
 * Shaped like `translate.ts`'s clients rather than `cancel.ts`'s, because the
 * daemon answers with a body worth parsing and not just a status: the title it
 * derived and the initiator it picked are both answers this side did not know
 * and cannot compute. They come back so the panel can show what it actually
 * started, which is the difference between a form that submits and a control
 * that reports.
 *
 * Nothing here writes to the store, for the same reason nothing in `budget.ts`
 * does. The task arrives in the tree as `task.created` down the socket the
 * dashboard is already folding, so the row on screen is the daemon's, not a
 * local optimistic copy that could disagree with it. A 202 is genuinely all
 * this function knows.
 *
 * The daemon's own `{error: {message}}` is surfaced verbatim, as everywhere
 * else: "auto/orchestrator is the only model this route starts" is the whole
 * answer someone pressed Run to get, and "daemon said 400" would send them to
 * the logs to find the same sentence.
 */
import { type RunTaskResult, RunTaskResultSchema } from "@rewter/shared";
import { z } from "zod";

export type Result<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * What the form collects, in the shape the route takes.
 *
 * `maxSpendUsd: null` is uncapped and is not the same request as omitting the
 * field — `null` clears any configured default, an absent field inherits it.
 * The panel makes that distinction at its own boundary (see `parseBudget`), so
 * this function passes through whatever it is handed rather than trying to
 * reconstruct the intent from an empty string.
 */
export interface RunInput {
  prompt: string;
  /** A model id to lead with, or `null` for the registry's own choice. */
  initiator?: string | null;
  maxSpendUsd?: number | null;
  autoApprove?: boolean;
}

export async function runTask(
  input: RunInput,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<RunTaskResult>> {
  const settings: Record<string, unknown> = {};
  if (input.maxSpendUsd !== undefined) settings.maxSpendUsd = input.maxSpendUsd;
  if (input.autoApprove !== undefined) settings.autoApprove = input.autoApprove;

  const payload = {
    prompt: input.prompt,
    // A blank pin is not a pin. The bare pseudo-model lets the registry choose,
    // which is the same thing a client that never heard of pinning would send.
    model:
      input.initiator == null || input.initiator === ""
        ? "auto/orchestrator"
        : `auto/orchestrator:${input.initiator}`,
    ...(Object.keys(settings).length > 0 && { settings }),
  };

  let response: Response;
  try {
    response = await fetchImpl("/internal/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, message: "daemon unreachable" };
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
    return {
      ok: false,
      message: parsed.success ? parsed.data.error.message : `daemon said ${response.status}`,
    };
  }

  const parsed = RunTaskResultSchema.safeParse(body);
  if (!parsed.success) return { ok: false, message: "unrecognized response from daemon" };
  return { ok: true, value: parsed.data };
}

/**
 * Turn the budget field into the three things it can mean.
 *
 * Empty is "don't send one" — inherit whatever the daemon is configured with,
 * which is not a decision the form should be making on the user's behalf.
 * `0` is refused rather than silently read as uncapped: the route refuses it
 * too, and the way to say uncapped is the word, not the number. Everything
 * else is a positive amount or a typo.
 */
export function parseBudget(text: string): Result<number | null | undefined> {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  if (trimmed.toLowerCase() === "uncapped" || trimmed.toLowerCase() === "none") {
    return { ok: true, value: null };
  }
  const value = Number(trimmed.replace(/^\$/, ""));
  if (!Number.isFinite(value)) return { ok: false, message: "budget must be a number" };
  if (value <= 0)
    return { ok: false, message: "budget must be positive — leave blank, or say 'uncapped'" };
  return { ok: true, value };
}
