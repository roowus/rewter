/**
 * The push-pull seam between a process's events and an AsyncIterable: the
 * process pushes, the runner pulls, whichever side arrives first waits for
 * the other. `close()` ends iteration after the queue drains, so a fatal
 * pushed just before close is still delivered — the "fatal is always last"
 * guarantee in types.ts rests on this ordering.
 *
 * Shared by every adapter (claude-code.ts, generic.ts): the queue is the part
 * of "wrap a child process as a HarnessSession" that has nothing to do with
 * any particular wire format.
 */
import type { HarnessEvent } from "./types.js";

export class EventQueue {
  private queue: HarnessEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(event: HarnessEvent): void {
    if (this.closed) return;
    this.queue.push(event);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *events(): AsyncIterable<HarnessEvent> {
    while (true) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}
