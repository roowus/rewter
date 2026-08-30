/**
 * The debug panel's two fetch clients, and the reason they are one file.
 *
 * They answer the same question from opposite ends. `describeRequest` shows
 * what *would* go upstream and costs nothing, so the panel can call it on every
 * keystroke; `chatTest` sends one real completion and reports the bill. Shape
 * versus reality — a request can be perfectly shaped and still be refused by a
 * key that expired, and a model can answer beautifully while the field the
 * client set was silently dropped by a quirk.
 *
 * Like `costs.ts` and `registry.ts`, both parse the daemon's answer rather than
 * trusting it, and both surface the daemon's own `{error: {message}}` verbatim.
 * Here that matters more than anywhere else in the dashboard: "invalid
 * x-api-key" is the entire answer someone pressed Test to get, and "daemon said
 * 401" would send them back to the logs.
 */
import {
  type ChatTestResult,
  ChatTestResultSchema,
  type TranslateDialect,
  type TranslateResponse,
  TranslateResponseSchema,
} from "@rewter/shared";
import { z } from "zod";

export type Result<T> = { ok: true; value: T } | { ok: false; message: string };

const fail = (message: string): Result<never> => ({ ok: false, message });

async function post<T>(
  url: string,
  payload: unknown,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Result<T>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      ...(signal !== undefined && { signal }),
    });
  } catch (cause) {
    // An abort is the panel superseding its own request as the user types, not
    // a failure to report.
    if (cause instanceof DOMException && cause.name === "AbortError") return fail("aborted");
    return fail("daemon unreachable");
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
    return fail(parsed.success ? parsed.data.error.message : `daemon said ${response.status}`);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) return fail("unrecognized response from daemon");
  return { ok: true, value: parsed.data };
}

/**
 * Ask what a request would become. Sends nothing upstream — the daemon's route
 * builds the third stage with a describe-only adapter whose transport throws.
 *
 * `body` is passed through as parsed JSON rather than as text, so the daemon
 * validates with the same schema the real route uses and a rejection here is a
 * rejection there. Which means the panel needs to hand it valid JSON: see
 * `parseBody`.
 */
export async function describeRequest(
  input: { dialect: TranslateDialect; body: unknown },
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Result<TranslateResponse>> {
  return post("/internal/translate", input, TranslateResponseSchema, fetchImpl, signal);
}

/** Send one real prompt to one model. This spends; the result says how much. */
export async function chatTest(
  input: { model: string; prompt: string; maxTokens?: number },
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Result<ChatTestResult>> {
  return post("/internal/chat-test", input, ChatTestResultSchema, fetchImpl, signal);
}

/**
 * Parse the textarea before sending it.
 *
 * The panel is a JSON editor, and a half-typed object is the normal state of
 * one. Catching that here means an unclosed brace reads as "invalid JSON: …" in
 * place, instead of costing a round-trip to be told the same thing less well.
 * A `null` or an array parses fine and is still not a request body, so both are
 * rejected with the same vocabulary the daemon would use.
 */
export function parseBody(text: string): Result<Record<string, unknown>> {
  if (text.trim() === "") return fail("nothing to translate yet");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return fail(`invalid JSON: ${(cause as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("expected a JSON object");
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * A starting request per dialect, so the panel opens on something that works.
 *
 * An empty textarea is a worse first impression than it looks: the panel's
 * whole claim is that the two dialects converge, and you cannot see a
 * convergence you have to type from memory first. These are the smallest
 * request each dialect accepts — note `max_tokens` is required by one and
 * optional in the other, which is itself a difference worth landing on.
 */
export const SAMPLE_BODY: Record<TranslateDialect, string> = {
  openai: JSON.stringify(
    {
      model: "openai/gpt-5",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello" },
      ],
      max_tokens: 100,
    },
    null,
    2,
  ),
  anthropic: JSON.stringify(
    {
      model: "anthropic/claude-sonnet-5",
      system: "be brief",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
    },
    null,
    2,
  ),
};
