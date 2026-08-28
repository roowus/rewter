/**
 * Tier-2 workers: an agent loop with tools.
 *
 * Same `WorkerRunner` shape as tier 1, so the engine's `spawn` needs no case
 * analysis — but where tier 1 is one call, this is a conversation, and everything
 * awkward about it comes from the model being an unreliable participant in that
 * conversation. Four decisions carry the weight:
 *
 * 1. **The loop terminates on `finish_report`, and nothing else.** A model that
 *    stops calling tools and writes prose instead gets exactly one nudge; if it
 *    does it twice, that prose becomes the report rather than the run failing on
 *    a formality. The work may well be done — refusing to read it would throw
 *    away tokens the user already paid for.
 * 2. **A repeated denied call is answered from memory, not re-gated.** The
 *    prompt tells the worker not to retry a refusal, and prompts are advisory.
 *    Re-running `approvals.require` for a call the user already denied would put
 *    the same card in front of them again, so a fingerprint of every denied call
 *    is kept and a repeat is short-circuited with the original reason. The user
 *    is asked once per distinct request.
 * 3. **`report_progress` and `finish_report` are implemented here, not in
 *    `execute.ts`.** Neither touches the disk: one writes to the user's feed and
 *    one ends the run, and both are the loop's business. `execute.ts` stays the
 *    module where every filesystem-reaching tool lives, which is what makes it
 *    auditable as a list.
 * 4. **A tool call is never a throw.** `parseWorkerArgs` failures, unknown
 *    tools, denials and exceptions all become `role: "tool"` messages, because
 *    the only way a model fixes a mistake is by being told about it in a turn it
 *    can respond to.
 *
 * The lifecycle rules from tier 1 apply unchanged: `created → streaming →
 * succeeded | failed | cancelled`, with no shortcut, or the repo write throws.
 */
import {
  type ChatMessage,
  type ChatResponse,
  type ToolCall,
  type WorkItem,
  type WorkerRun,
  newWorkerRunId,
} from "@rewter/shared";
import { buildTier2Messages } from "../orchestrator/prompt.js";
import type { WorkerContext, WorkerOutcome, WorkerRunner } from "../orchestrator/worker.js";
import type { Approvals } from "./approvals.js";
import {
  type ExecuteContext,
  type ToolResult,
  editFileTool,
  globTool,
  grepTool,
  listDirTool,
  readFileTool,
  shellTool,
  webFetchTool,
  writeFileTool,
} from "./execute.js";
import { WORKER_TOOL_DEFINITIONS, parseWorkerArgs } from "./tools.js";
import type { Workspace } from "./workspace.js";

/**
 * Runaway guard, not a target. A subtask that needs more than this many model
 * calls was decomposed wrong, and the interesting failure is the one where a
 * worker loops on the same broken command until the budget is gone.
 */
const DEFAULT_MAX_TURNS = 16;
/** Per-call cap. Tier-2 replies are mostly tool calls, so they are short. */
const DEFAULT_MAX_TOKENS = 4_000;
/** The summary the initiator reads back from `wait`. Matches tier 1's cap. */
const SUMMARY_MAX_CHARS = 300;

export interface Tier2Options {
  /** Where the worker's paths resolve, and which writes need no approval. */
  workspace: Workspace;
  /** The one gate. Shared per task, so denials are remembered across workers. */
  approvals: Approvals;
  /** Injected so `web_fetch` tests need no network. */
  fetchImpl?: typeof fetch | undefined;
  /**
   * A `report_progress` note, for the user's live feed. The `workItem` comes
   * along because the engine labels lines by worker (`▶ [w2] …`) and only it
   * knows the labels.
   */
  onProgress?: ((note: string, workItem: WorkItem) => void) | undefined;
  maxTurns?: number | undefined;
  maxTokens?: number | undefined;
}

/**
 * Build a tier-2 runner bound to one task's workspace and approval gate.
 *
 * A factory rather than a bare function because those two are per-task while
 * `WorkerRunner` is per-work-item: the engine makes one of these when it opens a
 * session and hands the same runner to every tier-2 worker on the task.
 */
export function createTier2Runner(opts: Tier2Options): WorkerRunner {
  return (ctx) => runTier2Worker(ctx, opts);
}

export async function runTier2Worker(
  ctx: WorkerContext,
  opts: Tier2Options,
): Promise<WorkerOutcome> {
  const startedAt = ctx.clock();
  const run = createRun(ctx);
  const done = (
    status: WorkerOutcome["status"],
    fields: { summary: string; fullText: string | null; error: string | null },
  ): WorkerOutcome => ({
    ...fields,
    status,
    workerRunId: run.id,
    durationMs: ctx.clock() - startedAt,
  });

  if (ctx.signal.aborted) {
    ctx.repos.transitionWorkerRun(run.id, "cancelled", { error: "cancelled before start" });
    return done("cancelled", {
      summary: "cancelled before it started",
      fullText: null,
      error: "cancelled before start",
    });
  }

  ctx.repos.transitionWorkerRun(run.id, "streaming");

  const execCtx: ExecuteContext = {
    workspace: opts.workspace,
    approvals: opts.approvals,
    workItemId: ctx.workItem.id,
    workerRunId: run.id,
    signal: ctx.signal,
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
    ...(opts.onProgress === undefined
      ? {}
      : { onProgress: (note: string) => opts.onProgress?.(note, ctx.workItem) }),
  };

  const messages: ChatMessage[] = buildTier2Messages({
    instructions: ctx.workItem.instructions,
    cwd: opts.workspace.cwd,
    workspaceRoot: opts.workspace.root,
  });

  /** Denied calls, by `name(arguments)`, so a retry is answered without re-asking. */
  const denied = new Map<string, string>();
  const artifacts = new Set<string>();
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  let nudged = false;
  let lastProse = "";

  for (let turn = 0; turn < maxTurns; turn++) {
    if (ctx.signal.aborted) {
      return closeCancelled(ctx, run, done);
    }

    let response: ChatResponse;
    try {
      response = await ctx.router.complete(
        {
          model: ctx.workItem.modelId,
          messages,
          tools: WORKER_TOOL_DEFINITIONS,
          maxTokens: opts.maxTokens ?? ctx.maxTokens ?? DEFAULT_MAX_TOKENS,
          taskId: ctx.taskId,
          workerRunId: run.id,
        },
        ctx.signal,
      );
    } catch (err) {
      if (ctx.signal.aborted) return closeCancelled(ctx, run, done);
      const message = err instanceof Error ? err.message : String(err);
      ctx.repos.transitionWorkerRun(run.id, "failed", { error: message });
      return done("failed", { summary: `failed: ${message}`, fullText: null, error: message });
    }

    // The router normalizes a failed call into an `error` finish reason rather
    // than a throw, so success is not the absence of an exception.
    if (response.finishReason === "error") {
      if (ctx.signal.aborted) return closeCancelled(ctx, run, done);
      const message = response.message.content ?? "the model returned an error";
      ctx.repos.transitionWorkerRun(run.id, "failed", { error: message });
      return done("failed", { summary: `failed: ${message}`, fullText: null, error: message });
    }

    const calls = response.message.toolCalls ?? [];
    messages.push({
      role: "assistant",
      content: response.message.content ?? null,
      ...(calls.length === 0 ? {} : { toolCalls: calls }),
    });

    if (calls.length === 0) {
      const prose = (response.message.content ?? "").trim();
      if (prose !== "") lastProse = prose;
      if (!nudged) {
        nudged = true;
        messages.push({
          role: "user",
          content:
            "You wrote prose instead of calling a tool. Nothing outside a tool call reaches " +
            "anyone. If the work is done, call `finish_report` now; otherwise carry on with " +
            "the tools.",
        });
        continue;
      }
      // Twice is a model that will not use the tool. Its prose is probably the
      // answer, and discarding it would bill the user for nothing.
      const text = lastProse === "" ? "" : lastProse;
      if (text === "") break;
      ctx.repos.transitionWorkerRun(run.id, "succeeded", { resultText: text });
      return done("succeeded", {
        summary: `partial (no report filed): ${clamp(collapse(text), SUMMARY_MAX_CHARS - 30)}`,
        fullText: text,
        error: null,
      });
    }

    for (const call of calls) {
      if (ctx.signal.aborted) return closeCancelled(ctx, run, done);

      if (call.name === "finish_report") {
        const parsed = parseWorkerArgs(call.name, call.arguments);
        if (!parsed.ok) {
          // A malformed report is recoverable: tell it what was wrong and let it
          // file again rather than losing the whole run to a bad JSON blob.
          messages.push(toolMessage(call, parsed.error));
          continue;
        }
        const report = parsed.args as {
          status: "success" | "failure" | "partial";
          summary: string;
          details?: string;
          artifacts?: string[];
        };
        for (const a of report.artifacts ?? []) artifacts.add(a);
        const fullText = renderReport(report, artifacts);
        const failed = report.status === "failure";
        ctx.repos.transitionWorkerRun(run.id, failed ? "failed" : "succeeded", {
          resultText: fullText,
          ...(failed ? { error: report.summary } : {}),
        });
        return done(failed ? "failed" : "succeeded", {
          summary:
            report.status === "success"
              ? clamp(collapse(report.summary), SUMMARY_MAX_CHARS)
              : `${report.status}: ${clamp(collapse(report.summary), SUMMARY_MAX_CHARS - 10)}`,
          fullText,
          error: failed ? report.summary : null,
        });
      }

      const result = await dispatch(execCtx, call, denied);
      if (result.denied === true) denied.set(fingerprint(call), result.content);
      if (call.name === "write_file" || call.name === "edit_file") {
        const path = pathOf(call);
        if (path !== null && result.denied !== true) artifacts.add(path);
      }
      messages.push(toolMessage(call, result.content));
    }
  }

  // Out of turns. Whatever it managed is worth more than nothing, but the
  // initiator has to know the run was cut off rather than finished.
  const error = `no finish_report after ${maxTurns} turns`;
  ctx.repos.transitionWorkerRun(run.id, "failed", {
    error,
    ...(lastProse === "" ? {} : { resultText: lastProse }),
  });
  return done("failed", {
    summary: `failed: gave up after ${maxTurns} turns without filing a report`,
    fullText: lastProse === "" ? null : lastProse,
    error,
  });
}

/**
 * Route one validated call to its implementation.
 *
 * The denied-call check comes first and deliberately never reaches
 * `execute.ts`: the user said no once, and asking again because the model asked
 * again is how an approval gate becomes something people click through.
 */
async function dispatch(
  ctx: ExecuteContext,
  call: ToolCall,
  denied: Map<string, string>,
): Promise<ToolResult> {
  const remembered = denied.get(fingerprint(call));
  if (remembered !== undefined) {
    return {
      content: `${remembered} (you already tried this exact call and it was refused — do something else or report what you could not do)`,
      denied: true,
    };
  }

  const parsed = parseWorkerArgs(call.name, call.arguments);
  if (!parsed.ok) return { content: parsed.error };

  // biome-ignore lint/suspicious/noExplicitAny: each tool re-validates via its own zod schema; `parseWorkerArgs` already produced the matching shape.
  const args = parsed.args as any;
  switch (call.name) {
    case "read_file":
      return readFileTool(ctx, args);
    case "write_file":
      return writeFileTool(ctx, args);
    case "edit_file":
      return editFileTool(ctx, args);
    case "list_dir":
      return listDirTool(ctx, args);
    case "glob":
      return globTool(ctx, args);
    case "grep":
      return grepTool(ctx, args);
    case "shell":
      return shellTool(ctx, args);
    case "web_fetch":
      return webFetchTool(ctx, args);
    case "report_progress":
      ctx.onProgress?.(args.note);
      return { content: "noted" };
    default:
      // `parseWorkerArgs` rejects unknown names, so this is a tool declared in
      // `tools.ts` and never wired up here — a bug, but one the model can route
      // around rather than die on.
      return { content: `${call.name} is declared but not implemented; do not call it again` };
  }
}

function toolMessage(call: ToolCall, content: string): ChatMessage {
  return { role: "tool", content, toolCallId: call.id, name: call.name };
}

/** `name({"path":"a"})`, so a retry with different arguments is a different call. */
function fingerprint(call: ToolCall): string {
  return `${call.name}(${call.arguments.trim()})`;
}

function pathOf(call: ToolCall): string | null {
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (typeof parsed !== "object" || parsed === null) return null;
    const path = (parsed as { path?: unknown }).path;
    return typeof path === "string" ? path : null;
  } catch {
    return null;
  }
}

/**
 * The full text `get_result` returns.
 *
 * Written as a document rather than JSON because the reader is the initiator, a
 * model, and it will be pasted into a synthesis prompt.
 */
function renderReport(
  report: { status: string; summary: string; details?: string },
  artifacts: Set<string>,
): string {
  const parts = [`status: ${report.status}`, `summary: ${report.summary}`];
  if (report.details !== undefined && report.details.trim() !== "") {
    parts.push("", report.details.trim());
  }
  if (artifacts.size > 0) {
    parts.push("", `files touched: ${[...artifacts].join(", ")}`);
  }
  return parts.join("\n");
}

function closeCancelled(
  ctx: WorkerContext,
  run: WorkerRun,
  done: (
    status: WorkerOutcome["status"],
    fields: { summary: string; fullText: string | null; error: string | null },
  ) => WorkerOutcome,
): WorkerOutcome {
  ctx.repos.transitionWorkerRun(run.id, "cancelled", { error: "cancelled" });
  return done("cancelled", { summary: "cancelled", fullText: null, error: "cancelled" });
}

function createRun(ctx: WorkerContext): WorkerRun {
  const now = ctx.clock();
  return ctx.repos.createWorkerRun({
    id: newWorkerRunId(),
    workItemId: ctx.workItem.id,
    taskId: ctx.taskId,
    status: "created",
    modelId: ctx.workItem.modelId,
    tier: ctx.workItem.tier,
    attempt: 1,
    harnessSessionId: null,
    resultText: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  });
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}
