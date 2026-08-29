import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LogSource, formatLogs, logPaths, readLogs, tailLines } from "./logs.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewter-logs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** One pino line, as the daemon writes them. */
function pino(fields: Record<string, unknown>): string {
  return JSON.stringify({ level: 30, time: 1_800_000_000_000, pid: 1, hostname: "m", ...fields });
}

function write(name: string, lines: string[]): string {
  const path = join(dir, name);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function sources(out: string[], err: string[] = []): LogSource[] {
  const list: LogSource[] = [{ stream: "out", path: write("rewter.log", out) }];
  if (err.length > 0) list.push({ stream: "err", path: write("rewter.err.log", err) });
  return list;
}

describe("logPaths", () => {
  it("names the two files launchd insists on", () => {
    expect(logPaths("/tmp/l")).toEqual([
      { stream: "out", path: "/tmp/l/rewter.log" },
      { stream: "err", path: "/tmp/l/rewter.err.log" },
    ]);
  });
});

describe("tailLines", () => {
  it("returns the last n lines", () => {
    const path = write("a.log", ["one", "two", "three", "four"]);
    expect(tailLines(path, 2)).toEqual(["three", "four"]);
  });

  it("returns everything when the file is shorter than n", () => {
    expect(tailLines(write("a.log", ["one"]), 50)).toEqual(["one"]);
  });

  it("treats a missing file as empty, not an error", () => {
    // Before the first launchd boot neither file exists; that is "no logs yet".
    expect(tailLines(join(dir, "absent.log"), 10)).toEqual([]);
  });

  it("handles an empty file", () => {
    expect(tailLines(write("a.log", []), 10)).toEqual([]);
  });

  it("does not read the whole file to show the tail", () => {
    // The point of the byte cap: these logs are append-only and unrotated.
    const path = join(dir, "big.log");
    writeFileSync(path, `${Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n")}\n`);

    const lines = tailLines(path, 3, 512);

    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toBe("line 4999");
  });

  it("drops the partial first line when it started mid-file", () => {
    const path = join(dir, "big.log");
    writeFileSync(path, `${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}\n`);

    // A fragment of a line parses as neither JSON nor a sentence.
    for (const line of tailLines(path, 100, 300)) expect(line).toMatch(/^line \d+$/);
  });

  it("skips blank lines", () => {
    expect(tailLines(write("a.log", ["one", "", "  ", "two"]), 10)).toEqual(["one", "two"]);
  });
});

describe("readLogs", () => {
  it("renders pino JSON as something a person can read", () => {
    const lines = readLogs(sources([pino({ level: 40, msg: "provider disabled" })]));

    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("WARN");
    expect(lines[0]?.text).toContain("provider disabled");
    expect(lines[0]?.text).not.toContain('{"level"');
  });

  it("passes non-JSON lines through untouched", () => {
    // Stack traces and Node warnings are exactly the lines that appear when
    // something has gone unusually wrong; dropping them would be perverse.
    const lines = readLogs(sources(["    at Object.<anonymous> (/x/y.js:1:1)"]));
    expect(lines[0]?.text).toBe("    at Object.<anonymous> (/x/y.js:1:1)");
  });

  it("survives a truncated JSON line", () => {
    const lines = readLogs(sources([`{"level":30,"msg":"cut o`]));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("cut o");
  });

  it("interleaves stdout and stderr by timestamp", () => {
    // The interesting case — it printed warnings and *then* died — is only
    // legible merged, and launchd will only ever give us two separate files.
    const out = [pino({ time: 1000, msg: "first" }), pino({ time: 3000, msg: "third" })];
    const err = [pino({ time: 2000, level: 50, msg: "second" })];

    const texts = readLogs(sources(out, err)).map((l) => l.text);

    expect(texts[0]).toContain("first");
    expect(texts[1]).toContain("second");
    expect(texts[2]).toContain("third");
  });

  it("keeps an untimestamped line under the line it followed", () => {
    // A stack trace belongs beneath its error, not sorted to the top.
    const err = [pino({ time: 2000, level: 50, msg: "boom" }), "    at boom (/x.js:1:1)"];

    const texts = readLogs(sources([pino({ time: 1000, msg: "before" })], err)).map((l) => l.text);

    expect(texts[1]).toContain("boom");
    expect(texts[2]).toContain("at boom");
  });

  it("filters below the requested level", () => {
    // `--level warn` is the "why did it not start" filter.
    const lines = readLogs(
      sources([
        pino({ level: 30, msg: "routine" }),
        pino({ level: 40, msg: "suspicious" }),
        pino({ level: 50, msg: "bad" }),
      ]),
      { minLevel: "warn" },
    );

    expect(lines.map((l) => l.text).join("\n")).not.toContain("routine");
    expect(lines).toHaveLength(2);
  });

  it("limits to the requested number of lines, counting from the end", () => {
    const lines = readLogs(
      sources([1, 2, 3, 4, 5].map((n) => pino({ time: 1000 + n, msg: `m${n}` }))),
      { lines: 2 },
    );

    expect(lines).toHaveLength(2);
    expect(lines[1]?.text).toContain("m5");
  });

  it("returns nothing when no file exists yet", () => {
    expect(readLogs([{ stream: "out", path: join(dir, "absent.log") }])).toEqual([]);
  });

  it("summarizes a request line as method and url", () => {
    const lines = readLogs(
      sources([pino({ msg: "incoming request", req: { method: "POST", url: "/v1/chat" } })]),
    );
    expect(lines[0]?.text).toContain("POST /v1/chat");
  });

  it("appends small scalar fields as context", () => {
    const lines = readLogs(sources([pino({ msg: "provider disabled", provider: "zai" })]));
    expect(lines[0]?.text).toContain("provider=zai");
  });

  it("drops a field long enough to be a body — a log reader is not a key viewer", () => {
    const secret = `sk-ant-${"x".repeat(120)}`;
    const lines = readLogs(sources([pino({ msg: "oops", leaked: secret })]));

    expect(lines[0]?.text).toContain("oops");
    expect(lines[0]?.text).not.toContain("sk-ant-");
  });

  it("shows a line that has fields but no message", () => {
    const lines = readLogs(sources([pino({ err: { message: "ECONNREFUSED" } })]));
    expect(lines[0]?.text).toContain("ECONNREFUSED");
  });
});

describe("formatLogs", () => {
  it("prefixes [err] only when both streams are present", () => {
    const both = formatLogs([
      { stream: "out", text: "a" },
      { stream: "err", text: "b" },
    ]);
    expect(both).toBe("a\n[err] b\n");

    // A stderr-only tail is unambiguous; the prefix would just be noise.
    expect(formatLogs([{ stream: "err", text: "b" }])).toBe("b\n");
  });

  it("returns an empty string for no lines, so the caller can say 'no logs yet'", () => {
    expect(formatLogs([])).toBe("");
  });
});
