/**
 * The pass-through router: resolve a model, call its adapter, retry what is
 * worth retrying, and record what it cost.
 *
 * Retry lives here rather than in adapters (which only translate wire formats)
 * because only this layer knows whether anything has been *delivered* yet. A
 * stream that has already emitted text cannot be retried — the client has seen
 * those bytes, and replaying the call would duplicate them. So retry applies to
 * the connection attempt, and stops the moment the first chunk escapes.
 */
import {
  type ChatMessage,
  type ChatResponse,
  type FailurePhase,
  type Model,
  type ModelPricing,
  type StreamChunk,
  type TaskId,
  type ToolDefinition,
  type Usage,
  type WorkerRunId,
  newCostRecordId,
  newFailureRecordId,
} from "@rewter/shared";
import { computeCost } from "../costs/compute.js";
import type { Repos } from "../db/repos.js";
import { collectStream } from "../providers/collect.js";
import { createAdapter, createDescribeOnlyAdapter } from "../providers/factory.js";
import type { AdapterRequest, ProviderAdapter, UpstreamRequest } from "../providers/types.js";
import { type Registry, type Resolution, resolveModel } from "./resolve.js";

export interface RouterOptions {
  repos: Repos;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
  /** Attempts per request, including the first. 1 disables retry. */
  maxAttempts?: number;
  /** Backoff before attempt n (1-based). Injectable so tests don't sleep. */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  /** Override adapter construction — the seam fakes plug into. */
  createAdapter?: (resolution: Resolution) => ProviderAdapter;
}

export interface RouteRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  /** Attributes the cost record to a task; null for plain pass-through calls. */
  taskId?: TaskId | null;
  workerRunId?: WorkerRunId | null;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const defaultBackoff = (attempt: number): number => Math.min(250 * 2 ** (attempt - 1), 4_000);
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class Router {
  private readonly repos: Repos;
  private readonly env: NodeJS.ProcessEnv;
  private readonly clock: () => number;
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly makeAdapter: (resolution: Resolution) => ProviderAdapter;

  constructor(opts: RouterOptions) {
    this.repos = opts.repos;
    this.env = opts.env ?? process.env;
    this.clock = opts.clock ?? Date.now;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = opts.backoffMs ?? defaultBackoff;
    this.sleep = opts.sleep ?? defaultSleep;
    this.makeAdapter =
      opts.createAdapter ??
      ((r) =>
        createAdapter(r.provider, {
          env: this.env,
          ...(opts.fetch !== undefined && { fetch: opts.fetch }),
        }));
  }

  private get registry(): Registry {
    return {
      listModels: (o) => this.repos.listModels(o),
      getProvider: (id) => this.repos.getProvider(id),
    };
  }

  resolve(model: string): Resolution {
    return resolveModel(this.registry, model);
  }

  /**
   * The body this request would put on the wire, without sending it.
   *
   * Routed through here rather than composed at the call site so the debug
   * panel sees the request `stream()` would have built — same resolution, same
   * `toAdapterRequest`. A panel that assembled its own would be describing a
   * request nobody sends, which is the one failure mode worse than no panel.
   */
  describe(req: RouteRequest): { resolution: Resolution; upstream: UpstreamRequest } {
    const resolution = this.resolve(req.model);
    return {
      resolution,
      upstream: createDescribeOnlyAdapter(resolution.provider).describeRequest(
        toAdapterRequest(req, resolution),
      ),
    };
  }

  /**
   * Stream a completion. Retries only while nothing has been emitted; once a
   * chunk is yielded the stream is committed and a later failure is surfaced as
   * a terminal `error` chunk rather than replayed.
   */
  async *stream(req: RouteRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    const resolution = this.resolve(req.model);
    const adapterReq = toAdapterRequest(req, resolution);

    let attempt = 0;
    while (true) {
      attempt += 1;
      const adapter = this.makeAdapter(resolution);
      let emitted = false;
      let usage: Usage | undefined;
      /** The failure this attempt ended on, if it failed before emitting. */
      let failure: Extract<StreamChunk, { type: "error" }> | undefined;

      try {
        for await (const chunk of adapter.stream(adapterReq, signal)) {
          if (chunk.type === "error" && !emitted) {
            // Nothing has reached the client yet, so this attempt is still
            // undecided — retry or surface is settled below, in one place.
            failure = chunk;
            break;
          }
          emitted = true;
          if (chunk.type === "message_end") usage = chunk.usage;
          if (chunk.type === "error") {
            // The one failure retry cannot touch: the client has the bytes.
            // Recorded so its frequency is a fact rather than a guess (#9).
            this.recordFailure(req, resolution, chunk, { attempt, phase: "mid_stream", signal });
          }
          yield chunk;
          if (chunk.type === "message_end" || chunk.type === "error") {
            if (usage !== undefined) this.recordCost(req, resolution.model, usage);
            return;
          }
        }
      } catch (err) {
        // An adapter that throws instead of yielding an error chunk is a bug,
        // but the client still deserves a terminal chunk rather than a hang.
        const thrown: Extract<StreamChunk, { type: "error" }> = {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
          statusCode: null,
        };
        if (emitted || attempt >= this.maxAttempts) {
          this.recordFailure(req, resolution, thrown, {
            attempt,
            phase: emitted ? "mid_stream" : "before_output",
            signal,
          });
          yield thrown;
          return;
        }
        this.recordFailure(req, resolution, thrown, {
          attempt,
          phase: "before_output",
          retried: true,
          signal,
        });
        await this.sleep(this.backoffMs(attempt));
        continue;
      }

      if (emitted) return;

      // A stream that produced nothing at all left no reason behind; treat the
      // silence as retryable rather than concluding the request is hopeless.
      const retryable = failure?.retryable ?? true;
      const willRetry = retryable && attempt < this.maxAttempts;
      this.recordFailure(
        req,
        resolution,
        failure ?? {
          type: "error",
          message: `${resolution.model.id} produced no output`,
          retryable: true,
          statusCode: null,
        },
        { attempt, phase: "before_output", retried: willRetry, signal },
      );
      if (willRetry) {
        await this.sleep(this.backoffMs(attempt));
        continue;
      }

      yield failure === undefined
        ? {
            type: "error",
            message: `${resolution.model.id} produced no output in ${attempt} attempts`,
            retryable: true,
            statusCode: null,
          }
        : {
            ...failure,
            // Keep the upstream's own words — they are what a user can act on —
            // and say how hard we tried, which they cannot see from here.
            message:
              attempt > 1 ? `${failure.message} (after ${attempt} attempts)` : failure.message,
          };
      return;
    }
  }

  /**
   * Non-streaming completion. Folds the same `stream()` rather than calling
   * `adapter.complete()` directly, so retry and cost recording have exactly one
   * implementation and cannot drift between the two request shapes.
   */
  async complete(req: RouteRequest, signal?: AbortSignal): Promise<ChatResponse> {
    return collectStream(this.stream(req, signal));
  }

  /**
   * Write down one failed attempt — including the ones the caller never sees.
   *
   * Every failure the router papers over with a retry is a fact about the
   * upstream that the stream, by design, hides. Issue #9 asks how often a
   * stream dies *after* its first chunk; that cannot be answered from the logs
   * of the client that received the error, only from here, where both kinds are
   * seen side by side.
   *
   * An abort is not recorded: it is the user's decision, not the model's
   * failure, and counting it would inflate exactly the rate this exists to
   * measure. Recording is best-effort — a failing insert must not turn a
   * recoverable upstream error into an unrecoverable one.
   */
  private recordFailure(
    req: RouteRequest,
    resolution: Resolution,
    chunk: Extract<StreamChunk, { type: "error" }>,
    ctx: {
      attempt: number;
      phase: FailurePhase;
      retried?: boolean;
      signal?: AbortSignal | undefined;
    },
  ): void {
    if (ctx.signal?.aborted === true) return;
    try {
      this.repos.recordFailure({
        id: newFailureRecordId(),
        taskId: req.taskId ?? null,
        workerRunId: req.workerRunId ?? null,
        modelId: resolution.model.id,
        providerId: resolution.provider.id,
        attempt: ctx.attempt,
        phase: ctx.phase,
        retried: ctx.retried ?? false,
        retryable: chunk.retryable,
        statusCode: chunk.statusCode,
        message: chunk.message.slice(0, 500),
        createdAt: this.clock(),
      });
    } catch {
      // Instrumentation never gets to be the failure.
    }
  }

  private recordCost(req: RouteRequest, model: Model, usage: Usage): void {
    const pricing: ModelPricing = model.pricing;
    const { totalUsd } = computeCost(usage, pricing);
    this.repos.recordCost({
      id: newCostRecordId(),
      taskId: req.taskId ?? null,
      workerRunId: req.workerRunId ?? null,
      modelId: model.id,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd: totalUsd,
      // Snapshot, not a reference: a later price change must not rewrite history.
      pricingSnapshot: { ...pricing },
      createdAt: this.clock(),
    });
  }
}

function toAdapterRequest(req: RouteRequest, resolution: Resolution): AdapterRequest {
  return {
    model: resolution.upstreamId,
    messages: req.messages,
    ...(req.tools !== undefined && { tools: req.tools }),
    ...(req.maxTokens !== undefined && { maxTokens: req.maxTokens }),
    ...(req.temperature !== undefined && { temperature: req.temperature }),
  };
}
