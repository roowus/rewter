/**
 * OpenAI-compatible adapter. One class, six upstreams — OpenAI, OpenRouter,
 * xAI, Z.AI/GLM, Ollama and LM Studio all speak this wire format; they are
 * distinguished by `baseUrl` + `Quirks`, never by subclassing.
 */
import type { ChatMessage, ChatResponse, StreamChunk, ToolDefinition } from "@rewter/shared";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { collectStream } from "./collect.js";
import type {
  AdapterConfig,
  AdapterRequest,
  ProviderAdapter,
  Quirks,
  UpstreamRequest,
} from "./types.js";
import { toErrorChunk } from "./types.js";

export class OpenAICompatAdapter implements ProviderAdapter {
  readonly kind = "openai-compat" as const;
  private readonly client: OpenAI;
  private readonly quirks: Quirks;

  constructor(config: AdapterConfig) {
    this.quirks = config.quirks ?? {};
    this.client = new OpenAI({
      // Local runtimes accept any non-empty key; upstreams that need a real one
      // fail loudly at call time rather than silently sending "".
      apiKey: config.apiKey ?? "not-needed",
      ...(config.baseUrl != null && { baseURL: config.baseUrl }),
      ...(config.fetch !== undefined && { fetch: config.fetch }),
      maxRetries: 0, // Retry policy belongs to the router layer.
    });
  }

  describeRequest(req: AdapterRequest): UpstreamRequest {
    // Shown with `stream: true` and the usage option, because that is what the
    // router actually sends — a body displayed without them would be a request
    // this adapter never makes.
    return { kind: this.kind, path: "/chat/completions", body: { ...this.streamBody(req) } };
  }

  async *stream(req: AdapterRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    try {
      const stream = await this.client.chat.completions.create(this.streamBody(req), { signal });

      /** Upstream tool-call index → whether we've emitted its start chunk yet. */
      const started = new Set<number>();
      let finishReason: string | null = null;
      let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      let sawUsage = false;

      for await (const part of stream) {
        // The usage-only final chunk carries no choices.
        if (part.usage != null) {
          usage = mapUsage(part.usage);
          sawUsage = true;
        }
        const choice = part.choices[0];
        if (choice === undefined) continue;

        const delta = choice.delta;
        if (typeof delta?.content === "string" && delta.content !== "") {
          yield { type: "text_delta", text: delta.content };
        }

        for (const tc of delta?.tool_calls ?? []) {
          const index = tc.index;
          if (!started.has(index)) {
            // Some upstreams split the name across the first two deltas; the
            // id+name always arrive together on the opening delta in practice.
            if (tc.id != null || tc.function?.name != null) {
              started.add(index);
              yield {
                type: "tool_call_start",
                index,
                id: tc.id ?? `call_${index}`,
                name: tc.function?.name ?? "",
              };
            }
          }
          const args = tc.function?.arguments;
          if (typeof args === "string" && args !== "") {
            yield { type: "tool_call_delta", index, argumentsDelta: args };
          }
        }

        if (choice.finish_reason != null) finishReason = choice.finish_reason;
      }

      // No finish_reason means the connection dropped mid-stream. Reporting a
      // clean message_end here would silently truncate the model's answer.
      if (finishReason === null) {
        yield {
          type: "error",
          message: "stream ended without finish_reason",
          retryable: true,
          statusCode: null,
        };
        return;
      }
      // Ollama/LM Studio may never send usage; treating that as a broken stream
      // would make local models unusable, so zeros are accepted for them only.
      if (!sawUsage && this.quirks.usageOptional !== true) {
        yield {
          type: "error",
          message: "stream ended without usage",
          retryable: true,
          statusCode: null,
        };
        return;
      }

      yield { type: "message_end", finishReason: mapFinishReason(finishReason), usage };
    } catch (err) {
      yield toErrorChunk(err);
    }
  }

  async complete(req: AdapterRequest, signal?: AbortSignal): Promise<ChatResponse> {
    return collectStream(this.stream(req, signal));
  }

  /** The streaming body, built once and used by both `stream()` and the panel. */
  private streamBody(req: AdapterRequest) {
    return {
      ...this.body(req),
      stream: true as const,
      ...(this.quirks.noStreamOptions !== true && {
        stream_options: { include_usage: true },
      }),
    };
  }

  private body(req: AdapterRequest) {
    const tokens = req.maxTokens;
    return {
      model: req.model,
      messages: req.messages.map(toOpenAIMessage),
      ...(req.tools !== undefined && { tools: req.tools.map(toOpenAITool) }),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      ...(tokens !== undefined &&
        (this.quirks.maxCompletionTokens === true
          ? { max_completion_tokens: tokens }
          : { max_tokens: tokens })),
    };
  }
}

function toOpenAIMessage(m: ChatMessage): ChatCompletionMessageParam {
  if (m.role === "tool") {
    return { role: "tool", content: m.content ?? "", tool_call_id: m.toolCallId ?? "" };
  }
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.content,
      ...(m.toolCalls !== undefined && {
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      }),
    };
  }
  return { role: m.role, content: m.content ?? "" };
}

function toOpenAITool(t: ToolDefinition): ChatCompletionTool {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

function mapUsage(u: {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
}) {
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cacheReadTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    // No OpenAI-compatible upstream reports cache *writes* separately.
    cacheWriteTokens: 0,
  };
}

function mapFinishReason(
  reason: string | null,
): "stop" | "tool_calls" | "length" | "content_filter" {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}
