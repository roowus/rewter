/**
 * The orchestration engine: the loop that *is* `auto/orchestrator`.
 *
 * Shape, and why it is this shape: `run()` returns `AsyncIterable<StreamChunk>`
 * — the exact type `Router.stream()` returns. An orchestration is therefore
 * indistinguishable from a model call at the HTTP boundary, so both dialect
 * routes, both SSE translators, the `[DONE]` framing, the disconnect handling
 * and `collectStream()` for the non-streaming case all work on it unchanged.
 * The alternative — a bespoke progress channel — would have meant a second
 * implementation of every one of those, kept in sync by hand.
 *
 * Progress goes down that stream as ordinary `text_delta` chunks (see
 * `narrate.ts`), so a client needs no rewter awareness to show it: `curl` sees
 * the feed, and so does Claude Code.
 *
 * Everything the initiator can do to the world goes through a tool call, and
 * every tool call is dispatched in `executeTool` — one place where arguments are
 * validated, one place where a refusal is phrased as a message back to the model
 * rather than an exception. A task must not die because a model passed a number
 * where a string was wanted.
 */
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChatMessage,
  type ModelId,
  type StreamChunk,
  type Task,
  type TaskId,
  type TaskSettings,
  TaskSettingsSchema,
  type ToolCall,
  type Usage,
  type WorkItem,
  type WorkerRunId,
  type WorkerTier,
  newTaskId,
  newWorkItemId,
} from "@rewter/shared";
import type { Repos } from "../db/repos.js";
import type { EventBus } from "../events/bus.js";
import { renderDigest } from "../registry/digest.js";
import { pinnedInitiator } from "../router/resolve.js";
import type { Router } from "../router/router.js";
import { Approvals } from "../workers/approvals.js";
import { createTier2Runner } from "../workers/tier2.js";
import { type Workspace, openWorkspace } from "../workers/workspace.js";
import {
  ANSWER_SEPARATOR,
  approvalLine,
  askUserLine,
  formatCost,
  handoffLine,
  noteLine,
  planLine,
  workerCancelledLine,
  workerDoneLine,
  workerFailedLine,
  workerMessageLine,
  workerNoteLine,
  workerStartLine,
} from "./narrate.js";
import { buildInitiatorMessages } from "./prompt.js";
import { type Limiter, createLimiter } from "./scheduler.js";
import { INITIATOR_TOOL_DEFINITIONS, parseToolArgs } from "./tools.js";
import { type WorkerOutcome, type WorkerRunner, runTier1Worker } from "./worker.js";

export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorError";
  }
}

export interface OrchestratorOptions {
  router: Router;
  repos: Repos;
  bus: EventBus;
  clock?: () => number;
  /**
   * Overrides the runner for **every** tier. Tests use it to intercept spawns;
   * production leaves it unset and gets the tier dispatcher — tier 1 straight to
   * `runTier1Worker`, tier 2 into an agent loop bound to the task's workspace.
   */
  runWorker?: WorkerRunner;
  /**
   * Parent of the per-task tier-2 workspaces. Defaults to a temp directory so a
   * test that spawns tier 2 without saying where does not write into the user's
   * home; the daemon passes the configured path.
   */
  workspacesDir?: string | undefined;
  /** Model that leads when nothing is pinned or configured. */
  defaultInitiatorModel?: string | null;
  /** Printed at the top of the feed so the user can open the task. */
  dashboardUrl?: string | null;
  /** Ceiling on initiator turns — a runaway guard, not a target. */
  maxTurns?: number;
  /** Ceiling on handoffs, so two models cannot pass a task back and forth. */
  maxHandoffs?: number;
  digestMaxTokens?: number;
  /**
   * Per-task settings a request did not specify. The config file's spending cap
   * and concurrency arrive here: without them a configured `maxSpendUsd` would
   * be documented and inert, since a client that says nothing about settings
   * would silently get the schema's uncapped default.
   */
  defaultSettings?: Partial<TaskSettings> | undefined;
}

export interface OrchestrationRequest {
  conversation: ChatMessage[];
  /** The model string the client asked for — carries any `:pin`. */
  requestedModel: string;
  settings?: Partial<TaskSettings> | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Consulted at every turn boundary for messages to inject. This is how a
   * steering follow-up reaches a task that is already mid-flight; see
   * `LiveTask.drainSteering`.
   */
  steering?: (() => string[]) | undefined;
}

/**
 * A task whose row exists and whose id is therefore known, but which has not
 * produced a chunk yet.
 *
 * The split matters because of one HTTP fact: a response header cannot be set
 * once the body has begun. `x-rewter-task-id` is the client's handle for
 * steering and reconnection, so the id has to be knowable *before* the first
 * chunk — which a bare `AsyncIterable` cannot offer, since its body does not
 * run until the first pull.
 */
export interface StartedOrchestration {
  taskId: TaskId;
  /** The task's own controller — cancels the whole worker tree. */
  abort: AbortController;
  stream: AsyncIterable<StreamChunk>;
}

const DEFAULT_MAX_TURNS = 24;
const DEFAULT_MAX_HANDOFFS = 2;
/**
 * Fallback workspace parent. Under `tmpdir()` rather than `~/.rewter` so a test
 * (or an embedder) that never configures one cannot have a worker write into a
 * real home directory by omission.
 */
const DEFAULT_WORKSPACES_DIR = join(tmpdir(), "rewter-workspaces");
/** The initiator plans and stitches; it never needs to emit a long document. */
const INITIATOR_MAX_TOKENS = 4_000;
const DEFAULT_DIGEST_MAX_TOKENS = 4_000;

interface Worker {
  label: string;
  workItem: WorkItem;
  promise: Promise<WorkerOutcome>;
  outcome: WorkerOutcome | null;
  abort: AbortController;
  startedAt: number;
  /**
   * Messages from the initiator the worker has not read yet.
   *
   * Buffered here rather than handed to the runner because `spawn` is allowed to
   * queue behind the concurrency limiter: a message sent to a worker that has
   * not started yet has to survive until its first turn, and the runner does not
   * exist to hold it.
   */
  inbox: string[];
}

export class Orchestrator {
  private readonly opts: OrchestratorOptions;
  private readonly clock: () => number;
  private readonly runWorker: WorkerRunner | null;
  private readonly workspacesDir: string;
  private dashboardUrl: string | null;
  /**
   * Live sessions, so an approval arriving over HTTP can find the in-memory gate
   * its worker is parked on. The row is in the database either way, but the
   * *promise* only exists here — resolving the row alone would leave the worker
   * waiting forever.
   */
  private readonly sessions = new Map<TaskId, Session>();

  constructor(opts: OrchestratorOptions) {
    this.opts = opts;
    this.clock = opts.clock ?? Date.now;
    this.runWorker = opts.runWorker ?? null;
    this.workspacesDir = opts.workspacesDir ?? DEFAULT_WORKSPACES_DIR;
    this.dashboardUrl = opts.dashboardUrl ?? null;
  }

  /**
   * The approval gate of a running task, or null if it is not running here.
   *
   * Null is the ordinary case for a task that finished, or one from before a
   * restart: the pending rows survive but nothing is parked on them, so the
   * caller resolves the row through `repos` and reports that no worker was
   * waiting rather than pretending it unblocked something.
   */
  approvalsFor(taskId: TaskId): Approvals | null {
    return this.sessions.get(taskId)?.gate() ?? null;
  }

  /**
   * Kill a running task: abort its controller and let its own stream finish.
   *
   * Deliberately *only* aborts. The row write is the driving stream's job — it
   * already ends with `transitionTask(…, "cancelled")` and a `⊘ task cancelled`
   * line carrying what was spent. Writing the row here too would race that, and
   * the loser gets `IllegalTransitionError: cancelled → cancelled` thrown into a
   * generator nobody is catching for.
   *
   * Returns false when there is no live session, which is not an error: the task
   * may have finished, or predate a restart. The caller settles the row itself
   * and says which happened — the same honesty `resumedWorker` gives approvals.
   */
  cancel(taskId: TaskId): boolean {
    const session = this.sessions.get(taskId);
    if (session === undefined) return false;
    session.abort();
    return true;
  }

  /**
   * Tell the engine where it is reachable.
   *
   * Separate from the constructor because of a boot ordering fact: the daemon
   * must build the app — and therefore the engine — before it listens, but with
   * `port: 0` the URL is not knowable until the socket is bound. No task can
   * exist in between, so filling it in afterwards is in time for every one.
   */
  setDashboardUrl(url: string | null): void {
    this.dashboardUrl = url;
  }

  /**
   * Choose who leads.
   *
   * Precedence is explicit-beats-implicit: a `:pin` on the request, then the
   * configured default, then a heuristic. The heuristic is "the most expensive
   * enabled model that supports tools" — price is a crude proxy for capability,
   * but it is the only one available before any card is read, and the initiator
   * is exactly where being wrong is most expensive. Ties break on id so the
   * choice is deterministic across restarts.
   *
   * Returns the *canonical* id, not what the caller typed: `resolve` accepts
   * aliases and bare names, and the task row should record what actually ran.
   */
  pickInitiator(requestedModel: string): ModelId {
    const pinned = pinnedInitiator(requestedModel);
    // Resolving here means a bad pin is a clean error before a task row exists.
    if (pinned !== null) return this.opts.router.resolve(pinned).model.id;

    const configured = this.opts.defaultInitiatorModel;
    if (configured !== undefined && configured !== null && configured !== "") {
      return this.opts.router.resolve(configured).model.id;
    }

    // `=== false` is a reported denial and disqualifying; `null` is only silence
    // from a catalog that was an id list, and excluding it would leave a
    // local-Ollama registry with nothing able to lead. Evidence still wins:
    // models known to do tools sort ahead of models nobody has vouched for.
    const best = this.opts.repos
      .listModels({ enabledOnly: true })
      .filter((m) => m.supports.tools !== false)
      .sort((a, b) => {
        const ka = a.supports.tools === true ? 0 : 1;
        const kb = b.supports.tools === true ? 0 : 1;
        const pa = a.pricing.outputPerMTok ?? -1;
        const pb = b.pricing.outputPerMTok ?? -1;
        return ka - kb || pb - pa || a.id.localeCompare(b.id);
      })[0];
    if (best === undefined) {
      throw new OrchestratorError(
        "every enabled model is known not to support tools, so nothing can lead " +
          "an orchestration — " +
          "enable one, or pin an initiator with auto/orchestrator:<model-id>",
      );
    }
    return best.id;
  }

  /**
   * The whole orchestration as one stream — what a plain model call returns,
   * deliberately. Callers that need the task id up front use `start`.
   */
  async *run(req: OrchestrationRequest): AsyncIterable<StreamChunk> {
    yield* this.start(req).stream;
  }

  /**
   * Create the task row and build its stream, without starting it.
   *
   * Everything before the generator — resolving the initiator, parsing settings,
   * writing the row — happens eagerly, so a bad pin or an empty registry throws
   * *here*, while the caller can still send a JSON error. Once the generator is
   * pulled, the only way to report a problem is a text line inside a 200.
   */
  start(req: OrchestrationRequest): StartedOrchestration {
    const initiatorModel = this.pickInitiator(req.requestedModel);
    // Request settings win over configured defaults, which win over the schema's.
    const settings = TaskSettingsSchema.parse({
      ...stripUndefined(this.opts.defaultSettings ?? {}),
      ...stripUndefined(req.settings ?? {}),
    });
    const task = this.createTask(req, initiatorModel, settings);

    // One controller for the whole task; every worker's controller is chained to
    // it, so a client disconnect or a dashboard kill collapses the whole tree
    // rather than leaving orphaned upstream calls billing in the background.
    const taskAbort = new AbortController();
    const onAbort = (): void => taskAbort.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    if (req.signal?.aborted === true) taskAbort.abort();

    const session = new Session({
      task,
      initiatorModel,
      settings,
      router: this.opts.router,
      repos: this.opts.repos,
      bus: this.opts.bus,
      clock: this.clock,
      runWorker: this.runWorker,
      workspacesDir: this.workspacesDir,
      abort: taskAbort,
      maxTurns: this.opts.maxTurns ?? DEFAULT_MAX_TURNS,
      maxHandoffs: this.opts.maxHandoffs ?? DEFAULT_MAX_HANDOFFS,
      digestMaxTokens: this.opts.digestMaxTokens ?? DEFAULT_DIGEST_MAX_TOKENS,
      dashboardUrl: this.dashboardUrl,
      conversation: req.conversation,
      steering: req.steering ?? null,
    });
    this.sessions.set(task.id, session);
    // Also on abort, because a `start()` whose stream is never pulled never runs
    // the `finally` below — and a registry entry for a task nobody is driving
    // would hand HTTP a gate with no worker behind it. `dispose` is idempotent.
    taskAbort.signal.addEventListener(
      "abort",
      () => {
        session.dispose();
        this.sessions.delete(task.id);
      },
      { once: true },
    );

    const sessions = this.sessions;
    async function* stream(): AsyncIterable<StreamChunk> {
      try {
        yield* session.drive();
      } finally {
        req.signal?.removeEventListener("abort", onAbort);
        session.dispose();
        sessions.delete(task.id);
      }
    }

    return { taskId: task.id, abort: taskAbort, stream: stream() };
  }

  private createTask(
    req: OrchestrationRequest,
    initiatorModel: ModelId,
    settings: TaskSettings,
  ): Task {
    const now = this.clock();
    return this.opts.repos.createTask({
      id: newTaskId(),
      status: "pending",
      title: titleFor(req.conversation),
      initiatorModelId: initiatorModel,
      conversationFingerprint: fingerprintConversation(req.conversation),
      settings,
      resultSummary: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    });
  }
}

interface SessionOptions {
  task: Task;
  initiatorModel: ModelId;
  settings: TaskSettings;
  router: Router;
  repos: Repos;
  bus: EventBus;
  clock: () => number;
  /** Null means "use the tier dispatcher"; a value overrides every tier. */
  runWorker: WorkerRunner | null;
  workspacesDir: string;
  abort: AbortController;
  maxTurns: number;
  maxHandoffs: number;
  digestMaxTokens: number;
  dashboardUrl: string | null;
  conversation: ChatMessage[];
  steering: (() => string[]) | null;
}

interface ToolOutcome {
  /** What the model sees as the tool's result. */
  result: string;
  /** Present only for `finish` — ends the loop. */
  answer?: string;
  /** `handoff` replaced the message array; the caller must not append to it. */
  handoff?: boolean;
}

/**
 * One task's run. Split from `Orchestrator` because the engine is per-daemon and
 * this is per-task: keeping the mutable bookkeeping (workers, labels, turn
 * count, handoff depth) in an object with the same lifetime as the task means
 * two concurrent orchestrations cannot see each other's state.
 */
class Session {
  private readonly o: SessionOptions;
  private readonly limiter: Limiter;
  private readonly workers = new Map<string, Worker>();
  private readonly lines = new LineQueue();
  private messages: ChatMessage[];
  private initiatorModel: ModelId;
  private handoffs = 0;
  private nudged = false;
  private budgetWarned = false;
  /**
   * Built on the first tier-2 spawn, not in the constructor: opening a workspace
   * mkdirs a directory, and the overwhelming majority of tasks are pure tier-1
   * fan-outs that would leave an empty directory behind for every one.
   */
  private tier2: { workspace: Workspace; approvals: Approvals; runner: WorkerRunner } | null = null;
  private disposed = false;

  constructor(opts: SessionOptions) {
    this.o = opts;
    this.initiatorModel = opts.initiatorModel;
    this.limiter = createLimiter(opts.settings.concurrency);
    this.messages = this.buildMessages(opts.conversation);
  }

  /** The approval gate, if this task has ever needed one. */
  gate(): Approvals | null {
    return this.tier2?.approvals ?? null;
  }

  /**
   * Collapse the worker tree. The stream sees the aborted signal at its next
   * step and writes the terminal row itself, so nothing here touches the DB.
   */
  abort(): void {
    this.o.abort.abort();
  }

  /**
   * Runner for one work item, chosen by its tier.
   *
   * An explicit `runWorker` wins for every tier — that is the test seam, and a
   * dispatcher that quietly ignored it for tier 2 would make a tier-2 engine test
   * reach the real filesystem.
   */
  private runnerFor(tier: WorkerTier): WorkerRunner {
    if (this.o.runWorker !== null) return this.o.runWorker;
    if (tier === 1) return runTier1Worker;
    return this.openTier2().runner;
  }

  /**
   * Open (once) the workspace and approval gate this task's tier-2 workers share.
   *
   * Shared per task rather than per worker, and that is the point of both: two
   * workers on the same task write to the same directory, and a denial one of
   * them collected is a denial the other should not re-ask for.
   */
  private openTier2(): { workspace: Workspace; approvals: Approvals; runner: WorkerRunner } {
    const existing = this.tier2;
    if (existing !== null) return existing;

    const workspace = openWorkspace({
      taskId: this.o.task.id,
      baseDir: this.o.workspacesDir,
      workspaceDir: this.o.settings.workspaceDir,
    });
    const approvals = new Approvals({
      repos: this.o.repos,
      taskId: this.o.task.id,
      // Read through rather than captured: the user may flip auto-approve in the
      // dashboard while a task is running, and the next gate check should see it.
      autoApprove: () => this.o.settings.autoApprove,
      clock: this.o.clock,
      announce: (approval) => {
        this.lines.push(approvalLine({ approvalId: approval.id, summary: approval.summary }));
      },
    });
    const runner = createTier2Runner({
      workspace,
      approvals,
      onProgress: (note, workItem, workerRunId) => {
        this.lines.push(workerNoteLine({ label: this.labelOf(workItem.id), note }));
        // Also durable: the feed line dies with the stream, and a worker's notes
        // are most wanted precisely when the stream is gone — after a reconnect,
        // or after the restart that interrupted it.
        this.o.bus.append({
          taskId: this.o.task.id,
          payload: { type: "worker_run.progress", workerRunId, text: note },
        });
      },
    });

    const opened = { workspace, approvals, runner };
    this.tier2 = opened;
    // A task cancelled before its first tier-2 worker parks still has to leave a
    // gate that refuses rather than one that waits.
    if (this.disposed || this.o.abort.signal.aborted) approvals.cancel();
    return opened;
  }

  /** `w2` for a work item id, so a worker's own notes carry the feed's name. */
  private labelOf(workItemId: string): string {
    for (const worker of this.workers.values()) {
      if (worker.workItem.id === workItemId) return worker.label;
    }
    return "w?";
  }

  private buildMessages(conversation: ChatMessage[], contextSummary?: string): ChatMessage[] {
    const digest = renderDigest(
      this.o.repos.listModels({ enabledOnly: true }).map((model) => {
        const card = this.o.repos.getCard(model.id);
        return card === undefined ? { model } : { model, card };
      }),
      { maxTokens: this.o.digestMaxTokens },
    );
    const base = buildInitiatorMessages({
      digest,
      conversation,
      taskId: this.o.task.id,
      ...(this.o.dashboardUrl !== null && { dashboardUrl: this.o.dashboardUrl }),
    });
    if (contextSummary === undefined) return base;
    // A successor gets the same core and digest, then its predecessor's summary
    // — not the predecessor's transcript, which is mostly tool plumbing it would
    // pay input tokens to read and cannot act on.
    return [
      ...base,
      {
        role: "user",
        content: [
          "[HANDOFF] A previous initiator handed this task to you. Its summary:",
          "",
          contextSummary,
          "",
          "Continue from here.",
        ].join("\n"),
      },
    ];
  }

  async *drive(): AsyncIterable<StreamChunk> {
    const repos = this.o.repos;
    repos.transitionTask(this.o.task.id, "running");

    let answer: string | null = null;
    let failure: string | null = null;

    try {
      for (let turn = 1; turn <= this.o.maxTurns; turn++) {
        if (this.o.abort.signal.aborted) {
          failure = "cancelled";
          break;
        }

        yield* this.injectSteering();

        const reply = await this.callInitiator();
        yield* this.flush();

        if (reply.error !== null) {
          failure = reply.error;
          break;
        }

        this.messages.push(reply.message);
        const calls = reply.message.toolCalls ?? [];

        if (calls.length === 0) {
          const prose = (reply.message.content ?? "").trim();
          if (!this.nudged && prose !== "") {
            // A model that answered in prose has done the work; it just skipped
            // the tool. One reminder is cheaper than discarding the turn, and
            // cheaper than accepting prose that was actually thinking-aloud.
            this.nudged = true;
            this.messages.push({
              role: "user",
              content:
                "Nothing you write outside a tool call reaches the user. If that was your " +
                "final answer, pass it to `finish`. Otherwise continue with your tools.",
            });
            continue;
          }
          answer = prose === "" ? "(the initiator produced no answer)" : prose;
          break;
        }

        let handedOff = false;
        for (const call of calls) {
          const outcome = yield* this.executeTool(call);
          if (outcome.handoff === true) {
            // `handoff` rebuilt `this.messages` from scratch; appending a tool
            // result here would leave a reply to a call the successor never saw.
            handedOff = true;
            break;
          }
          this.messages.push({
            role: "tool",
            content: outcome.result,
            toolCallId: call.id,
            name: call.name,
          });
          if (outcome.answer !== undefined) {
            answer = outcome.answer;
            break;
          }
        }
        yield* this.flush();
        if (answer !== null) break;
        if (handedOff) continue;

        yield* this.budgetCheck();
      }

      if (answer === null && failure === null) {
        failure = `the initiator did not finish within ${this.o.maxTurns} turns`;
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    // Whatever happened above, no worker may outlive the task.
    this.cancelAllWorkers();
    yield* this.flush();

    const totals = this.totals();
    if (answer !== null) {
      yield chunk(ANSWER_SEPARATOR);
      yield { type: "text_delta", text: answer };
      repos.transitionTask(this.o.task.id, "succeeded", { resultSummary: clampLine(answer, 500) });
      yield { type: "message_end", finishReason: "stop", usage: totals.usage };
      return;
    }

    const cancelled = this.o.abort.signal.aborted;
    repos.transitionTask(this.o.task.id, cancelled ? "cancelled" : "failed", {
      error: failure ?? "cancelled",
    });
    // A failed orchestration still spent money and may have partial results, so
    // it reports as text rather than vanishing into an error frame the client
    // would render as an empty response.
    yield chunk(
      cancelled
        ? `⊘ task cancelled (spent ${formatCost(totals.costUsd)})`
        : `✖ task failed: ${failure ?? "unknown error"} (spent ${formatCost(totals.costUsd)})`,
    );
    yield { type: "message_end", finishReason: cancelled ? "stop" : "error", usage: totals.usage };
  }

  // ── Initiator turn ────────────────────────────────────────────────────────

  private async callInitiator(): Promise<{ message: ChatMessage; error: string | null }> {
    const assembler = new ToolCallAssembler();
    let text = "";
    let error: string | null = null;

    for await (const c of this.o.router.stream(
      {
        model: this.initiatorModel,
        messages: this.messages,
        tools: INITIATOR_TOOL_DEFINITIONS,
        maxTokens: INITIATOR_MAX_TOKENS,
        taskId: this.o.task.id,
      },
      this.o.abort.signal,
    )) {
      switch (c.type) {
        case "text_delta":
          text += c.text;
          break;
        case "tool_call_start":
          assembler.start(c.index, c.id, c.name);
          break;
        case "tool_call_delta":
          assembler.delta(c.index, c.argumentsDelta);
          break;
        case "error":
          error = c.message;
          break;
        default:
          break;
      }
    }

    const toolCalls = assembler.calls();
    return {
      message: {
        role: "assistant",
        content: text === "" ? null : text,
        ...(toolCalls.length > 0 && { toolCalls }),
      },
      error,
    };
  }

  // ── Tool dispatch ─────────────────────────────────────────────────────────

  /**
   * Run one tool call. Yields progress lines as it goes and returns the string
   * the model sees as the tool's result.
   *
   * Nothing in here throws for bad model behaviour — an unknown tool, a bad
   * model id, a tier that does not exist yet and a label that was never spawned
   * are all *results*. The one thing that does end the loop is `finish`.
   */
  private async *executeTool(call: ToolCall): AsyncGenerator<StreamChunk, ToolOutcome> {
    const parsed = parseToolArgs(call.name, call.arguments);
    if (!parsed.ok) return { result: parsed.error };

    switch (call.name) {
      case "plan_note": {
        const { note } = parsed.args as { note: string };
        this.o.bus.append({
          taskId: this.o.task.id,
          payload: { type: "task.plan_note", taskId: this.o.task.id, note },
        });
        yield chunk(planLine(note, this.o.dashboardUrl ?? undefined));
        return { result: "noted" };
      }

      case "spawn_worker": {
        const args = parsed.args as {
          title: string;
          model: string;
          instructions: string;
          tier: WorkerTier;
        };
        if (args.tier === 3) {
          return {
            result: [
              "tier 3 workers (external coding harnesses) are not available yet.",
              "Use tier 2 for anything that needs files or a shell, or do this part yourself.",
            ].join(" "),
          };
        }
        if (this.overBudget()) {
          return {
            result:
              "the task's spending cap has been reached, so no further workers can be started. " +
              "Call `finish` with what you have.",
          };
        }
        // Resolve before spawning so a hallucinated model id is a tool result
        // the initiator can correct, not a worker that fails a second later —
        // and so the work item records the canonical id rather than an alias.
        let modelId: ModelId;
        try {
          modelId = this.o.router.resolve(args.model).model.id;
        } catch (err) {
          return {
            result: [
              `cannot use "${args.model}": ${err instanceof Error ? err.message : String(err)}.`,
              "Choose a model id listed in the registry.",
            ].join(" "),
          };
        }

        const worker = this.spawn({ ...args, model: modelId });
        yield chunk(
          workerStartLine({ label: worker.label, modelId, tier: args.tier, title: args.title }),
        );
        return {
          result: [
            `started as ${worker.label}. It is running in the background;`,
            "call `wait` when you need its result.",
          ].join(" "),
        };
      }

      case "wait": {
        const args = parsed.args as { labels?: string[]; mode: "all" | "any" };
        const selected = this.select(args.labels);
        if ("error" in selected) return { result: selected.error };
        const running = selected.workers.filter((w) => w.outcome === null);
        // "any" asks for the first result available, so a worker that landed
        // before the call already satisfies it. Racing only the *still-running*
        // ones would block on a second result the initiator never asked for.
        const satisfied = args.mode === "any" && running.length < selected.workers.length;
        if (running.length > 0 && !satisfied) yield* this.awaitWorkers(running, args.mode);
        return { result: this.summaryTable(selected.workers) };
      }

      case "get_result": {
        const { label } = parsed.args as { label: string };
        const worker = this.workers.get(label);
        if (worker === undefined) return { result: this.unknownLabel(label) };
        if (worker.outcome === null) {
          return { result: `${label} is still running — call \`wait\` first.` };
        }
        const text = worker.outcome.fullText;
        if (text === null || text === "") {
          return {
            result: `${label} produced no output (${worker.outcome.error ?? "no error recorded"}).`,
          };
        }
        return { result: `Full output of ${label}:\n\n${text}` };
      }

      case "send_to_worker": {
        const { label, message } = parsed.args as { label: string; message: string };
        const worker = this.workers.get(label);
        if (worker === undefined) return { result: this.unknownLabel(label) };
        if (worker.outcome !== null) {
          const advice =
            "Use `get_result` for its output, or spawn a new worker for the follow-up.";
          return { result: `${label} has already finished, so it cannot read this. ${advice}` };
        }
        // Structural, not an omission: a tier-1 worker is one model call with no
        // turn boundary to deliver a message at. Say what to do instead — a
        // refusal the model can act on costs one turn; one it cannot costs the task.
        if (worker.workItem.tier === 1) {
          const advice =
            "Cancel it and spawn a replacement with the fuller instructions, or use tier 2 " +
            "when you expect to steer.";
          return {
            result: `${label} is a tier-1 worker — a single model call, with no point at which it could read a message. ${advice}`,
          };
        }
        worker.inbox.push(message);
        yield chunk(workerMessageLine({ label, message }));
        return { result: `sent to ${label}; it will read this at its next step.` };
      }

      case "cancel_worker": {
        const { label, reason } = parsed.args as { label: string; reason?: string };
        const worker = this.workers.get(label);
        if (worker === undefined) return { result: this.unknownLabel(label) };
        if (worker.outcome !== null) {
          return { result: `${label} had already finished; nothing to cancel.` };
        }
        worker.abort.abort();
        yield chunk(workerCancelledLine({ label, reason }));
        return { result: `${label} cancelled.` };
      }

      case "ask_user": {
        const { question } = parsed.args as { question: string };
        yield chunk(askUserLine(question, this.o.task.id));
        // The question reaches the user, but this run has no channel to carry an
        // answer back — a reply arrives as a *new* request, which is the steering
        // path. Rather than hang the task on a reply that cannot arrive, say so
        // and let the initiator proceed on an assumption.
        return {
          result:
            "the question has been shown to the user, but no reply can reach you during this " +
            "run. State the assumption you are making and continue.",
        };
      }

      case "handoff": {
        const args = parsed.args as { to_model: string; reason: string; context_summary: string };
        if (this.handoffs >= this.o.maxHandoffs) {
          return {
            result: [
              `this task has already been handed off ${this.handoffs} time(s);`,
              "no further handoffs are allowed. Finish the task yourself.",
            ].join(" "),
          };
        }
        // Resolve before the self-handoff check, not after: `resolve` accepts
        // aliases and bare names, so an alias of the current model would slip
        // past a comparison against the raw string and loop the task.
        let target: ModelId;
        try {
          target = this.o.router.resolve(args.to_model).model.id;
        } catch (err) {
          return {
            result: `cannot hand off to "${args.to_model}": ${
              err instanceof Error ? err.message : String(err)
            }.`,
          };
        }
        if (target === this.initiatorModel) {
          return { result: "you are already that model — handing off to yourself would loop." };
        }

        this.handoffs += 1;
        this.o.bus.append({
          taskId: this.o.task.id,
          payload: {
            type: "handoff.initiated",
            taskId: this.o.task.id,
            fromWorkItemId: null,
            toModelId: target,
            reason: args.reason,
          },
        });
        yield chunk(handoffLine({ toModel: target, reason: args.reason }));

        this.initiatorModel = target;
        this.nudged = false;
        this.messages = this.buildMessages(this.o.conversation, args.context_summary);
        return { result: "handed off", handoff: true };
      }

      case "finish": {
        const { answer } = parsed.args as { answer: string };
        return { result: "delivered", answer };
      }

      default:
        return { result: `no such tool "${call.name}".` };
    }
  }

  // ── Workers ───────────────────────────────────────────────────────────────

  private spawn(args: {
    title: string;
    model: ModelId;
    instructions: string;
    tier: WorkerTier;
  }): Worker {
    const now = this.o.clock();
    const workItem = this.o.repos.createWorkItem({
      id: newWorkItemId(),
      taskId: this.o.task.id,
      parentWorkItemId: null,
      status: "pending",
      title: args.title,
      instructions: args.instructions,
      modelId: args.model,
      tier: args.tier,
      resultSummary: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    });

    const label = `w${this.workers.size + 1}`;
    const abort = new AbortController();
    // Chained, not shared: cancelling one worker must not cancel the task, but
    // cancelling the task must cancel every worker.
    this.o.abort.signal.addEventListener("abort", () => abort.abort(), { once: true });
    if (this.o.abort.signal.aborted) abort.abort();

    // Resolved before the limiter, so a tier-2 workspace exists (and its gate is
    // reachable over HTTP) from the moment the worker is queued rather than from
    // whenever a slot frees up.
    const runner = this.runnerFor(args.tier);

    // Shared with the `Worker` record below, so `send_to_worker` appends to the
    // same array the runner drains. `splice(0)` empties it: a message read twice
    // is a worker told twice.
    const inbox: string[] = [];

    const promise = this.limiter.run(async () => {
      this.o.repos.transitionWorkItem(workItem.id, "running");
      const outcome = await runner({
        workItem,
        taskId: this.o.task.id,
        router: this.o.router,
        repos: this.o.repos,
        clock: this.o.clock,
        signal: abort.signal,
        inbox: () => inbox.splice(0),
      });
      this.o.repos.transitionWorkItem(
        workItem.id,
        outcome.status,
        outcome.status === "succeeded"
          ? { resultSummary: outcome.summary }
          : { error: outcome.error ?? "cancelled" },
      );
      return outcome;
    });

    const worker: Worker = {
      label,
      workItem,
      promise,
      outcome: null,
      abort,
      startedAt: now,
      inbox,
    };

    // Settling is where the progress line is produced, so it happens exactly
    // once per worker whether or not the initiator ever calls `wait`.
    promise
      .then((outcome) => {
        worker.outcome = outcome;
        this.lines.push(this.doneLine(worker, outcome));
      })
      .catch((err: unknown) => {
        // A throw here means the *bookkeeping* failed, not the model call —
        // `runTier1Worker` normalizes provider errors into a failed outcome.
        const message = err instanceof Error ? err.message : String(err);
        worker.outcome = {
          status: "failed",
          summary: `failed: ${message}`,
          fullText: null,
          error: message,
          workerRunId: NO_RUN_ID,
          durationMs: this.o.clock() - worker.startedAt,
        };
        this.lines.push(workerFailedLine({ label, error: message }));
      });

    this.workers.set(label, worker);
    return worker;
  }

  private doneLine(worker: Worker, outcome: WorkerOutcome): string {
    if (outcome.status === "failed") {
      return workerFailedLine({ label: worker.label, error: outcome.error ?? "unknown error" });
    }
    if (outcome.status === "cancelled") {
      return workerCancelledLine({ label: worker.label, reason: outcome.error ?? undefined });
    }
    return workerDoneLine({
      label: worker.label,
      costUsd: this.costOf(outcome.workerRunId),
      durationMs: outcome.durationMs,
    });
  }

  /**
   * Wait for workers, streaming their completion lines as they land rather than
   * in one burst afterwards — for a fan-out where one worker takes 20s and two
   * take 3s, the burst version shows a frozen feed for twenty seconds.
   */
  private async *awaitWorkers(
    workers: Worker[],
    mode: "all" | "any",
  ): AsyncGenerator<StreamChunk, void> {
    // Swallow here, not on the stored promise: a rejection is already recorded
    // as a failed outcome by the settle handler, and one escaping `Promise.all`
    // would take the task down with it.
    const promises = workers.map((w) => w.promise.then(noop, noop));
    let settled = false;
    const target = (mode === "any" ? Promise.race(promises) : Promise.all(promises)).then(() => {
      settled = true;
    });

    while (!settled) {
      await Promise.race([target, this.lines.wait()]);
      yield* this.flush();
    }
    yield* this.flush();
  }

  private select(labels?: string[]): { workers: Worker[] } | { error: string } {
    if (labels === undefined || labels.length === 0) {
      const all = [...this.workers.values()];
      if (all.length === 0) {
        return { error: "no workers have been started, so there is nothing to wait for." };
      }
      return { workers: all };
    }
    const workers: Worker[] = [];
    for (const label of labels) {
      const worker = this.workers.get(label);
      if (worker === undefined) return { error: this.unknownLabel(label) };
      workers.push(worker);
    }
    return { workers };
  }

  private unknownLabel(label: string): string {
    const known = [...this.workers.keys()];
    return known.length === 0
      ? `there is no worker ${label} — none have been started.`
      : `there is no worker ${label}. Started so far: ${known.join(", ")}.`;
  }

  /** What `wait` hands back: one line per worker, summaries only. */
  private summaryTable(workers: Worker[]): string {
    return workers
      .map((w) =>
        w.outcome === null
          ? `${w.label}: still running`
          : `${w.label} [${w.outcome.status}]: ${w.outcome.summary}`,
      )
      .join("\n");
  }

  private cancelAllWorkers(): void {
    for (const worker of this.workers.values()) {
      if (worker.outcome === null && !worker.abort.signal.aborted) worker.abort.abort();
    }
  }

  // ── Steering ──────────────────────────────────────────────────────────────

  /**
   * Inject anything a follow-up request queued, at the turn boundary.
   *
   * The boundary is the point: an initiator mid-turn has a tool call in flight
   * and a message list the upstream has already been shown, so splicing a
   * message in there would either be ignored or corrupt the exchange. Waiting
   * costs one turn of latency and keeps the transcript coherent.
   *
   * It goes in as a `user` message because that is what it is — the user spoke.
   * The tag tells the model this arrived mid-task rather than being part of the
   * original request, which is the difference between "also do X" and "you
   * misread the request".
   */
  private *injectSteering(): Generator<StreamChunk, void> {
    const pending = this.o.steering?.() ?? [];
    for (const message of pending) {
      const text = message.trim();
      if (text === "") continue;
      this.messages.push({ role: "user", content: `[USER STEERING] ${text}` });
      // The feed line clamps for display; the log keeps the whole thing. "Did my
      // instruction reach the initiator" needs a durable answer, and the SSE
      // stream is not one — it is gone on reconnect and on restart.
      this.o.bus.append({
        taskId: this.o.task.id,
        payload: { type: "steering.received", taskId: this.o.task.id, text },
      });
      yield chunk(noteLine(`steering: ${clampLine(text, 160)}`));
    }
  }

  // ── Budget ────────────────────────────────────────────────────────────────

  /**
   * The soft guard: one note when spending crosses 80% of the cap, and a
   * stronger one once it is reached. The hard guard is in `spawn_worker`, which
   * refuses outright — a note the model can ignore is not a cap.
   */
  private *budgetCheck(): Generator<StreamChunk, void> {
    const cap = this.o.settings.maxSpendUsd;
    if (cap === null || this.budgetWarned) return;
    const spent = this.totals().costUsd ?? 0;
    if (spent < cap * 0.8) return;
    this.budgetWarned = true;
    const over = spent >= cap;
    this.messages.push({
      role: "user",
      content: [
        `[BUDGET] This task has spent ${formatCost(spent)} of its ${formatCost(cap)} cap.`,
        over
          ? "No further workers can be started. Call `finish` now with what you have."
          : "Wrap up soon.",
      ].join(" "),
    });
    yield chunk(noteLine(`budget: ${formatCost(spent)} of ${formatCost(cap)} spent`));
  }

  private overBudget(): boolean {
    const cap = this.o.settings.maxSpendUsd;
    return cap !== null && (this.totals().costUsd ?? 0) >= cap;
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  /**
   * Task-wide totals, read back from `cost_records` rather than accumulated in
   * memory — the router writes one row per call it makes, so the ledger already
   * has the initiator's turns and every worker's, and a second running total
   * here could only ever disagree with it.
   */
  private totals(): { usage: Usage; costUsd: number | null } {
    const costs = this.o.repos.listCosts(this.o.task.id);
    const usage: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let costUsd = 0;
    for (const c of costs) {
      usage.inputTokens += c.inputTokens;
      usage.outputTokens += c.outputTokens;
      usage.cacheReadTokens += c.cacheReadTokens;
      usage.cacheWriteTokens += c.cacheWriteTokens;
      costUsd += c.costUsd;
    }
    return { usage, costUsd: costs.length === 0 ? null : costUsd };
  }

  private costOf(workerRunId: WorkerRunId): number | null {
    const rows = this.o.repos
      .listCosts(this.o.task.id)
      .filter((c) => c.workerRunId === workerRunId);
    if (rows.length === 0) return null;
    return rows.reduce((sum, c) => sum + c.costUsd, 0);
  }

  private *flush(): Generator<StreamChunk, void> {
    for (const text of this.lines.drain()) yield chunk(text);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelAllWorkers();
    // Cancelling the workers aborts their signals, but a worker parked in
    // `approvals.require` is waiting on a promise, not a signal — without this it
    // would hold the stream open for a click that is never coming.
    this.tier2?.approvals.cancel();
  }
}

/**
 * Stand-in run id for a worker that failed before its run row existed — never
 * matches a `cost_records` row, so `costOf` correctly reports "cost n/a".
 */
const NO_RUN_ID = "wr_none" as WorkerRunId;

/** Every progress line is its own newline-terminated text delta. */
function chunk(text: string): StreamChunk {
  return { type: "text_delta", text: `${text}\n` };
}

function noop(): void {
  /* deliberately empty */
}

/**
 * Reassembles streamed tool calls.
 *
 * Providers deliver arguments in fragments and index them independently of
 * arrival order, so this keys on the index the provider gave rather than on
 * position — an out-of-order delta must land on its own call, not on the last
 * one that happened to start.
 */
class ToolCallAssembler {
  private readonly byIndex = new Map<number, { id: string; name: string; args: string }>();

  start(index: number, id: string, name: string): void {
    this.byIndex.set(index, { id, name, args: "" });
  }

  delta(index: number, argumentsDelta: string): void {
    const existing = this.byIndex.get(index);
    // A delta before its start is malformed. Keeping it under a nameless call
    // means `calls()` drops the call as a unit rather than emitting one with
    // half its arguments, which would be a plausible-looking wrong tool call.
    if (existing === undefined) {
      this.byIndex.set(index, { id: `call_${index}`, name: "", args: argumentsDelta });
      return;
    }
    existing.args += argumentsDelta;
  }

  calls(): ToolCall[] {
    return [...this.byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, c]) => c.name !== "")
      .map(([, c]) => ({ id: c.id, name: c.name, arguments: c.args }));
  }
}

/**
 * A one-way channel for progress lines produced off the generator's own stack —
 * worker completions land in promise callbacks, which cannot yield.
 */
class LineQueue {
  private lines: string[] = [];
  private waiter: (() => void) | null = null;

  push(text: string): void {
    this.lines.push(text);
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  drain(): string[] {
    const out = this.lines;
    this.lines = [];
    return out;
  }

  /** Resolves on the next push — or immediately, if lines are already waiting. */
  wait(): Promise<void> {
    if (this.lines.length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

/** A task needs a title before the model has said anything, so take the request's. */
export function titleFor(conversation: ChatMessage[]): string {
  for (let i = conversation.length - 1; i >= 0; i--) {
    const msg = conversation[i];
    if (msg?.role === "user" && msg.content !== null && msg.content.trim() !== "") {
      return clampLine(msg.content, 120);
    }
  }
  return "orchestration";
}

/**
 * Fingerprint of the conversation *prefix* — everything but the final user
 * message. That is what makes a follow-up recognisable as the same conversation:
 * the client re-POSTs the whole history plus one new turn, so the prefix matches
 * while the full history does not.
 */
export function fingerprintConversation(conversation: ChatMessage[]): string {
  const prefix = conversation.slice(0, Math.max(0, conversation.length - 1));
  const canonical = prefix.map((m) => `${m.role}:${m.content ?? ""}`).join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Drop keys whose value is `undefined`, so a spread cannot shadow a
 * lower-precedence value with nothing. `{...{cap: 1}, ...{cap: undefined}}` is
 * `{cap: undefined}`, which is exactly the bug this exists to prevent.
 */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function clampLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
