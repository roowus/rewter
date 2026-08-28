/**
 * The Fastify app: `/v1` (OpenAI-compatible, what clients point at) and
 * `/internal` (localhost ops surface the dashboard uses).
 *
 * Built as a factory returning an un-listened instance so tests can drive it
 * through `app.inject()` — no ports, no teardown races.
 */
import cors from "@fastify/cors";
import {
  type AnthropicMessageResponse,
  AnthropicMessagesRequestSchema,
  type AnthropicResponseBlock,
  type ChatMessage,
  type ChatResponse,
  type OpenAIChatChunk,
  type OpenAIChatCompletion,
  OpenAIChatRequestSchema,
  type OpenAIModelEntry,
  type OpenAIToolCallWire,
  type StreamChunk,
  fromAnthropicMessages,
  fromAnthropicTools,
  toAnthropicStopReason,
  toAnthropicUsage,
  toChatMessages,
  toOpenAIFinishReason,
  toOpenAIUsage,
  toToolDefinitions,
} from "@rewter/shared";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { Repos } from "../db/repos.js";
import type { EventBus } from "../events/bus.js";
import { type Orchestrator, OrchestratorError } from "../orchestrator/engine.js";
import { type LiveTask, LiveTaskIndex, conversationKey } from "../orchestrator/live.js";
import { collectStream } from "../providers/collect.js";
import {
  AmbiguousModelError,
  ModelNotFoundError,
  ProviderDisabledError,
  isOrchestratorModel,
} from "../router/resolve.js";
import type { RouteRequest, Router } from "../router/router.js";
import { AnthropicStreamTranslator } from "./anthropic-stream.js";
import { type StreamFrameContext, roleFrame, toOpenAIChunk } from "./openai-stream.js";
import { SseWriter, type SseWriterOptions } from "./sse.js";

export interface AppOptions {
  router: Router;
  repos: Repos;
  bus: EventBus;
  /** Optional bearer token for `/v1`. Absent = open (localhost-only daemon). */
  apiKey?: string | null;
  logger?: boolean;
  clock?: () => number;
  sse?: SseWriterOptions;
  /**
   * Absent = `auto/orchestrator` still answers 501. The daemon always supplies
   * one; tests that only exercise plain routing need not.
   */
  orchestrator?: Orchestrator | null;
  /** Injectable so tests need not wait out a 30-second grace period. */
  live?: LiveTaskIndex;
}

/** The header carrying the task id back to the client, and back to us. */
export const TASK_ID_HEADER = "x-rewter-task-id";

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const clock = opts.clock ?? Date.now;
  const { router, repos } = opts;
  const orchestrator = opts.orchestrator ?? null;
  const live = opts.live ?? new LiveTaskIndex();

  /**
   * Turn an orchestrator request into a stream to write, resolving it against
   * whatever is already running.
   *
   * Three cases collapse into one return type. A follow-up to a live task is
   * *steering*: its new messages go to the engine and the client attaches to
   * the stream in flight — it does not start a second task, which is what a
   * naive reading of "a new POST" would do and would double the bill. A
   * re-POST with nothing new is a reconnect, and attaches with no injection.
   * Anything else starts a task.
   *
   * Returns the task id so the caller can set the header before writing, which
   * is the only moment it can.
   */
  function beginOrchestration(
    conversation: ChatMessage[],
    requestedModel: string,
    taskIdHeader: string | undefined,
    clientSignal: AbortSignal,
  ): { taskId: string; stream: AsyncIterable<StreamChunk> } {
    if (orchestrator === null) throw new OrchestratorUnavailable();

    const existing = live.match({ taskIdHeader, conversation });
    if (existing !== null) {
      const { task, newMessages } = existing;
      live.cancelGrace(task.taskId);
      for (const m of newMessages) {
        if (m.role === "user" && m.content !== null && m.content.trim() !== "") {
          task.steer(m.content);
        }
      }
      return { taskId: task.taskId, stream: task.subscribe(clientSignal) };
    }

    // The engine needs somewhere to read steering from, and the LiveTask that
    // holds it does not exist until the engine's stream does. The box breaks
    // the cycle: the engine only ever reads it between turns, long after
    // `register` has filled it in.
    let box: LiveTask | null = null;
    // The task row is written here, eagerly, so a bad pin or an empty registry
    // throws while a JSON error is still possible.
    const started = orchestrator.start({
      conversation,
      requestedModel,
      steering: () => box?.drainSteering() ?? [],
    });
    box = live.register({
      taskId: started.taskId,
      key: conversationKey(conversation),
      abort: started.abort,
      source: started.stream,
    });
    return { taskId: started.taskId, stream: box.subscribe(clientSignal) };
  }

  app.register(cors, { origin: true });

  // ── Auth ──────────────────────────────────────────────────────────────────
  // Two header conventions, one token. OpenAI clients send `Authorization:
  // Bearer …`; Anthropic clients (Claude Code among them) send `x-api-key` and
  // never set Authorization at all. Accepting either keeps one configured key
  // working for both surfaces instead of forcing two.
  if (opts.apiKey !== undefined && opts.apiKey !== null && opts.apiKey !== "") {
    const expected = `Bearer ${opts.apiKey}`;
    app.addHook("onRequest", async (req, reply) => {
      if (!req.url.startsWith("/v1/")) return;
      const bearerOk = req.headers.authorization === expected;
      const apiKeyOk = req.headers["x-api-key"] === opts.apiKey;
      if (bearerOk || apiKeyOk) return;
      await (req.url.startsWith("/v1/messages")
        ? reply.code(401).send(anthropicError("authentication_error", "invalid api key"))
        : reply.code(401).send({ error: { message: "invalid api key", type: "auth_error" } }));
    });
  }

  // ── GET /v1/models ────────────────────────────────────────────────────────
  app.get("/v1/models", async () => {
    const models = repos.listModels({ enabledOnly: true });
    const data: OpenAIModelEntry[] = models.map((m) => ({
      id: m.id,
      object: "model",
      created: Math.floor(m.createdAt / 1000),
      owned_by: m.providerId,
    }));
    // The orchestrator must appear in every client's model picker, first.
    data.unshift({
      id: "auto/orchestrator",
      object: "model",
      created: Math.floor(clock() / 1000),
      owned_by: "rewter",
    });
    return { object: "list", data };
  });

  // ── POST /v1/chat/completions ─────────────────────────────────────────────
  app.post("/v1/chat/completions", async (req, reply) => {
    const parsed = OpenAIChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          message: `invalid request: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
          type: "invalid_request_error",
        },
      });
    }
    const body = parsed.data;

    if (isOrchestratorModel(body.model)) {
      const conversation = toChatMessages(body.messages);
      const header = headerValue(req.headers[TASK_ID_HEADER]);
      const id = `chatcmpl-${randomSuffix()}`;
      const created = Math.floor(clock() / 1000);
      const ctx = { id, model: body.model, created };

      if (body.stream) {
        await streamOrchestration(reply, {
          begin: (signal) => beginOrchestration(conversation, body.model, header, signal),
          ctx,
          includeUsage: body.stream_options?.include_usage === true,
          ...(opts.sse !== undefined && { sse: opts.sse }),
        });
        return reply;
      }

      // Non-streaming: fold the whole orchestration into one response. Every
      // progress line is ordinary text, so this is the same fold a plain model
      // call gets — the client just waits longer and sees the narration inline.
      const abort = new AbortController();
      try {
        const begun = beginOrchestration(conversation, body.model, header, abort.signal);
        reply.header(TASK_ID_HEADER, begun.taskId);
        return toCompletion(await collectStream(begun.stream), ctx);
      } catch (err) {
        return reply
          .code(statusForOrchestratorError(err))
          .send({ error: { message: (err as Error).message, type: errorTypeFor(err) } });
      }
    }

    const tools = toToolDefinitions(body.tools);
    const maxTokens = body.max_tokens ?? body.max_completion_tokens;
    const routeReq: RouteRequest = {
      model: body.model,
      messages: toChatMessages(body.messages),
      ...(tools !== undefined && { tools }),
      ...(maxTokens !== undefined && { maxTokens }),
      ...(body.temperature !== undefined && { temperature: body.temperature }),
    };

    // Resolve up front: a bad model name is a clean 404, and after headers go
    // out for a stream there is no status code left to say it with.
    try {
      router.resolve(body.model);
    } catch (err) {
      return reply.code(statusForResolveError(err)).send({
        error: { message: (err as Error).message, type: "invalid_request_error" },
      });
    }

    const id = `chatcmpl-${randomSuffix()}`;
    const created = Math.floor(clock() / 1000);

    if (body.stream) {
      await streamCompletion(reply, {
        router,
        routeReq,
        ctx: { id, model: body.model, created },
        includeUsage: body.stream_options?.include_usage === true,
        ...(opts.sse !== undefined && { sse: opts.sse }),
      });
      return reply;
    }

    try {
      const result = await router.complete(routeReq);
      return toCompletion(result, { id, model: body.model, created });
    } catch (err) {
      return reply.code(statusForUpstreamError(err)).send({
        error: { message: (err as Error).message, type: "upstream_error" },
      });
    }
  });

  // ── POST /v1/messages (Anthropic-native) ──────────────────────────────────
  // Claude Code speaks this and only this. Everything below the parse is the
  // same router call the OpenAI route makes — the two surfaces converge on
  // `ChatMessage[]` at the edge and share one routing, retry and cost path.
  app.post("/v1/messages", async (req, reply) => {
    const parsed = AnthropicMessagesRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          anthropicError(
            "invalid_request_error",
            `invalid request: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
          ),
        );
    }
    const body = parsed.data;

    if (isOrchestratorModel(body.model)) {
      const conversation = fromAnthropicMessages(body.messages, body.system);
      const header = headerValue(req.headers[TASK_ID_HEADER]);
      const id = `msg_${randomSuffix()}`;

      if (body.stream) {
        await streamOrchestrationAnthropic(reply, {
          begin: (signal) => beginOrchestration(conversation, body.model, header, signal),
          ctx: { id, model: body.model },
          ...(opts.sse !== undefined && { sse: opts.sse }),
        });
        return reply;
      }

      const abort = new AbortController();
      try {
        const begun = beginOrchestration(conversation, body.model, header, abort.signal);
        reply.header(TASK_ID_HEADER, begun.taskId);
        return toAnthropicResponse(await collectStream(begun.stream), { id, model: body.model });
      } catch (err) {
        return reply
          .code(statusForOrchestratorError(err))
          .send(anthropicError(errorTypeFor(err), (err as Error).message));
      }
    }

    const tools = fromAnthropicTools(body.tools);
    const routeReq: RouteRequest = {
      model: body.model,
      messages: fromAnthropicMessages(body.messages, body.system),
      maxTokens: body.max_tokens,
      ...(tools !== undefined && { tools }),
      ...(body.temperature !== undefined && { temperature: body.temperature }),
    };

    // Same reason as the OpenAI route: once SSE headers are out there is no
    // status code left to report a bad model name with.
    try {
      router.resolve(body.model);
    } catch (err) {
      return reply
        .code(statusForResolveError(err))
        .send(anthropicError("invalid_request_error", (err as Error).message));
    }

    const id = `msg_${randomSuffix()}`;

    if (body.stream) {
      await streamAnthropic(reply, {
        router,
        routeReq,
        ctx: { id, model: body.model },
        ...(opts.sse !== undefined && { sse: opts.sse }),
      });
      return reply;
    }

    try {
      const result = await router.complete(routeReq);
      return toAnthropicResponse(result, { id, model: body.model });
    } catch (err) {
      return reply
        .code(statusForUpstreamError(err))
        .send(anthropicError("api_error", (err as Error).message));
    }
  });

  // ── /internal ─────────────────────────────────────────────────────────────
  app.get("/internal/health", async () => ({
    status: "ok",
    version: process.env.npm_package_version ?? "0.1.0",
    models: repos.listModels({ enabledOnly: true }).length,
    providers: repos.listProviders({ enabledOnly: true }).length,
  }));

  app.get("/internal/providers", async () =>
    // Only the env var *name* is ever stored, so this is safe to serve as-is.
    ({ providers: repos.listProviders() }),
  );

  app.get("/internal/models", async () => ({ models: repos.listModels() }));

  app.get("/internal/events", async (req) => {
    const q = req.query as { afterSeq?: string; taskId?: string };
    const afterSeq = q.afterSeq === undefined ? 0 : Number.parseInt(q.afterSeq, 10);
    return { events: opts.bus.eventsAfter(Number.isNaN(afterSeq) ? 0 : afterSeq, q.taskId) };
  });

  return app;
}

interface StreamOptions {
  router: Router;
  routeReq: RouteRequest;
  ctx: StreamFrameContext;
  includeUsage: boolean;
  sse?: SseWriterOptions;
}

async function streamCompletion(reply: FastifyReply, opts: StreamOptions): Promise<void> {
  const writer = new SseWriter(reply.raw, opts.sse ?? {});
  // A disconnected client means nobody is waiting for those tokens — and for a
  // paid upstream, continuing to generate them costs real money.
  //
  // Watch the *response*, not the request: `IncomingMessage` emits "close" as
  // soon as the request body has been read, which on any POST is immediately —
  // listening there aborts every stream before its first token. `ServerResponse`
  // emits "close" when the socket goes away (or when we finish, hence the
  // `writableEnded` guard).
  const abort = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableEnded) abort.abort();
  });

  writer.send(roleFrame(opts.ctx));
  try {
    for await (const chunk of opts.router.stream(opts.routeReq, abort.signal)) {
      const frame = toOpenAIChunk(chunk, opts.ctx, { includeUsage: opts.includeUsage });
      if (frame !== null) writer.send(frame);
    }
  } catch (err) {
    const frame: OpenAIChatChunk = {
      ...opts.ctx,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      error: {
        message: err instanceof Error ? err.message : String(err),
        type: "internal_error",
        code: null,
      },
    };
    writer.send(frame);
  }
  writer.done();
  writer.end();
}

interface OrchestrationStreamOptions {
  /** Deferred so the client's abort signal exists before the task attaches. */
  begin: (signal: AbortSignal) => { taskId: string; stream: AsyncIterable<StreamChunk> };
  ctx: StreamFrameContext;
  includeUsage: boolean;
  sse?: SseWriterOptions;
}

/**
 * Stream an orchestration to an OpenAI client.
 *
 * The shape differs from `streamCompletion` in exactly two ways, both forced by
 * the task outliving the request. The abort signal means "this client left",
 * not "cancel the work" — the grace period decides that. And `begin` runs
 * *before* the SSE headers go out, because `x-rewter-task-id` is what the
 * client needs to steer or reconnect, and a header set after the first byte is
 * a header nobody receives.
 */
async function streamOrchestration(
  reply: FastifyReply,
  opts: OrchestrationStreamOptions,
): Promise<void> {
  const gone = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableEnded) gone.abort();
  });

  let stream: AsyncIterable<StreamChunk>;
  try {
    const begun = opts.begin(gone.signal);
    // Before `SseWriter` touches the socket — see above.
    reply.raw.setHeader(TASK_ID_HEADER, begun.taskId);
    stream = begun.stream;
  } catch (err) {
    await reply
      .code(statusForOrchestratorError(err))
      .send({ error: { message: (err as Error).message, type: errorTypeFor(err) } });
    return;
  }

  const writer = new SseWriter(reply.raw, opts.sse ?? {});
  writer.send(roleFrame(opts.ctx));
  try {
    for await (const chunk of stream) {
      const frame = toOpenAIChunk(chunk, opts.ctx, { includeUsage: opts.includeUsage });
      if (frame !== null) writer.send(frame);
    }
  } catch (err) {
    writer.send({
      ...opts.ctx,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      error: {
        message: err instanceof Error ? err.message : String(err),
        type: "internal_error",
        code: null,
      },
    } satisfies OpenAIChatChunk);
  }
  writer.done();
  writer.end();
}

interface AnthropicOrchestrationStreamOptions {
  begin: (signal: AbortSignal) => { taskId: string; stream: AsyncIterable<StreamChunk> };
  ctx: { id: string; model: string };
  sse?: SseWriterOptions;
}

/** The same two departures from `streamAnthropic` as above, for the same reasons. */
async function streamOrchestrationAnthropic(
  reply: FastifyReply,
  opts: AnthropicOrchestrationStreamOptions,
): Promise<void> {
  const gone = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableEnded) gone.abort();
  });

  let stream: AsyncIterable<StreamChunk>;
  try {
    const begun = opts.begin(gone.signal);
    reply.raw.setHeader(TASK_ID_HEADER, begun.taskId);
    stream = begun.stream;
  } catch (err) {
    await reply
      .code(statusForOrchestratorError(err))
      .send(anthropicError(errorTypeFor(err), (err as Error).message));
    return;
  }

  const writer = new SseWriter(reply.raw, opts.sse ?? {});
  const translator = new AnthropicStreamTranslator(opts.ctx);
  const emit = (event: { type: string }): void => writer.sendEvent(event.type, event);

  emit(translator.start());
  try {
    for await (const chunk of stream) {
      for (const event of translator.next(chunk)) emit(event);
    }
  } catch (err) {
    emit({
      type: "error",
      error: { type: "api_error", message: err instanceof Error ? err.message : String(err) },
    } as never);
  }
  for (const event of translator.finishIfOpen()) emit(event);
  writer.end();
}

interface AnthropicStreamOptions {
  router: Router;
  routeReq: RouteRequest;
  ctx: { id: string; model: string };
  sse?: SseWriterOptions;
}

async function streamAnthropic(reply: FastifyReply, opts: AnthropicStreamOptions): Promise<void> {
  const writer = new SseWriter(reply.raw, opts.sse ?? {});
  // Watch the response, not the request — see `streamCompletion` for why that
  // distinction is load-bearing rather than stylistic.
  const abort = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableEnded) abort.abort();
  });

  const translator = new AnthropicStreamTranslator(opts.ctx);
  const emit = (event: { type: string }): void => writer.sendEvent(event.type, event);

  emit(translator.start());
  try {
    for await (const chunk of opts.router.stream(opts.routeReq, abort.signal)) {
      for (const event of translator.next(chunk)) emit(event);
    }
  } catch (err) {
    emit({
      type: "error",
      error: { type: "api_error", message: err instanceof Error ? err.message : String(err) },
    } as never);
  }
  // A stream that died without a terminal chunk still gets a closed message,
  // so a client is never left waiting on a `message_stop` that never comes.
  for (const event of translator.finishIfOpen()) emit(event);
  // No `[DONE]` here: that sentinel is OpenAI's. Anthropic clients stop at
  // `message_stop`, and a stray `data: [DONE]` is an unparseable frame to them.
  writer.end();
}

function toAnthropicResponse(
  result: ChatResponse,
  ctx: { id: string; model: string },
): AnthropicMessageResponse {
  const content: AnthropicResponseBlock[] = [];
  if (result.message.content !== null && result.message.content !== "") {
    content.push({ type: "text", text: result.message.content });
  }
  for (const call of result.message.toolCalls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      // Arguments cross our internal format as a JSON *string*; Anthropic wants
      // the parsed object. A model that emits malformed JSON must not take the
      // whole response down, so an unparseable payload degrades to `{}`.
      input: safeJsonParse(call.arguments),
    });
  }
  return {
    id: ctx.id,
    type: "message",
    role: "assistant",
    model: ctx.model,
    content,
    stop_reason: toAnthropicStopReason(result.finishReason),
    stop_sequence: null,
    usage: toAnthropicUsage(result.usage),
  };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw === "" ? "{}" : raw);
  } catch {
    return {};
  }
}

/** Anthropic's error envelope — `{type: "error", error: {type, message}}`. */
function anthropicError(
  type: string,
  message: string,
): { type: "error"; error: { type: string; message: string } } {
  return { type: "error", error: { type, message } };
}

function toCompletion(result: ChatResponse, ctx: StreamFrameContext): OpenAIChatCompletion {
  const toolCalls: OpenAIToolCallWire[] | undefined = result.message.toolCalls?.map((c) => ({
    id: c.id,
    type: "function" as const,
    function: { name: c.name, arguments: c.arguments },
  }));
  return {
    id: ctx.id,
    object: "chat.completion",
    created: ctx.created,
    model: ctx.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.message.content,
          ...(toolCalls !== undefined && toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        finish_reason: toOpenAIFinishReason(result.finishReason),
      },
    ],
    usage: toOpenAIUsage(result.usage),
  };
}

/**
 * We are a gateway: an upstream that fails is a 502 from where the client sits,
 * whatever status the vendor chose. The exceptions are statuses that describe
 * the *caller's* request (a malformed body, a rejected key, a rate limit) —
 * those are forwarded, because the client is the one who can act on them.
 */
const FORWARDED_UPSTREAM_STATUS = new Set([400, 401, 403, 404, 413, 422, 429]);

function statusForUpstreamError(err: unknown): number {
  const status = (err as { statusCode?: number | null }).statusCode;
  if (typeof status !== "number") return 502;
  return FORWARDED_UPSTREAM_STATUS.has(status) ? status : 502;
}

/** Thrown when a build has no engine wired — a 501 the client can act on. */
class OrchestratorUnavailable extends Error {
  constructor() {
    super("the orchestrator pseudo-model is not enabled on this daemon");
    this.name = "OrchestratorUnavailable";
  }
}

function statusForOrchestratorError(err: unknown): number {
  if (err instanceof OrchestratorUnavailable) return 501;
  // Everything the engine throws before its first chunk is about the request:
  // a pin naming a model that does not exist, or a registry with nothing that
  // can lead. Both are 4xx/503 by the same table plain routing uses.
  if (err instanceof OrchestratorError) return 400;
  return statusForResolveError(err);
}

function errorTypeFor(err: unknown): string {
  if (err instanceof OrchestratorUnavailable) return "not_implemented";
  return "invalid_request_error";
}

/** Fastify hands a repeated header back as an array; take the first. */
function headerValue(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

function statusForResolveError(err: unknown): number {
  if (err instanceof ModelNotFoundError) return 404;
  if (err instanceof AmbiguousModelError) return 400;
  if (err instanceof ProviderDisabledError) return 503;
  return 500;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 14);
}
