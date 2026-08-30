/**
 * Anthropic adapter — native SDK rather than the OpenAI-compatible shim, so we
 * get cache_control breakpoints (the orchestrator's registry digest depends on
 * them), typed content blocks and real cache-token usage.
 *
 * Two shape differences from OpenAI drive most of this file: the system prompt
 * is a top-level parameter (not a message), and tool results are user-role
 * content blocks (not a `tool` role).
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsStreaming,
  MessageParam,
  TextBlockParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import type { ChatMessage, ChatResponse, StreamChunk, ToolDefinition } from "@rewter/shared";
import { collectStream } from "./collect.js";
import type { AdapterConfig, AdapterRequest, ProviderAdapter, UpstreamRequest } from "./types.js";
import { toErrorChunk } from "./types.js";

/** Anthropic requires max_tokens; this is the fallback when a caller omits it. */
const DEFAULT_MAX_TOKENS = 8192;

export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(config: AdapterConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey ?? "",
      ...(config.baseUrl != null && { baseURL: config.baseUrl }),
      ...(config.fetch !== undefined && { fetch: config.fetch }),
      maxRetries: 0, // Retry policy belongs to the router layer.
    });
  }

  describeRequest(req: AdapterRequest): UpstreamRequest {
    return { kind: this.kind, path: "/v1/messages", body: { ...buildBody(req) } };
  }

  async *stream(req: AdapterRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    try {
      const stream = this.client.messages.stream(buildBody(req), { signal });

      let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      let stopReason: string | null = null;
      let complete = false;
      /** Anthropic indexes every content block; we only surface tool ones. */
      const toolBlocks = new Set<number>();

      for await (const event of stream) {
        switch (event.type) {
          case "message_start":
            usage = mapUsage(event.message.usage);
            break;
          case "content_block_start":
            if (event.content_block.type === "tool_use") {
              toolBlocks.add(event.index);
              yield {
                type: "tool_call_start",
                index: event.index,
                id: event.content_block.id,
                name: event.content_block.name,
              };
            }
            break;
          case "content_block_delta":
            if (event.delta.type === "text_delta" && event.delta.text !== "") {
              yield { type: "text_delta", text: event.delta.text };
            } else if (event.delta.type === "input_json_delta" && toolBlocks.has(event.index)) {
              yield {
                type: "tool_call_delta",
                index: event.index,
                argumentsDelta: event.delta.partial_json,
              };
            }
            break;
          case "message_delta":
            stopReason = event.delta.stop_reason ?? stopReason;
            // Output tokens are only final on message_delta.
            usage = { ...usage, outputTokens: event.usage.output_tokens };
            break;
          case "message_stop":
            complete = true;
            break;
          default:
            break;
        }
      }

      // No message_stop means the connection dropped mid-stream. Reporting a
      // clean message_end here would silently truncate the model's answer.
      if (!complete) {
        yield {
          type: "error",
          message: "stream ended before message_stop",
          retryable: true,
          statusCode: null,
        };
        return;
      }

      yield { type: "message_end", finishReason: mapStopReason(stopReason), usage };
    } catch (err) {
      yield toErrorChunk(err);
    }
  }

  async complete(req: AdapterRequest, signal?: AbortSignal): Promise<ChatResponse> {
    return collectStream(this.stream(req, signal));
  }
}

/**
 * The outbound body, built once and used twice — by `stream()` to send and by
 * `describeRequest()` to show. Typed as the SDK's own parameter object so the
 * display cannot show a shape the wire call would have rejected.
 */
function buildBody(req: AdapterRequest): MessageCreateParamsStreaming {
  const { system, messages } = splitSystem(req.messages, req.cacheUpToMessage);
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
    stream: true,
    ...(system !== undefined && { system }),
    ...(req.tools !== undefined && { tools: req.tools.map(toAnthropicTool) }),
    ...(req.temperature !== undefined && { temperature: req.temperature }),
  };
}

/**
 * Hoist leading system messages into the top-level `system` parameter and
 * convert the rest. `cacheUpToMessage` places a cache_control breakpoint on the
 * last system block, which is where the static core + registry digest live.
 */
function splitSystem(
  messages: ChatMessage[],
  cacheUpToMessage?: number,
): { system?: TextBlockParam[]; messages: MessageParam[] } {
  const systemTexts: string[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    // Only *leading* system messages are hoistable; a later one becomes a user turn.
    if (m.role === "system" && rest.length === 0) {
      if (m.content != null) systemTexts.push(m.content);
    } else {
      rest.push(m);
    }
  }

  const system =
    systemTexts.length === 0
      ? undefined
      : systemTexts.map((text, i) => ({
          type: "text" as const,
          text,
          ...(cacheUpToMessage !== undefined &&
            i === systemTexts.length - 1 && {
              cache_control: { type: "ephemeral" as const },
            }),
        }));

  return { ...(system !== undefined && { system }), messages: toAnthropicMessages(rest) };
}

function toAnthropicMessages(messages: ChatMessage[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const block = {
        type: "tool_result" as const,
        tool_use_id: m.toolCallId ?? "",
        content: m.content ?? "",
      };
      // Anthropic requires consecutive tool results to share one user turn.
      const prev = out.at(-1);
      if (prev?.role === "user" && Array.isArray(prev.content)) {
        prev.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (m.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.content != null && m.content !== "") content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: safeParseArgs(tc.arguments),
        });
      }
      out.push({ role: "assistant", content });
      continue;
    }

    // A system message after the first user turn has nowhere else to go: the
    // Anthropic API has one `system` slot and it is positionally first, so a
    // mid-conversation one can only ride in as a user turn.
    //
    // Tagged rather than demoted silently. The two roles do not mean the same
    // thing — "respond only in JSON from here on" is an instruction *about* the
    // conversation, and delivered bare it reads as the user asking for
    // something, which is weaker and can be argued with. The tag costs nothing
    // and preserves the distinction; it matches how `[USER STEERING]` marks the
    // other message this router splices into a transcript.
    if (m.role === "system") {
      out.push({ role: "user", content: `[SYSTEM] ${m.content ?? ""}` });
      continue;
    }
    out.push({ role: "user", content: m.content ?? "" });
  }
  return out;
}

/** Tool args are model-authored JSON; a malformed string must not throw here. */
function safeParseArgs(args: string): Record<string, unknown> {
  if (args.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return {};
  }
}

function toAnthropicTool(t: ToolDefinition): Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Tool["input_schema"],
  };
}

function mapUsage(u: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}) {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function mapStopReason(reason: string | null): "stop" | "tool_calls" | "length" | "content_filter" {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}
