/**
 * Google (Gemini) adapter. Three shape differences drive this file: roles are
 * `user`/`model` (no system role — it goes in systemInstruction), messages are
 * `contents` with `parts`, and function calls arrive as whole objects rather
 * than streamed argument deltas — so we synthesize one tool_call_delta with the
 * complete JSON to keep the normalized contract uniform.
 */
import { GoogleGenAI } from "@google/genai";
import type { ChatMessage, ChatResponse, StreamChunk, ToolDefinition } from "@rewter/shared";
import { collectStream } from "./collect.js";
import type { AdapterConfig, AdapterRequest, ProviderAdapter, UpstreamRequest } from "./types.js";
import { toErrorChunk } from "./types.js";

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export class GoogleAdapter implements ProviderAdapter {
  readonly kind = "google" as const;
  private readonly client: GoogleGenAI;

  constructor(config: AdapterConfig) {
    this.client = new GoogleGenAI({
      apiKey: config.apiKey ?? "",
      ...(config.baseUrl != null && { httpOptions: { baseUrl: config.baseUrl } }),
    });
  }

  describeRequest(req: AdapterRequest): UpstreamRequest {
    // `:streamGenerateContent` is on the model, not a fixed path — the id is
    // part of the URL here where the other two carry it in the body.
    return {
      kind: this.kind,
      path: `/v1beta/models/${req.model}:streamGenerateContent`,
      body: { ...buildBody(req) },
    };
  }

  async *stream(req: AdapterRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    try {
      const base = buildBody(req);
      const stream = await this.client.models.generateContentStream({
        ...base,
        contents: base.contents as never,
        // The abort signal is transport, not request shape: it belongs to this
        // call and has no business in a body someone is reading.
        config: { ...base.config, ...(signal !== undefined && { abortSignal: signal }) },
      });

      let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      let finishReason: string | null = null;
      let toolIndex = 0;
      let sawToolCall = false;

      for await (const chunk of stream) {
        const meta = chunk.usageMetadata;
        if (meta != null) {
          usage = {
            inputTokens: meta.promptTokenCount ?? 0,
            outputTokens: meta.candidatesTokenCount ?? 0,
            cacheReadTokens: meta.cachedContentTokenCount ?? 0,
            cacheWriteTokens: 0,
          };
        }

        const candidate = chunk.candidates?.[0];
        if (candidate == null) continue;
        if (candidate.finishReason != null) finishReason = String(candidate.finishReason);

        for (const part of candidate.content?.parts ?? []) {
          if (typeof part.text === "string" && part.text !== "") {
            yield { type: "text_delta", text: part.text };
          }
          const call = part.functionCall;
          if (call != null) {
            const index = toolIndex++;
            sawToolCall = true;
            // Gemini has no call ids; synthesize a stable one for the loop.
            yield {
              type: "tool_call_start",
              index,
              id: call.id ?? `gemini_call_${index}`,
              name: call.name ?? "",
            };
            yield {
              type: "tool_call_delta",
              index,
              argumentsDelta: JSON.stringify(call.args ?? {}),
            };
          }
        }
      }

      // No finishReason means the connection dropped mid-stream. Reporting a
      // clean message_end here would silently truncate the model's answer.
      if (finishReason === null) {
        yield {
          type: "error",
          message: "stream ended without finishReason",
          retryable: true,
          statusCode: null,
        };
        return;
      }

      yield {
        type: "message_end",
        finishReason: mapFinishReason(finishReason, sawToolCall),
        usage,
      };
    } catch (err) {
      yield toErrorChunk(err);
    }
  }

  async complete(req: AdapterRequest, signal?: AbortSignal): Promise<ChatResponse> {
    return collectStream(this.stream(req, signal));
  }
}

/**
 * The outbound call as an object, built once for both `stream()` and the
 * dialect panel. Gemini takes `contents` and `config` as siblings, so this is
 * nested where the other two adapters are flat — the panel shows the shape as
 * it is rather than flattening it into a lie about the API.
 */
function buildBody(req: AdapterRequest) {
  const { systemInstruction, contents } = splitSystem(req.messages);
  return {
    model: req.model,
    contents,
    config: {
      ...(systemInstruction !== undefined && { systemInstruction }),
      ...(req.maxTokens !== undefined && { maxOutputTokens: req.maxTokens }),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      ...(req.tools !== undefined && {
        tools: [{ functionDeclarations: req.tools.map(toGeminiTool) }],
      }),
    },
  };
}

function splitSystem(messages: ChatMessage[]): {
  systemInstruction?: string;
  contents: GeminiContent[];
} {
  const systemTexts: string[] = [];
  const contents: GeminiContent[] = [];

  for (const m of messages) {
    if (m.role === "system" && contents.length === 0) {
      if (m.content != null) systemTexts.push(m.content);
      continue;
    }

    if (m.role === "tool") {
      const part: GeminiPart = {
        functionResponse: {
          name: m.name ?? m.toolCallId ?? "tool",
          response: { output: m.content ?? "" },
        },
      };
      const prev = contents.at(-1);
      if (prev?.role === "user") prev.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
      continue;
    }

    if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (m.content != null && m.content !== "") parts.push({ text: m.content });
      for (const tc of m.toolCalls ?? []) {
        parts.push({ functionCall: { name: tc.name, args: safeParseArgs(tc.arguments) } });
      }
      contents.push({ role: "model", parts });
      continue;
    }

    contents.push({ role: "user", parts: [{ text: m.content ?? "" }] });
  }

  return {
    ...(systemTexts.length > 0 && { systemInstruction: systemTexts.join("\n\n") }),
    contents,
  };
}

/** Tool args are model-authored JSON; a malformed string must not throw here. */
function safeParseArgs(args: string): Record<string, unknown> {
  if (args.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toGeminiTool(t: ToolDefinition) {
  return { name: t.name, description: t.description, parameters: t.parameters as never };
}

/**
 * Gemini reports STOP even on a turn that is entirely function calls — there is
 * no `tool_calls` finish reason on the wire. The caller needs to know it must
 * run tools, so a seen function call outranks a plain STOP.
 */
function mapFinishReason(
  reason: string | null,
  sawToolCall: boolean,
): "stop" | "tool_calls" | "length" | "content_filter" {
  switch (reason) {
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
      return "content_filter";
    default:
      return sawToolCall ? "tool_calls" : "stop";
  }
}
