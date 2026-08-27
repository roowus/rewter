/**
 * Scheduler tests. The module's header names two invariants; both are here,
 * because both are load-bearing and neither is visible from the outside until
 * it breaks in production:
 *
 *  - submission order is run order (the progress feed would otherwise lie),
 *  - a rejecting job releases its slot (or failures shrink the pool to zero).
 */
import { describe, expect, it } from "vitest";
import { createLimiter } from "./scheduler.js";

/** A promise plus its resolvers — lets a test hold a job open deliberately. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks run — the limiter's handoffs are all microtask-sized. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("createLimiter", () => {
  it("rejects a concurrency that cannot schedule anything", () => {
    expect(() => createLimiter(0)).toThrow(RangeError);
    expect(() => createLimiter(-1)).toThrow(RangeError);
    expect(() => createLimiter(1.5)).toThrow(RangeError);
  });

  it("runs up to `concurrency` jobs at once and queues the rest", async () => {
    const limiter = createLimiter(2);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];

    const runs = gates.map((gate, i) =>
      limiter.run(async () => {
        started.push(i);
        await gate.promise;
        return i;
      }),
    );

    await settle();
    expect(started).toEqual([0, 1]);
    expect(limiter.active).toBe(2);
    expect(limiter.pending).toBe(1);

    gates[0]?.resolve();
    await settle();
    expect(started).toEqual([0, 1, 2]);

    gates[1]?.resolve();
    gates[2]?.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2]);
    expect(limiter.active).toBe(0);
    expect(limiter.pending).toBe(0);
  });

  it("starts queued jobs in submission order", async () => {
    const limiter = createLimiter(1);
    const order: string[] = [];
    const gate = deferred();

    const first = limiter.run(async () => {
      order.push("w1");
      await gate.promise;
    });
    const rest = ["w2", "w3", "w4"].map((label) =>
      limiter.run(async () => {
        order.push(label);
      }),
    );

    await settle();
    expect(order).toEqual(["w1"]);

    gate.resolve();
    await Promise.all([first, ...rest]);
    expect(order).toEqual(["w1", "w2", "w3", "w4"]);
  });

  it("releases the slot when a job rejects, so failures do not shrink the pool", async () => {
    const limiter = createLimiter(1);
    const failures = [
      limiter.run(async () => {
        throw new Error("upstream exploded");
      }),
      limiter.run(async () => {
        throw new Error("and again");
      }),
    ];

    await expect(failures[0]).rejects.toThrow("upstream exploded");
    await expect(failures[1]).rejects.toThrow("and again");

    // The pool is intact: a later job still runs.
    await expect(limiter.run(async () => "ok")).resolves.toBe("ok");
    expect(limiter.active).toBe(0);
  });

  it("releases the slot when a job throws synchronously", async () => {
    const limiter = createLimiter(1);
    const thrown = limiter.run((): Promise<never> => {
      throw new Error("threw before returning a promise");
    });

    await expect(thrown).rejects.toThrow("threw before returning a promise");
    await expect(limiter.run(async () => "still works")).resolves.toBe("still works");
  });

  it("never exceeds the ceiling under a burst", async () => {
    const limiter = createLimiter(3);
    let live = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 12 }, () =>
        limiter.run(async () => {
          live += 1;
          peak = Math.max(peak, live);
          await settle();
          live -= 1;
        }),
      ),
    );

    expect(peak).toBe(3);
    expect(limiter.active).toBe(0);
  });
});
