/**
 * `rewter logs` — reading what the daemon wrote when nobody was watching.
 *
 * Under launchd there is no terminal to have been attached to, so the log files
 * are the only record of a boot that failed, a provider that came up disabled,
 * or a task the last process left running. That makes this less of a
 * convenience than it looks: it is the answer to "it did not start and I do not
 * know why".
 *
 * Two things it does that `tail` does not:
 *
 * - **It reads stdout and stderr together.** launchd insists on two separate
 *   paths, but the daemon's own pino lines go to stdout while a boot crash goes
 *   to stderr, and the interesting case — it printed three warnings and *then*
 *   died — is only legible interleaved. Lines are merged by their timestamps
 *   where they have them.
 * - **It renders pino's JSON as something readable.** The daemon logs
 *   structured lines because the dashboard and the tests want them; a person
 *   reading a boot failure wants `WARN provider disabled: key env var is unset`.
 *
 * Reading is bounded from the end of the file: these logs are append-only and
 * unrotated, and a `logs` that loaded a hundred megabytes to show the last
 * twenty lines would be its own bug report.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LogSource {
  /** `out` or `err` — printed as a prefix only when the two disagree. */
  stream: "out" | "err";
  path: string;
}

export interface LogLine {
  stream: "out" | "err";
  /** Unix ms parsed from the line, or undefined for something not pino-shaped. */
  ts?: number | undefined;
  /** Rendered for a human — pino JSON collapsed, anything else passed through. */
  text: string;
}

/** The two paths launchd writes, given an expanded log directory. */
export function logPaths(logDir: string): LogSource[] {
  return [
    { stream: "out", path: join(logDir, "rewter.log") },
    { stream: "err", path: join(logDir, "rewter.err.log") },
  ];
}

export interface ReadLogsOptions {
  /** How many lines to return, counting from the end. */
  lines?: number;
  /** Only lines at or above this pino level. `warn` is the "why did it not start" filter. */
  minLevel?: LogLevel;
}

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LEVELS: Record<number, LogLevel> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};
const ORDER: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

/**
 * Read the tail of both files and merge them.
 *
 * Missing files are not an error: before the first launchd boot neither exists,
 * and that is worth reporting as "no logs yet" by the caller rather than as a
 * failure here.
 */
export function readLogs(sources: LogSource[], opts: ReadLogsOptions = {}): LogLine[] {
  const limit = opts.lines ?? 50;
  const collected: LogLine[] = [];

  for (const source of sources) {
    for (const raw of tailLines(source.path, limit)) {
      const line = parseLine(raw, source.stream);
      if (line !== undefined) collected.push(line);
    }
  }

  const filtered =
    opts.minLevel === undefined
      ? collected
      : collected.filter((l) => atLeast(levelOf(l), opts.minLevel as LogLevel));

  // Interleave by timestamp. Lines without one (a raw stack trace, a `console.log`
  // from a dependency) keep their position relative to the line above them —
  // stable sort — because a stack trace belongs under the error it came from.
  const indexed = filtered.map((line, i) => ({ line, i }));
  indexed.sort((a, b) => {
    const ta = a.line.ts;
    const tb = b.line.ts;
    if (ta !== undefined && tb !== undefined && ta !== tb) return ta - tb;
    return a.i - b.i;
  });

  return indexed.slice(-limit).map((x) => x.line);
}

/**
 * Read approximately the last `count` lines without loading the whole file.
 *
 * Reads a chunk from the end and grows it until it holds enough newlines, which
 * is bounded by a cap: a log with one enormous line should give up and show a
 * truncated version rather than read to the start of the file.
 */
export function tailLines(path: string, count: number, maxBytes = 1024 * 1024): string[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  if (size === 0) return [];

  const length = Math.min(size, maxBytes);
  const start = size - length;
  const buffer = Buffer.alloc(length);

  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }

  const text = buffer.toString("utf8");
  // A partial first line when we started mid-file: drop it rather than show a
  // fragment that will parse as neither JSON nor a sentence.
  const lines = text.split("\n");
  if (start > 0) lines.shift();

  return lines.filter((l) => l.trim() !== "").slice(-count);
}

/**
 * One line, rendered.
 *
 * pino writes one JSON object per line; anything else — a stack trace, a Node
 * warning, the `bootSummary` this CLI itself prints — is passed through as-is,
 * because the alternative is dropping exactly the lines that appear when
 * something has gone unusually wrong.
 */
function parseLine(raw: string, stream: "out" | "err"): LogLine | undefined {
  const trimmed = raw.trimEnd();
  if (trimmed === "") return undefined;

  if (!trimmed.startsWith("{")) return { stream, text: trimmed };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { stream, text: trimmed };
  }
  if (typeof parsed !== "object" || parsed === null) return { stream, text: trimmed };

  const record = parsed as Record<string, unknown>;
  const ts = typeof record.time === "number" ? record.time : undefined;
  const level = typeof record.level === "number" ? LEVELS[record.level] : undefined;
  const msg = typeof record.msg === "string" ? record.msg : "";

  return {
    stream,
    ts,
    text: `${ts === undefined ? "" : `${new Date(ts).toISOString()} `}${(level ?? "info").toUpperCase().padEnd(5)} ${msg || summarize(record)}${context(record)}`,
  };
}

/**
 * The fields worth appending after the message.
 *
 * Request lines are the bulk of a busy log and their useful part is
 * `method url → status`; everything else gets whatever small scalar fields it
 * carries. pino's own bookkeeping is dropped, and so is anything long enough to
 * be a body — a log reader is not the place to discover a leaked key.
 */
function context(record: Record<string, unknown>): string {
  const req = record.req as Record<string, unknown> | undefined;
  const res = record.res as Record<string, unknown> | undefined;
  if (req !== undefined && typeof req.method === "string") {
    return ` — ${req.method} ${String(req.url ?? "")}`;
  }
  if (res !== undefined && typeof res.statusCode === "number") {
    return ` — ${res.statusCode}`;
  }

  const skip = new Set(["level", "time", "pid", "hostname", "msg", "reqId", "req", "res", "v"]);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (skip.has(key)) continue;
    if (typeof value === "object" && value !== null) continue;
    const text = String(value);
    if (text.length > 80) continue;
    parts.push(`${key}=${text}`);
  }
  return parts.length === 0 ? "" : ` (${parts.join(" ")})`;
}

/** A pino line with no `msg` still has fields; show them rather than an empty line. */
function summarize(record: Record<string, unknown>): string {
  return typeof record.err === "object" && record.err !== null
    ? String((record.err as Record<string, unknown>).message ?? "error")
    : "(no message)";
}

function levelOf(line: LogLine): LogLevel {
  const match = /^(?:\S+ )?([A-Z]+)/.exec(line.text);
  const level = match?.[1]?.toLowerCase();
  return ORDER.includes(level as LogLevel) ? (level as LogLevel) : "info";
}

function atLeast(level: LogLevel, min: LogLevel): boolean {
  return ORDER.indexOf(level) >= ORDER.indexOf(min);
}

/** Render for the terminal, prefixing the stream only when both are in play. */
export function formatLogs(lines: LogLine[]): string {
  if (lines.length === 0) return "";
  const mixed = lines.some((l) => l.stream === "err") && lines.some((l) => l.stream === "out");
  return lines
    .map((l) => (mixed && l.stream === "err" ? `[err] ${l.text}` : l.text))
    .join("\n")
    .concat("\n");
}
