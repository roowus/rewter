/**
 * The Fastify app: `/v1` (OpenAI-compatible, what clients point at) and
 * `/internal` (localhost ops surface the dashboard uses).
 *
 * Built as a factory returning an un-listened instance so tests can drive it
 * through `app.inject()` — no ports, no teardown races.
 */
import cors from "@fastify/cors";
import {
  type ChatResponse,
  type OpenAIChatChunk,
  type OpenAIChatCompletion,
  OpenAIChatRequestSchema,
  type OpenAIModelEntry,
  type OpenAIToolCallWire,
  toChatMessages,
  toOpenAIFinishReason,
  toOpenAIUsage,
  toToolDefinitions,
} from "@rewter/shared";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { Repos } from "../db/repos.js";
import type { EventBus } from "../events/bus.js";
import {
  AmbiguousModelError,
  ModelNotFoundError,
  ProviderDisabledError,
  isOrchestratorModel,
} from "../router/resolve.js";
import type { RouteRequest, Router } from "../router/router.js";
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
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const clock = opts.clock ?? Date.now;
  const { router, repos } = opts;

  app.register(cors, { origin: true });

  // ── Auth ──────────────────────────────────────────────────────────────────
  if (opts.apiKey !== undefined && opts.apiKey !== null && opts.apiKey !== "") {
    const expected = `Bearer ${opts.apiKey}`;
    app.addHook("onRequest", async (req, reply) => {
      if (!req.url.startsWith("/v1/")) return;
      if (req.headers.authorization !== expected) {
        await reply.code(401).send({ error: { message: "invalid api key", type: "auth_error" } });
      }
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
      // The engine lands in M5; until then the pseudo-model is honest about it
      // rather than silently routing to some arbitrary concrete model.
      return reply.code(501).send({
        error: {
          message: "the orchestrator pseudo-model is not implemented yet (milestone M5)",
          type: "not_implemented",
        },
      });
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

function statusForResolveError(err: unknown): number {
  if (err instanceof ModelNotFoundError) return 404;
  if (err instanceof AmbiguousModelError) return 400;
  if (err instanceof ProviderDisabledError) return 503;
  return 500;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 14);
}
