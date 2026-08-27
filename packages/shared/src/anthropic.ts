/**
 * Anthropic Messages wire format — the *other* public API shape clients speak.
 *
 * This is not a nicety. Claude Code, the client this project exists to sit
 * under, talks `POST /v1/messages` and nothing else; an OpenAI-only gateway is
 * invisible to it. So `/v1/messages` is a first-class downstream surface
 * alongside `/v1/chat/completions`, translating to the same internal
 * `ChatMessage[]` exactly once, at the edge.
 *
 * Direction matters: `providers/anthropic.ts` translates our internal format
 * *up* to a vendor. This translates a client's request *down* into ours. They
 * look alike and must never be shared — the upstream one may assume Anthropic
 * on both ends, this one may not.
 */
import { z } from "zod";
import type { ChatMessage, FinishReason, ToolDefinition, Usage } from "./chat.js";

/**
 * Request content blocks. `tool_result` and `tool_use` carry the agent loop, so
 * they are parsed properly; `image`/`document`/`thinking` are accepted and
 * dropped (vision routing arrives with the registry in M4) rather than 400'd,
 * which would break a client over a block we merely don't forward yet.
 */
export const AnthropicContentBlockSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z
      .union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))])
      .optional(),
    is_error: z.boolean().optional(),
  }),
  z.object({ type: z.string() }).passthrough(),
]);
export type AnthropicContentBlock = z.infer<typeof AnthropicContentBlockSchema>;

/**
 * `system` is not in Anthropic's documented message roles, but Claude Code puts
 * one *inside* `messages` anyway. Rejecting it 400s a whole session over a role
 * every downstream adapter already understands, so we accept it and keep its
 * position — unlike the top-level `system` parameter, a mid-conversation system
 * turn means something where it sits.
 */
export const AnthropicMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), z.array(AnthropicContentBlockSchema)]),
});
export type AnthropicMessage = z.infer<typeof AnthropicMessageSchema>;

/** `system` is a top-level parameter here, not a message — string or blocks. */
export const AnthropicSystemSchema = z.union([
  z.string(),
  z.array(z.object({ type: z.literal("text"), text: z.string() }).passthrough()),
]);

export const AnthropicToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.unknown()).optional(),
});

export const AnthropicMessagesRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(AnthropicMessageSchema).min(1),
    /** Required by Anthropic, unlike OpenAI's optional max_tokens. */
    max_tokens: z.number().int().positive(),
    system: AnthropicSystemSchema.optional(),
    tools: z.array(AnthropicToolSchema).optional(),
    temperature: z.number().min(0).max(1).optional(),
    stream: z.boolean().optional().default(false),
    metadata: z.object({ user_id: z.string().optional() }).passthrough().optional(),
  })
  // top_p, top_k, stop_sequences, tool_choice, thinking … accepted, not forwarded.
  .passthrough();
export type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequestSchema>;

/** Anthropic's stop reasons. Our internal `error` has no equivalent. */
export type AnthropicStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "refusal";

export function toAnthropicStopReason(reason: FinishReason): AnthropicStopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function toAnthropicUsage(usage: Usage): AnthropicUsage {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cacheReadTokens > 0 && { cache_read_input_tokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens > 0 && { cache_creation_input_tokens: usage.cacheWriteTokens }),
  };
}

/** Flatten a `tool_result`'s content (string or block array) to plain text. */
function flattenToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

/**
 * Anthropic messages → internal `ChatMessage[]`.
 *
 * Not 1:1. A single user turn may carry several `tool_result` blocks, and our
 * format gives each tool response its own message — so this is a flatMap, and a
 * turn that is *only* tool results produces no user message at all.
 */
export function fromAnthropicMessages(
  messages: AnthropicMessage[],
  system?: z.infer<typeof AnthropicSystemSchema>,
): ChatMessage[] {
  const out: ChatMessage[] = [];

  if (system !== undefined) {
    const text = typeof system === "string" ? system : system.map((b) => b.text).join("\n\n");
    if (text !== "") out.push({ role: "system", content: text });
  }

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    const textParts: string[] = [];
    const toolCalls: { id: string; name: string; arguments: string }[] = [];
    const toolResults: ChatMessage[] = [];

    for (const block of msg.content) {
      if (block.type === "text") {
        textParts.push((block as { text: string }).text);
      } else if (block.type === "tool_use") {
        const b = block as { id: string; name: string; input: unknown };
        toolCalls.push({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      } else if (block.type === "tool_result") {
        const b = block as { tool_use_id: string; content?: unknown };
        toolResults.push({
          role: "tool",
          content: flattenToolResult(b.content),
          toolCallId: b.tool_use_id,
        });
      }
      // image / document / thinking: dropped, request otherwise intact.
    }

    // Tool results precede the turn's own text: they answer the *previous*
    // assistant turn, and upstreams that pair calls to results need the order.
    out.push(...toolResults);

    const content = textParts.join("");
    if (content !== "" || toolCalls.length > 0) {
      out.push({
        role: msg.role,
        content: content === "" ? null : content,
        ...(toolCalls.length > 0 && { toolCalls }),
      });
    }
  }

  return out;
}

export function fromAnthropicTools(
  tools: z.infer<typeof AnthropicToolSchema>[] | undefined,
): ToolDefinition[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: t.input_schema ?? { type: "object", properties: {} },
  }));
}

// ── Response envelopes ──────────────────────────────────────────────────────

export type AnthropicResponseBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicResponseBlock[];
  stop_reason: AnthropicStopReason;
  stop_sequence: null;
  usage: AnthropicUsage;
}

/**
 * Streaming events. Anthropic's stream is a *named-event* SSE stream — every
 * frame carries both `event:` and `data:` — where OpenAI's is data-only. The
 * shape below is the union of everything we emit.
 */
export type AnthropicStreamEvent =
  | { type: "message_start"; message: Omit<AnthropicMessageResponse, "content"> & { content: [] } }
  | {
      type: "content_block_start";
      index: number;
      content_block:
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: Record<string, never> };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: AnthropicStopReason; stop_sequence: null };
      usage: AnthropicUsage;
    }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };
