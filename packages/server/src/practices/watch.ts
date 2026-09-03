/**
 * The practices drafter's trigger: a bus subscription that fires when a task
 * reaches a terminal state. Unlike the skills distiller it does not wait for
 * *success* — a correction is a correction whether the task then succeeded,
 * failed, or was cancelled; if anything, the task the owner killed after a
 * denial is the one with the clearest lesson.
 *
 * Same discipline as `skills/watch.ts`: nothing here may throw (the bus
 * swallows subscriber errors), and drafts queue rather than interleave so two
 * tasks proposing the same slug cannot race the exists-check.
 */
import type { EventEnvelope, Model, Task } from "@rewter/shared";
import type { PracticesConfig } from "../config/config.js";
import { pickDistillModel } from "../skills/distill.js";
import {
  type PracticesGenerator,
  type PracticesSource,
  draftPractices,
  shouldDraftPractices,
} from "./distill.js";
import { reindexPractices } from "./reindex.js";

export interface PracticesBus {
  subscribe(listener: (event: EventEnvelope) => void): () => void;
  eventsAfter(afterSeq: number, taskId?: string): EventEnvelope[];
}

export interface WirePracticesDrafterOptions {
  bus: PracticesBus;
  generator: PracticesGenerator;
  source: PracticesSource & { getTask(id: string): Task | undefined };
  repos: Parameters<typeof reindexPractices>[1];
  listModels(): Model[];
  practicesRoot: string;
  config: PracticesConfig;
  log: {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
  };
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export function wirePracticesDrafter(opts: WirePracticesDrafterOptions): {
  unsubscribe: () => void;
  idle: () => Promise<void>;
} {
  let chain: Promise<void> = Promise.resolve();

  const unsubscribe = opts.bus.subscribe((event) => {
    const p = event.payload;
    if (p.type !== "task.status_changed" || !TERMINAL.has(p.to)) return;
    if (!opts.config.distill) return;
    const taskId = p.taskId;

    // The trigger is log-only, so decide here, synchronously, before queueing:
    // most tasks have no corrections and must cost nothing — not even a chain
    // link and a getTask.
    if (!shouldDraftPractices(opts.bus.eventsAfter(0, taskId)).distill) return;

    chain = chain.then(() => runOnce(opts, taskId)).catch(() => undefined);
  });

  return { unsubscribe, idle: () => chain };
}

async function runOnce(opts: WirePracticesDrafterOptions, taskId: string): Promise<void> {
  try {
    const task = opts.source.getTask(taskId);
    if (task === undefined) return;

    const using = opts.config.distillModel ?? pickDistillModel(opts.listModels());
    if (using === undefined) {
      opts.log.warn({ taskId }, "practices skipped: no enabled model to draft with");
      return;
    }

    const result = await draftPractices(opts.generator, opts.source, opts.practicesRoot, task, {
      using,
    });

    if (result.outcome === "drafted") {
      const { problems } = reindexPractices(opts.practicesRoot, opts.repos);
      opts.log.info(
        { taskId, slugs: result.slugs, alreadyPending: result.alreadyPending },
        "practice drafted — pending review",
      );
      for (const { path, reason } of problems) {
        opts.log.warn({ path, reason }, "practice not indexed");
      }
    } else if (result.outcome === "failed") {
      opts.log.warn({ taskId, reason: result.reason }, "practices draft failed");
    } else {
      opts.log.info({ taskId, reason: result.reason }, "practices draft skipped");
    }
  } catch (err) {
    opts.log.warn({ taskId, err: String(err) }, "practices draft failed");
  }
}
