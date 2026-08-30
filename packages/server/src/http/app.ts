/**
 * The Fastify app: `/v1` (OpenAI-compatible, what clients point at) and
 * `/internal` (localhost ops surface the dashboard uses).
 *
 * Built as a factory returning an un-listened instance so tests can drive it
 * through `app.inject()` — no ports, no teardown races.
 */
import { existsSync, statSync } from "node:fs";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  type AnthropicMessageResponse,
  AnthropicMessagesRequestSchema,
  type AnthropicResponseBlock,
  type ApprovalId,
  CardOverridesBodySchema,
  type ChatMessage,
  type ChatResponse,
  CostGroupBySchema,
  type DaemonHealth,
  EVENT_TYPES,
  type EventType,
  ModelCreateSchema,
  ModelPatchSchema,
  type OpenAIChatChunk,
  type OpenAIChatCompletion,
  OpenAIChatRequestSchema,
  type OpenAIModelEntry,
  type OpenAIToolCallWire,
  type Provider,
  type ProviderTestResult,
  REWTER_VERSION,
  SocketClientMessageSchema,
  type SocketServerMessage,
  type StreamChunk,
  TASK_TRANSITIONS,
  type TaskId,
  applyModelPatch,
  fromAnthropicMessages,
  fromAnthropicTools,
  isTerminal,
  summarizeCosts,
  toAnthropicStopReason,
  toAnthropicUsage,
  toChatMessages,
  toOpenAIFinishReason,
  toOpenAIUsage,
  toToolDefinitions,
} from "@rewter/shared";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { ZodError } from "zod";
import type { Repos } from "../db/repos.js";
import type { EventBus } from "../events/bus.js";
import { type Orchestrator, OrchestratorError } from "../orchestrator/engine.js";
import { type LiveTask, LiveTaskIndex, conversationKey } from "../orchestrator/live.js";
import { type ApprovalCommand, parseSteering } from "../orchestrator/steering.js";
import { collectStream } from "../providers/collect.js";
import { type ProbeOptions, probeProvider as realProbeProvider } from "../registry/probe.js";
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
  /**
   * The dashboard's built bundle, served at the root. Absent — as in every
   * test — nothing is mounted and `/` 404s like any other unknown route.
   *
   * A path that does not exist is *not* an error: a fresh checkout that has not
   * run `pnpm build` should still boot a working API, because an operator
   * debugging a provider does not also need a UI. The daemon logs why the
   * dashboard is missing instead of refusing to start over it.
   */
  dashboardDir?: string | null;
  /**
   * Facts about the process, for `/internal/health`. The app cannot know these:
   * the database path is resolved during boot, and "started at" means the moment
   * the port was bound, which happens after the app is built. Absent, health
   * still answers — with `url: null`, an unknown db path and this instant as the
   * start time, which is what a test injecting an app has anyway.
   */
  runtime?: {
    startedAt?: number;
    dbPath?: string;
    /** Set after `listen()`, once port 0 has resolved to a real number. */
    url?: string | null;
  };
  /**
   * Where `POST /internal/providers/:id/test` resolves keys from. The app has
   * no other reason to see the environment, and the daemon already holds the
   * one it seeded the registry against — passing that same object is what makes
   * a test answer for the process that would serve the request, rather than for
   * whatever `process.env` happens to hold.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Override the probe itself — the seam tests plug a scripted verdict into,
   * matching `RouterOptions.createAdapter`. Absent, the real one runs, which in
   * a test means a provider with no key set answers `no_key` without touching
   * the network.
   */
  probeProvider?: (provider: Provider, opts: ProbeOptions) => Promise<ProviderTestResult>;
}

/**
 * Ceiling for `?latest=` on `/internal/events`. A window that could name the
 * whole log would let one careless client turn "refresh the table" into a
 * full-log transfer; a local daemon's page of a few hundred rows is already
 * more than a person reads at once.
 */
const MAX_EVENT_PAGE = 500;

/** The header carrying the task id back to the client, and back to us. */
export const TASK_ID_HEADER = "x-rewter-task-id";

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const clock = opts.clock ?? Date.now;
  const { router, repos } = opts;
  const orchestrator = opts.orchestrator ?? null;
  const live = opts.live ?? new LiveTaskIndex();
  /** Fallback for `runtime.startedAt`: an injected app's age is its own. */
  const bootedAt = clock();

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
        if (m.role !== "user" || m.content === null || m.content.trim() === "") continue;
        // A follow-up is allowed to be both an answer to an approval card and an
        // instruction. The parser is what separates them; what is left over —
        // and only what is left over — reaches the initiator, so a line that
        // resolved an approval is not also read as a plan change.
        const { commands, remainder } = parseSteering(m.content);
        for (const command of commands) applyApprovalCommand(task.taskId, command, "in_band");
        if (remainder !== "") task.steer(remainder);
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

  /**
   * Resolve one approval, wherever it lives.
   *
   * Two half-truths have to be reconciled. The *row* is in the database and can
   * always be settled; the *promise* a worker is parked on only exists in this
   * process, inside the engine's session for that task. Resolving the row alone
   * would look like success and leave the worker waiting forever, so the gate is
   * tried first and the row is only touched directly when there is no gate — a
   * task that has finished, or one from before a restart.
   *
   * `parked` is reported rather than hidden: "approved, but nobody was waiting"
   * is a different fact from "approved and the worker resumed", and a user who
   * is told the first one knows to look at why.
   */
  function resolveApproval(
    id: ApprovalId,
    approved: boolean,
    by: "dashboard" | "in_band",
    note: string | null,
  ): { ok: boolean; parked: boolean; reason?: string } {
    const row = repos.getApproval(id);
    if (row === undefined) return { ok: false, parked: false, reason: "no such approval" };
    if (row.status !== "pending") {
      return { ok: false, parked: false, reason: `already ${row.status}` };
    }

    const gate = orchestrator?.approvalsFor(row.taskId) ?? null;
    if (gate !== null) {
      const parked = gate.isParked(id);
      // `resolve` re-checks the row and can still decline — a dashboard click and
      // an in-band reply racing each other is ordinary, not an error.
      if (gate.resolve(id, approved, by, note ?? undefined)) return { ok: true, parked };
      return { ok: false, parked: false, reason: "already resolved" };
    }

    repos.resolveApproval(id, approved ? "approved" : "denied", by, note);
    return { ok: true, parked: false };
  }

  /** Apply one parsed in-band command; unknown or stale ids are ignored quietly. */
  function applyApprovalCommand(
    taskId: TaskId,
    command: ApprovalCommand,
    by: "dashboard" | "in_band",
  ): void {
    const approved = command.decision === "approve";
    if (command.ids === "all") {
      // Deliberately scoped to *this* task's pending rows. "approve all" typed
      // into one conversation must not clear cards belonging to another.
      for (const row of repos.listPendingApprovals(taskId)) {
        resolveApproval(row.id, approved, by, command.note);
      }
      return;
    }
    for (const id of command.ids) resolveApproval(id, approved, by, command.note);
  }

  app.register(cors, { origin: true });
  app.register(websocket);

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
  /**
   * Liveness *and* the ops summary, from one route.
   *
   * The first four fields are load-bearing: `service/control.ts` has read
   * `status`/`version`/`models`/`providers` since M8 to decide whether the thing
   * on the port is rewter, so their names and meanings are frozen — `models` and
   * `providers` stay the *enabled* counts, and the totals live under `registry`.
   * Everything after them is new, and every one of it is something the process
   * already knew and displayed nowhere.
   *
   * Cheap enough to poll: five indexed counts and a `stat`. Nothing here reads a
   * payload or walks the event log.
   */
  app.get("/internal/health", async () => {
    const providersAll = repos.listProviders();
    const modelsAll = repos.listModels();
    const modelsEnabled = modelsAll.filter((m) => m.enabled).length;
    const providersEnabled = providersAll.filter((p) => p.enabled).length;
    const dbPath = opts.runtime?.dbPath ?? "unknown";
    const startedAt = opts.runtime?.startedAt ?? bootedAt;

    const health: DaemonHealth = {
      status: "ok",
      version: REWTER_VERSION,
      models: modelsEnabled,
      providers: providersEnabled,
      // Not `process.uptime()`: that is the runtime's age, and under a launchd
      // KeepAlive restart the two differ by exactly the interval an operator is
      // trying to notice.
      uptimeMs: Math.max(0, clock() - startedAt),
      startedAt,
      pid: process.pid,
      url: opts.runtime?.url ?? null,
      registry: {
        providersTotal: providersAll.length,
        providersEnabled,
        modelsTotal: modelsAll.length,
        modelsEnabled,
        cards: repos.listCards().length,
      },
      db: { path: dbPath, sizeBytes: dbSizeBytes(dbPath) },
      events: opts.bus.stats(),
      tasks: {
        running: repos.listUnfinishedTasks().filter((t) => t.status === "running").length,
        pendingApprovals: repos.listPendingApprovals().length,
      },
    };
    return health;
  });

  app.get("/internal/providers", async () =>
    // Only the env var *name* is ever stored, so this is safe to serve as-is.
    ({ providers: repos.listProviders() }),
  );

  /**
   * Does this provider answer?
   *
   * A named `:id` param is safe here where the registry routes needed a
   * wildcard: a provider id is `prv_` plus twelve characters of `[0-9a-z]`, so
   * it never contains the separator a model id does.
   *
   * POST rather than GET because it reaches out to a third party. It is not a
   * read of rewter's own state, it is not cacheable, and a browser prefetching
   * a link should not be firing requests at seven vendors.
   *
   * Every upstream failure is a 200 carrying a verdict. The status code belongs
   * to *this* request — 404 means rewter has no such provider, and a 502 for a
   * refused key would say the daemon is broken when the answer "your key is
   * wrong" arrived exactly as designed.
   */
  app.post<{ Params: { id: string } }>("/internal/providers/:id/test", async (req, reply) => {
    const provider = repos.getProvider(req.params.id);
    if (provider === undefined) {
      return reply.code(404).send({ error: { message: `unknown provider: ${req.params.id}` } });
    }
    const probe = opts.probeProvider ?? realProbeProvider;
    const result = await probe(provider, {
      ...(opts.env !== undefined && { env: opts.env }),
      clock,
    });
    return reply.send(result);
  });

  // ── Registry ──────────────────────────────────────────────────────────────
  //
  // The editor's surface. Two rules run through all of it.
  //
  // First: editing a *fact* about a model promotes the row to `source:
  // "manual"`, which is what stops the next `sync-models` from putting the
  // upstream's number back. `applyModelPatch` in `shared` decides that, by
  // value, so a form that POSTs every field cannot promote a row just by being
  // saved. Enabling and disabling is exempt — sync never flips `enabled`, and a
  // model toggled off should not lose its price refreshes forever.
  //
  // Second: nothing here caches. `Router` calls `repos.listModels()` per
  // request, so an edit lands on the next call with nothing to invalidate.
  //
  // The routes take the model id as a trailing wildcard rather than a `:id`
  // param because ids are slugs with a slash in them (`anthropic/claude-opus-5`)
  // and a named param stops at the separator — every request would 404. That
  // forces the card-override route onto its own prefix, since a wildcard has to
  // be the last thing in a path.

  app.get("/internal/models", async () => ({
    models: repos.listModels(),
    // The card rides along: the editor shows both on one row, and a second
    // round-trip per model would render prices before rendering what the model
    // is *for* — which is the half that actually steers the orchestrator.
    cards: repos.listCards(),
  }));

  app.post("/internal/models", async (req, reply) => {
    const parsed = ModelCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { message: issues(parsed.error) } });
    const body = parsed.data;

    if (repos.getModel(body.id) !== undefined) {
      // Not an upsert: a POST that silently overwrote a synced row would be a
      // way to edit one without the promotion rule ever running.
      return reply.code(409).send({ error: { message: `model ${body.id} already exists` } });
    }
    if (repos.getProvider(body.providerId) === undefined) {
      // The FK would raise this as a 500 from inside SQLite otherwise.
      return reply.code(400).send({ error: { message: `no such provider: ${body.providerId}` } });
    }

    const now = clock();
    // `source: "manual"` is not taken from the body — a row a human typed is
    // manual by construction, and letting the caller claim `synced` would hand
    // sync permission to overwrite something nothing upstream has heard of.
    const model = repos.upsertModel({ ...body, source: "manual", createdAt: now, updatedAt: now });
    return reply.code(201).send({ model });
  });

  app.patch("/internal/models/*", async (req, reply) => {
    const id = modelIdParam(req.params);
    const existing = repos.getModel(id);
    if (existing === undefined) {
      return reply.code(404).send({ error: { message: `no such model: ${id}` } });
    }

    const parsed = ModelPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { message: issues(parsed.error) } });

    const next = applyModelPatch(existing, parsed.data, clock());
    // `undefined` means nothing actually changed. Returning the row unwritten
    // keeps `updatedAt` honest: it is the column someone reads to work out when
    // a price moved, and a no-op save must not claim an edit.
    if (next === undefined) return { model: existing, changed: false };
    return { model: repos.upsertModel(next), changed: true };
  });

  app.delete("/internal/models/*", async (req, reply) => {
    const id = modelIdParam(req.params);
    if (repos.getModel(id) === undefined) {
      return reply.code(404).send({ error: { message: `no such model: ${id}` } });
    }
    // The card first: it holds a foreign key onto the model, and cost records
    // deliberately do not — history keeps naming a model that is gone, because
    // a spend report that quietly loses rows when a model is retired is worse
    // than one that names something you can no longer route to.
    repos.deleteCard(id);
    repos.deleteModel(id);
    return { deleted: id };
  });

  /**
   * The user's patch over a generated capability card.
   *
   * A separate route from the model because it is a separate lifecycle:
   * `upsertCard` regenerates the generated half and never touches this one, so
   * a card the user corrected survives `rewter card <model>` re-running.
   */
  app.put("/internal/card-overrides/*", async (req, reply) => {
    const id = modelIdParam(req.params);
    const parsed = CardOverridesBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { message: issues(parsed.error) } });
    if (repos.getRawCard(id) === undefined) {
      // Overrides patch a generated card; there is nothing to patch yet.
      return reply
        .code(404)
        .send({ error: { message: `no capability card for ${id} — generate one first` } });
    }
    return { card: repos.setCardOverrides(id, parsed.data.overrides) };
  });

  // ── Approvals ─────────────────────────────────────────────────────────────
  // The dashboard's buttons and `curl` reach the same gate the in-band
  // `approve <id>` reply does — one resolution path, three ways in.
  app.get("/internal/approvals", async (req) => {
    const q = req.query as { taskId?: string };
    const approvals = repos.listPendingApprovals(q.taskId);
    return {
      approvals: approvals.map((a) => ({
        ...a,
        // Whether a worker in *this* process is actually waiting on it. A row
        // left pending by a restart still lists, and says so.
        parked: orchestrator?.approvalsFor(a.taskId)?.isParked(a.id) ?? false,
      })),
    };
  });

  app.post("/internal/approvals/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { approved?: unknown; note?: unknown };
    if (typeof body.approved !== "boolean") {
      return reply.code(400).send({ error: { message: "approved must be a boolean" } });
    }
    if (body.note !== undefined && typeof body.note !== "string") {
      return reply.code(400).send({ error: { message: "note must be a string" } });
    }

    const outcome = resolveApproval(
      id as ApprovalId,
      body.approved,
      "dashboard",
      body.note ?? null,
    );
    if (!outcome.ok) {
      // 404 for an id we have never seen, 409 for one that is settled — the
      // second is a race the caller lost, not a mistake it made.
      const code = outcome.reason === "no such approval" ? 404 : 409;
      return reply.code(code).send({ error: { message: outcome.reason ?? "could not resolve" } });
    }
    return {
      approval: repos.getApproval(id),
      // False here means the row was settled for the audit trail but no worker
      // was released — see `resolveApproval`.
      resumedWorker: outcome.parked,
    };
  });

  // ── Kill ──────────────────────────────────────────────────────────────────
  /**
   * Cancel a task. Two paths, and the response says which one ran.
   *
   * A **live** task is only *aborted* here: its own stream owns the row write
   * and ends with `transitionTask(…, "cancelled")` plus a `⊘ task cancelled`
   * line carrying what was spent. Writing the row from both places races, and
   * the loser throws `cancelled → cancelled` into a generator with no catch.
   * So `aborted: true` means "the tree is collapsing", not "the row says
   * cancelled" — those are milliseconds apart and the second is not ours.
   *
   * A task with **no** live session (finished, or from before a restart) has
   * nothing to abort. If its row is still non-terminal it is a lie a restart
   * left behind, so we settle it; if it is already terminal we report that
   * rather than claiming a kill that killed nothing.
   */
  app.post("/internal/tasks/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = repos.getTask(id);
    if (task === undefined) {
      return reply.code(404).send({ error: { message: `no such task: ${id}` } });
    }

    const aborted = orchestrator?.cancel(id as TaskId) ?? false;
    if (aborted) return { task: repos.getTask(id), aborted: true, alreadyFinished: false };

    if (isTerminal(TASK_TRANSITIONS, task.status)) {
      // 409 rather than 200: the caller asked for something that cannot happen,
      // and a 200 would read as "killed" in a log.
      return reply.code(409).send({
        error: { message: `task is already ${task.status}` },
        task,
        aborted: false,
        alreadyFinished: true,
      });
    }

    return {
      task: repos.transitionTask(id, "cancelled", { error: "cancelled from the dashboard" }),
      aborted: false,
      alreadyFinished: false,
    };
  });

  // ── Costs ─────────────────────────────────────────────────────────────────
  /**
   * `GET /internal/costs?groupBy=model|day|task&since=&until=&tz=`.
   *
   * The bucketing is `summarizeCosts` from `shared` — the same function the
   * dashboard can run over the `cost.recorded` events it already holds. Doing
   * it in SQL here would be a second implementation of the initiator/worker
   * split, and the two would drift the first time one of them was fixed.
   */
  app.get("/internal/costs", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const groupBy = CostGroupBySchema.safeParse(q.groupBy ?? "model");
    if (!groupBy.success) {
      return reply.code(400).send({
        error: { message: `groupBy must be one of: ${CostGroupBySchema.options.join(", ")}` },
      });
    }

    const window: { since?: number; until?: number } = {};
    for (const field of ["since", "until"] as const) {
      const raw = q[field];
      if (raw === undefined) continue;
      const value = Number.parseInt(raw, 10);
      if (Number.isNaN(value)) {
        return reply.code(400).send({ error: { message: `${field} must be a ms timestamp` } });
      }
      window[field] = value;
    }

    // An unknown zone makes `Intl` throw from inside the bucketer, which would
    // surface as a 500 for what is a typo in a query string.
    const timeZone = q.tz ?? "UTC";
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone });
    } catch {
      return reply.code(400).send({ error: { message: `unknown time zone: ${timeZone}` } });
    }

    return summarizeCosts(repos.allCosts(window), { groupBy: groupBy.data, timeZone, ...window });
  });

  // Two questions, one resource. `afterSeq` is the replay cursor: everything
  // after this point, oldest first, unbounded — what a socket resuming wants.
  // `latest` is the inspection window: the newest N events (or the newest N
  // older than `before`), newest-first in effect, with `hasMore` saying whether
  // history continues past the window. Mixing them on one route is deliberate:
  // they are the same log, and two endpoints for one table is how they drift.
  app.get("/internal/events", async (req, reply) => {
    const q = req.query as {
      afterSeq?: string;
      taskId?: string;
      latest?: string;
      before?: string;
      type?: string;
    };
    const taskId = q.taskId === "" ? undefined : q.taskId;

    if (q.latest === undefined) {
      // Replay mode: unchanged since M1. A non-numeric afterSeq reads as 0 —
      // replay is a machine-to-machine contract and tolerant by design.
      const afterSeq = q.afterSeq === undefined ? 0 : Number.parseInt(q.afterSeq, 10);
      return { events: opts.bus.eventsAfter(Number.isNaN(afterSeq) ? 0 : afterSeq, taskId) };
    }

    // Window mode. Every knob is validated rather than defaulted: `latest`
    // names a page size, and a page size that silently became "everything"
    // would turn a table refresh into a full-log transfer.
    const limit = Number.parseInt(q.latest, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE) {
      return reply.code(400).send({
        error: { message: `latest must be an integer between 1 and ${MAX_EVENT_PAGE}` },
      });
    }
    const before = q.before === undefined ? undefined : Number.parseInt(q.before, 10);
    if (before !== undefined && (!Number.isInteger(before) || before < 1)) {
      return reply.code(400).send({ error: { message: "before must be a positive integer" } });
    }
    // Types validate against the union's own members (EVENT_TYPES is derived,
    // not hand-maintained) — a typo'd filter that matched nothing would read
    // as "this never happens", which is worse than a 400 naming the value.
    const types: EventType[] = [];
    for (const raw of (q.type ?? "").split(",")) {
      const t = raw.trim();
      if (t === "") continue;
      if (!EVENT_TYPES.includes(t as EventType)) {
        return reply.code(400).send({ error: { message: `unknown event type: ${t}` } });
      }
      types.push(t as EventType);
    }
    return opts.bus.latestEvents({
      limit,
      ...(before !== undefined && { beforeSeq: before }),
      ...(taskId !== undefined && { taskId }),
      ...(types.length > 0 && { types }),
    });
  });

  // ── WS /internal/ws ───────────────────────────────────────────────────────
  // Replay then live, in one place, so the dashboard never has a gap between
  // "what I fetched" and "what is happening now". See `shared/src/socket.ts`
  // for why the order is replay-first and duplicates are the acceptable seam.
  //
  // Registered inside a `register` callback rather than on `app` directly: the
  // websocket plugin recognizes `websocket: true` through an `onRoute` hook, and
  // `app.register` is deferred to boot, so a root-level route declared here runs
  // its hooks before the plugin has loaded and is served as a plain GET — a 404
  // handshake with no error anywhere. Queuing the route behind the plugin's own
  // register is what orders the two.
  app.register(async (scope) => {
    scope.get("/internal/ws", { websocket: true }, (socket) => {
      let unsubscribe: (() => void) | null = null;

      const send = (message: SocketServerMessage): void => {
        // A socket that closed between the event and this call is normal, not an
        // error worth logging every time a dashboard tab is shut.
        if (socket.readyState !== socket.OPEN) return;
        socket.send(JSON.stringify(message));
      };

      socket.on("message", (raw: unknown) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          send({ type: "error", message: "message must be JSON" });
          return;
        }
        const message = SocketClientMessageSchema.safeParse(parsed);
        if (!message.success) {
          send({ type: "error", message: message.error.issues[0]?.message ?? "invalid message" });
          return;
        }

        // Re-subscribing replaces the previous subscription rather than stacking
        // a second listener — otherwise a client that changed its filter would
        // receive every event twice, forever.
        unsubscribe?.();

        const { afterSeq = 0, taskId } = message.data;
        const replay = opts.bus.eventsAfter(afterSeq, taskId);
        for (const event of replay) send({ type: "event", event });
        send({
          type: "ready",
          seq: replay.at(-1)?.seq ?? afterSeq,
          replayed: replay.length,
          taskId: taskId ?? null,
        });

        // Attached *after* the replay is written. An event appended in between is
        // delivered twice; the fold drops the second by `seq`. The alternative —
        // attaching first — delivers it out of order, which nothing can undo.
        unsubscribe = opts.bus.subscribe((event) => {
          if (taskId !== undefined && event.taskId !== taskId) return;
          send({ type: "event", event });
        });
      });

      socket.on("close", () => {
        unsubscribe?.();
        unsubscribe = null;
      });
    });
  });

  // The dashboard, last: every API route above is already declared, so a static
  // file can never shadow one. Registered only when the bundle is actually
  // there — see `dashboardDir` on the options for why a missing build is a log
  // line rather than a boot failure.
  const dashboardDir = opts.dashboardDir ?? null;
  if (dashboardDir !== null && existsSync(dashboardDir)) {
    app.register(fastifyStatic, { root: dashboardDir });

    // Client-side routing: the dashboard owns its own paths, so a deep link the
    // server has never heard of is the SPA's to resolve, not a 404. API
    // prefixes are excluded explicitly — answering `GET /internal/typo` with a
    // page of HTML would turn a mistyped fetch into a JSON parse error in the
    // caller, which is a much worse thing to debug than a 404.
    app.setNotFoundHandler((request, reply) => {
      const isApi = request.url.startsWith("/v1") || request.url.startsWith("/internal");
      if (request.method !== "GET" || isApi) {
        return reply.code(404).send({ error: { message: "not found", type: "not_found" } });
      }
      return reply.sendFile("index.html");
    });
  }

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

/**
 * The database's footprint on disk, sidecars included.
 *
 * WAL mode keeps recent writes in `-wal` until a checkpoint folds them back, so
 * a busy daemon's main file can sit unchanged while the sidecar grows for hours.
 * Reporting the main file alone would answer "is this getting big?" with a
 * confident no at exactly the moment it is.
 *
 * `null` for `:memory:`, and `null` rather than a throw if the file has gone:
 * an ops panel that 500s because it could not stat something is worse than one
 * that says it does not know.
 */
function dbSizeBytes(path: string): number | null {
  if (path === ":memory:" || path === "unknown") return null;
  let total = 0;
  let found = false;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(`${path}${suffix}`).size;
      found = true;
    } catch {
      // A missing sidecar is normal — they exist only while WAL is active.
    }
  }
  return found ? total : null;
}

/**
 * The model id out of a trailing-wildcard route. Fastify decodes the path, so
 * a client may send `anthropic/x` raw or percent-encoded and land here either
 * way; both name the same row.
 */
function modelIdParam(params: unknown): string {
  return (params as { "*": string })["*"];
}

/**
 * Flatten a zod failure into one line.
 *
 * The path matters more than the message here: the registry schemas are strict,
 * so the common failure is a misspelled field, and `pricing.inputPerMtok
 * Unrecognized key` tells the caller exactly which key to fix while
 * "invalid body" sends them back to the docs.
 */
function issues(error: ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
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
