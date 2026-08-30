/**
 * Rendering numbers a person is going to make a decision from.
 *
 * The one non-obvious rule is money: orchestration spends fractions of a cent
 * per worker, and a `$0.00` next to every row makes the whole feature look free
 * right up until the monthly bill. So small amounts keep significant digits
 * instead of rounding to a currency's worth of places.
 */

/** `$0.0042`, `$1.37`, `$0` — never a rounded-to-nothing `$0.00`. */
export function usd(amount: number): string {
  if (amount === 0) return "$0";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

/** Elapsed time as something scannable: `840ms`, `12s`, `4m 06s`. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

/**
 * How long a task has been running, or how long it took.
 *
 * `finishedAt` is the honest end for a terminal task; a running one is measured
 * against now, which is why `now` is a parameter — a clock read inside a render
 * is a test that passes at different times of day.
 */
export function elapsed(
  entity: { createdAt: number; finishedAt: number | null },
  now: number,
): string {
  return duration((entity.finishedAt ?? now) - entity.createdAt);
}

/** Wall-clock, seconds included: two events in the same minute are different lines. */
export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * `512 B`, `412 KB`, `1.4 MB` — the size question is "roughly how much", so
 * binary-vs-decimal prefixes are not worth the reader's attention; 1024 it is.
 */
export function bytes(size: number): string {
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(0)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Provider-qualified ids are long and the provider half repeats down a column,
 * so the model name carries the information: `anthropic/claude-sonnet-5` reads
 * as `claude-sonnet-5`. Kept as a function rather than inlined because the
 * registry editor will want the full id and this is the exception.
 */
export function shortModelId(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash === -1 ? modelId : modelId.slice(slash + 1);
}
