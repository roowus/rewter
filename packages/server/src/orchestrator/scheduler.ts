/**
 * A concurrency limiter for worker fan-out.
 *
 * The initiator is encouraged to spawn several workers in one turn, and nothing
 * stops it spawning twelve. Twelve simultaneous upstream calls is how you find
 * out a provider rate-limits at four, so every worker goes through here first:
 * `spawn_worker` still returns immediately (the promise exists from the moment
 * it is submitted), but the actual call waits its turn.
 *
 * This is ~40 lines rather than a dependency because that is all it is. `p-limit`
 * would add a package to a project whose entire point is being self-contained,
 * for a queue and a counter.
 *
 * Two properties the tests pin down:
 *  - **submission order is run order** — a FIFO queue, so w1 starts before w2.
 *    An LRU or a stack would make the progress feed lie about what was asked for.
 *  - **a rejecting job releases its slot** — otherwise one failing worker
 *    permanently shrinks the pool, and enough failures deadlock the task.
 */

export interface Limiter {
  /** Queue `fn`; resolves with its result once a slot frees up and it runs. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Jobs currently executing. */
  readonly active: number;
  /** Jobs submitted but not yet started. */
  readonly pending: number;
}

export function createLimiter(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
  }

  const queue: Array<() => void> = [];
  let active = 0;

  const next = (): void => {
    if (active >= concurrency) return;
    const start = queue.shift();
    if (start === undefined) return;
    active += 1;
    start();
  };

  return {
    get active() {
      return active;
    },
    get pending() {
      return queue.length;
    },
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          // `fn` may throw synchronously; Promise.resolve().then keeps that on
          // the same path as a rejected promise so the slot is always released.
          Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              next();
            });
        });
        next();
      });
    },
  };
}
