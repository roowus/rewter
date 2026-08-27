/**
 * OpenAI wire format — the public API shape clients speak, and the translation
 * to/from the internal chat format.
 *
 * This lives in `shared` for the same reason the entities do: it is a contract
 * across a boundary (client ↔ daemon), and the dashboard renders requests it
 * never constructed. Adapters translate *upstream* formats; this translates the
 * *downstream* one, and the two must not be confused — a request arriving as
 * OpenAI JSON is converted to `ChatMessage[]` exactly once, at the edge.
 */
import { z } from "zod";
import type { ChatMessage, FinishReason, ToolCall, ToolDefinition, Usage } from "./chat.js";

/**
 * Content is either a plain string or the multi-part array form. Claude Code
 * and other modern clients send the array form even for pure text, so both must
 * be accepted; non-text parts are dropped with the rest of the request intact
 * (vision routing arrives with the registry in M4).
 */
export const OpenAIContentPartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z
    .object({ type: z.string() })
    .passthrough()
    .transform(() => null),
]);

export const OpenAIContentSchema = z.union([
  z.string(),
  z.array(OpenAIContentPartSchema),
  z.null(),
]);

export const OpenAIToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function").optional(),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

export const OpenAIMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: OpenAIContentSchema.optional(),
  name: z.string().optional(),
  tool_calls: z.array(OpenAIToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
});
export type OpenAIMessage = z.infer<typeof OpenAIMessageSchema>;

export const OpenAIToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
  }),
});

export const OpenAIChatRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(OpenAIMessageSchema).min(1),
    tools: z.array(OpenAIToolSchema).optional(),
    max_tokens: z.number().int().positive().optional(),
    /** Newer OpenAI clients send this instead of max_tokens. */
    max_completion_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    stream: z.boolean().optional().default(false),
    stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
    user: z.string().optional(),
  })
  // Unknown fields (top_p, seed, presence_penalty, …) pass validation rather
  // than 400-ing a client we simply do not forward that knob for yet.
  .passthrough();
export type OpenAIChatRequest = z.infer<typeof OpenAIChatRequestSchema>;

/** OpenAI's own finish reasons. Internal `error` never reaches the wire as one. */
export type OpenAIFinishReason = "stop" | "tool_calls" | "length" | "content_filter";

export function toOpenAIFinishReason(reason: FinishReason): OpenAIFinishReason {
  return reason === "error" ? "stop" : reason;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
}

export function toOpenAIUsage(usage: Usage): OpenAIUsage {
  return {
    prompt_tokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    completion_tokens: usage.outputTokens,
    total_tokens:
      usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens,
    ...(usage.cacheReadTokens > 0 && {
      prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
    }),
  };
}

/** Flatten either content form to a single string; null stays null. */
export function flattenContent(
  content: z.infer<typeof OpenAIContentSchema> | undefined,
): string | null {
  if (content === undefined || content === null) return null;
  if (typeof content === "string") return content;
  const text = content
    .filter((part): part is { type: "text"; text: string } => part !== null)
    .map((part) => part.text)
    .join("");
  return text === "" ? null : text;
}

export function toChatMessages(messages: OpenAIMessage[]): ChatMessage[] {
  return messages.map((m): ChatMessage => {
    // "developer" is OpenAI's rename of "system"; upstreams other than OpenAI
    // have never heard of it, so it is normalized away at the edge.
    const role = m.role === "developer" ? "system" : m.role;
    const toolCalls: ToolCall[] | undefined = m.tool_calls?.map((c) => ({
      id: c.id,
      name: c.function.name,
      arguments: c.function.arguments,
    }));
    return {
      role,
      content: flattenContent(m.content),
      ...(toolCalls !== undefined && toolCalls.length > 0 && { toolCalls }),
      ...(m.tool_call_id !== undefined && { toolCallId: m.tool_call_id }),
      ...(m.name !== undefined && { name: m.name }),
    };
  });
}

export function toToolDefinitions(
  tools: z.infer<typeof OpenAIToolSchema>[] | undefined,
): ToolDefinition[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    parameters: t.function.parameters ?? { type: "object", properties: {} },
  }));
}

// ── Response envelopes ──────────────────────────────────────────────────────

export interface OpenAIChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCallWire[] };
    finish_reason: OpenAIFinishReason;
  }>;
  usage: OpenAIUsage;
}

export interface OpenAIToolCallWire {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: OpenAIFinishReason | null;
  }>;
  usage?: OpenAIUsage;
  /**
   * Not part of OpenAI's schema. Our stream contract allows a terminal `error`
   * chunk, and once SSE headers are sent there is no status code left to carry
   * it — so the failure rides on the final frame. Clients that ignore unknown
   * fields still see a well-formed termination.
   */
  error?: { message: string; type: string; code: number | null };
}

export interface OpenAIModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}
