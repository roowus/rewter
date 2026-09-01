/**
 * The distiller's trigger: a bus subscription that fires the job when a task
 * succeeds. Kept apart from `distill.ts` so the job stays a pure-ish function
 * of its inputs and this file owns the messy part — event filtering, model
 * fallback, fire-and-forget async, and the rule that *nothing here may throw*:
 * the bus swallows subscriber errors to protect the write path, so an error
 * that escaped us would vanish rather than be logged.
 */
import type { EventEnvelope, Model, Task } from "@rewter/shared";
import type { SkillsConfig } from "../config/config.js";
import {
  type DistillGenerator,
  type DistillSource,
  distillTask,
  pickDistillModel,
} from "./distill.js";
import { reindexSkills } from "./reindex.js";

/** The slice of the EventBus this needs. */
export interface DistillBus {
  subscribe(listener: (event: EventEnvelope) => void): () => void;
}

export interface WireDistillerOptions {
  bus: DistillBus;
  generator: DistillGenerator;
  source: DistillSource & { getTask(id: string): Task | undefined };
  /** For reindexing after a draft lands. */
  repos: Parameters<typeof reindexSkills>[1];
  listModels(): Model[];
  skillsRoot: string;
  config: SkillsConfig;
  log: {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
  };
}

/**
 * Subscribe the distiller to the bus. Returns the unsubscribe plus the
 * in-flight promise chain, so tests (and a graceful shutdown, if it ever
 * cares) can await quiescence — distillations queue rather than interleave,
 * because two drafts racing the same slug would defeat the exists-check.
 */
export function wireDistiller(opts: WireDistillerOptions): {
  unsubscribe: () => void;
  idle: () => Promise<void>;
} {
  let chain: Promise<void> = Promise.resolve();

  const unsubscribe = opts.bus.subscribe((event) => {
    const p = event.payload;
    if (p.type !== "task.status_changed" || p.to !== "succeeded") return;
    if (!opts.config.distill) return;
    const taskId = p.taskId;

    // Queued, not awaited: `append` is synchronous and must not wait on an LLM.
    chain = chain.then(() => runOnce(opts, taskId)).catch(() => undefined);
  });

  return { unsubscribe, idle: () => chain };
}

async function runOnce(opts: WireDistillerOptions, taskId: string): Promise<void> {
  try {
    const task = opts.source.getTask(taskId);
    if (task === undefined) return;

    const using = opts.config.distillModel ?? pickDistillModel(opts.listModels());
    if (using === undefined) {
      opts.log.warn({ taskId }, "distill skipped: no enabled model to draft with");
      return;
    }

    const result = await distillTask(opts.generator, opts.source, opts.skillsRoot, task, {
      using,
      minWorkerTurns: opts.config.minWorkerTurns,
    });

    if (result.outcome === "drafted") {
      const { problems } = reindexSkills(opts.skillsRoot, opts.repos);
      opts.log.info(
        { taskId, slug: result.slug, path: result.path },
        "skill drafted — pending review",
      );
      for (const { path, reason } of problems) opts.log.warn({ path, reason }, "skill not indexed");
    } else if (result.outcome === "failed") {
      opts.log.warn({ taskId, reason: result.reason }, "distill failed");
    } else {
      opts.log.info({ taskId, reason: result.reason }, "distill skipped");
    }
  } catch (err) {
    // Belt and braces: distillTask already catches, but a throw from getTask
    // or reindex must not disappear into the bus's swallow.
    opts.log.warn({ taskId, err: String(err) }, "distill failed");
  }
}
