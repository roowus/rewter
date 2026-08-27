/**
 * Unified internal chat format. Provider adapters translate their wire formats
 * to/from these; the router, orchestrator, and workers only ever see this shape.
 */
import { z } from "zod";

export const ChatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Raw JSON string as produced by the model — parse defensively at the call site. */
  arguments: z.string(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string().nullable(),
  toolCalls: z.array(ToolCallSchema).optional(),
  /** For role "tool": which call this responds to. */
  toolCallId: z.string().optional(),
  name: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  /** JSON Schema for the parameters. */
  parameters: z.record(z.unknown()),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
});
export type Usage = z.infer<typeof UsageSchema>;

export const FinishReasonSchema = z.enum([
  "stop",
  "tool_calls",
  "length",
  "content_filter",
  "error",
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

/**
 * Normalized stream chunks. Every adapter must emit exactly:
 *   (text_delta | tool_call_start | tool_call_delta)* → message_end
 * or an `error` chunk terminating the stream. The contract suite enforces this.
 */
export const StreamChunkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta"), text: z.string() }),
  z.object({
    type: z.literal("tool_call_start"),
    index: z.number().int().nonnegative(),
    id: z.string(),
    name: z.string(),
  }),
  z.object({
    type: z.literal("tool_call_delta"),
    index: z.number().int().nonnegative(),
    argumentsDelta: z.string(),
  }),
  z.object({
    type: z.literal("message_end"),
    finishReason: FinishReasonSchema,
    usage: UsageSchema,
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    retryable: z.boolean(),
    statusCode: z.number().int().nullable(),
  }),
]);
export type StreamChunk = z.infer<typeof StreamChunkSchema>;

export const ChatRequestSchema = z.object({
  modelId: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  tools: z.array(ToolDefinitionSchema).optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  stream: z.boolean().default(false),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatResponseSchema = z.object({
  message: ChatMessageSchema,
  finishReason: FinishReasonSchema,
  usage: UsageSchema,
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
