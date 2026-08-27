import { describe, expect, it } from "vitest";
import {
  APPROVAL_TRANSITIONS,
  ApprovalStatusSchema,
  IllegalTransitionError,
  TASK_TRANSITIONS,
  TaskStatusSchema,
  WORKER_RUN_TRANSITIONS,
  WORK_ITEM_TRANSITIONS,
  WorkItemStatusSchema,
  WorkerRunStatusSchema,
  assertApprovalTransition,
  assertTaskTransition,
  assertWorkItemTransition,
  assertWorkerRunTransition,
  isTerminal,
} from "./lifecycle.js";

/**
 * Exhaustive sweep: for each machine, every (from, to) pair either passes or
 * throws exactly per the transition map, plus structural invariants.
 */
function sweepMachine<S extends string>(
  name: string,
  statuses: readonly S[],
  map: Readonly<Record<S, readonly S[]>>,
  assert: (from: S, to: S) => void,
  initial: S,
  terminals: readonly S[],
): void {
  describe(`${name} lifecycle`, () => {
    it("covers every status in its transition map", () => {
      expect(Object.keys(map).sort()).toEqual([...statuses].sort());
    });

    it("only maps to known statuses", () => {
      for (const targets of Object.values(map) as readonly S[][]) {
        for (const t of targets) expect(statuses).toContain(t);
      }
    });

    for (const from of statuses) {
      for (const to of statuses) {
        const legal = map[from].includes(to);
        it(`${from} → ${to} is ${legal ? "legal" : "illegal"}`, () => {
          if (legal) {
            expect(() => assert(from, to)).not.toThrow();
          } else {
            expect(() => assert(from, to)).toThrow(IllegalTransitionError);
          }
        });
      }
    }

    it("terminal statuses have no outgoing transitions", () => {
      for (const s of statuses) {
        expect(isTerminal(map, s)).toBe(terminals.includes(s));
      }
    });

    it("every status is reachable from the initial status", () => {
      const seen = new Set<S>([initial]);
      const queue: S[] = [initial];
      while (queue.length > 0) {
        const cur = queue.shift() as S;
        for (const next of map[cur]) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect([...seen].sort()).toEqual([...statuses].sort());
    });

    it("no self-transitions", () => {
      for (const s of statuses) {
        expect(map[s]).not.toContain(s);
      }
    });
  });
}

sweepMachine("Task", TaskStatusSchema.options, TASK_TRANSITIONS, assertTaskTransition, "pending", [
  "succeeded",
  "failed",
  "cancelled",
]);

sweepMachine(
  "WorkItem",
  WorkItemStatusSchema.options,
  WORK_ITEM_TRANSITIONS,
  assertWorkItemTransition,
  "pending",
  ["succeeded", "failed", "cancelled", "handed_off"],
);

sweepMachine(
  "WorkerRun",
  WorkerRunStatusSchema.options,
  WORKER_RUN_TRANSITIONS,
  assertWorkerRunTransition,
  "created",
  ["succeeded", "failed", "cancelled"],
);

sweepMachine(
  "Approval",
  ApprovalStatusSchema.options,
  APPROVAL_TRANSITIONS,
  assertApprovalTransition,
  "pending",
  ["approved", "denied", "auto_approved", "expired"],
);

describe("IllegalTransitionError", () => {
  it("carries entity, from, and to", () => {
    try {
      assertTaskTransition("succeeded", "running");
      expect.unreachable();
    } catch (err) {
      const e = err as IllegalTransitionError;
      expect(e.entity).toBe("Task");
      expect(e.from).toBe("succeeded");
      expect(e.to).toBe("running");
      expect(e.message).toBe("illegal Task transition: succeeded → running");
    }
  });
});
