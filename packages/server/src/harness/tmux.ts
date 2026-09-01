/**
 * The tmux mirror: `tmux attach -t rwtr_<runId>` shows a harness session live.
 *
 * A *mirror*, deliberately — the harness process does not run inside tmux.
 * Headless harnesses speak NDJSON over pipes, and a pty would wreck both
 * directions: tmux would render raw stream-json instead of anything a human
 * can read, and `send-keys` input rides the tty line discipline, whose
 * canonical-mode buffer (4KB on macOS) silently truncates the instruction
 * frames we actually send. So the child keeps its pipes exactly as before,
 * and this decorator tees the *normalized* event stream into a rendered log
 * that a detached tmux session tails. Watching costs nothing; not watching
 * costs nothing; the harness cannot tell the difference.
 *
 * Best-effort by construction. `withTmuxMirror` probes `tmux -V` once at
 * decoration time and returns the inner adapter untouched when tmux is
 * missing — a daemon without tmux runs tier 3 exactly as it did before this
 * slice. A per-spawn tmux failure after a successful probe loses the mirror,
 * never the session.
 *
 * Restart re-adoption (the next slice) does NOT depend on this: the process
 * is still the daemon's child and dies with it. Re-adoption rides the
 * persisted `harnessSessionId` and the harness's own resume mechanism
 * (`claude --resume`), which survives daemon death precisely because it needs
 * no living process.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type {
  HarnessAdapter,
  HarnessAttachInfo,
  HarnessEvent,
  HarnessSession,
  HarnessSpec,
} from "./types.js";

export interface TmuxMirrorOptions {
  /** tmux binary — absolute under launchd, where there is no user PATH. */
  binary: string;
  /** Where the rendered logs live; one `rwtr_<runId>.log` per session. */
  logsDir: string;
  /** Test seam: runs a tmux command, fire-and-forget. */
  runTmux?: ((args: string[]) => void) | undefined;
  /** Test seam: is tmux usable at all? Defaults to `tmux -V` exiting 0. */
  probe?: (() => boolean) | undefined;
}

/** `rwtr_<runId>` — what the docs promise and `tmux ls` shows. */
export function tmuxSessionName(runId: string): string {
  return `rwtr_${runId}`;
}

/**
 * One event, rendered for a human tailing the log. Null = nothing worth a
 * line (never happens today, but the switch must be total).
 */
export function renderEventLine(event: HarnessEvent): string {
  switch (event.type) {
    case "session":
      return `· session ${event.sessionId}`;
    case "text":
      return event.text;
    case "tool_use":
      return `⚒ ${event.name} ${event.detail}`.trimEnd();
    case "turn_end": {
      const cost = event.costUsd === null ? "" : ` ($${event.costUsd.toFixed(4)})`;
      const flag = event.isError ? " — error" : "";
      return `── turn end${cost}${flag} ──`;
    }
    case "fatal":
      return `✖ ${event.error}`;
  }
}

/**
 * Wrap an adapter so every session it spawns gets a live tmux mirror and
 * carries `attach` info. Returns the adapter unchanged when tmux is
 * unavailable — the mirror is a nicety, and a missing binary must not change
 * what tier 3 can do.
 */
export function withTmuxMirror(inner: HarnessAdapter, opts: TmuxMirrorOptions): HarnessAdapter {
  const probe =
    opts.probe ??
    ((): boolean => {
      try {
        return spawnSync(opts.binary, ["-V"], { stdio: "ignore" }).status === 0;
      } catch {
        return false;
      }
    });
  if (!probe()) return inner;

  const runTmux =
    opts.runTmux ??
    ((args: string[]): void => {
      try {
        const child = spawn(opts.binary, args, { stdio: "ignore", detached: false });
        // A failed per-spawn tmux (killed server, permissions) loses the
        // mirror, never the session — and must never throw into the daemon.
        child.on("error", () => {});
      } catch {
        // Same rule for the sync throw paths.
      }
    });

  return {
    id: inner.id,
    displayName: inner.displayName,
    spawn(spec: HarnessSpec): HarnessSession {
      const session = inner.spawn(spec);
      const name = tmuxSessionName(spec.runId);
      const logPath = join(opts.logsDir, `${name}.log`);

      // Sync writes on purpose: a mirror line arrives a few times a second at
      // most, and the tail (and the tests) must see a line the moment the
      // event went by — a buffered stream's flush is a race the watcher loses.
      let fd: number;
      try {
        mkdirSync(opts.logsDir, { recursive: true });
        fd = openSync(logPath, "a");
      } catch {
        return session; // No log file, no mirror; the session is untouched.
      }
      const write = (line: string): void => {
        try {
          writeSync(fd, `${line}\n`);
        } catch {
          // A full disk kills the mirror, not the run.
        }
      };

      write(`◆ ${inner.displayName} · ${name}`);
      write(`◆ cwd: ${spec.cwd}`);
      write(`◆ task: ${head(spec.instructions)}`);
      write(RULE);
      // `-n +1` so a late attacher replays the whole log, not just the tail.
      runTmux(["new-session", "-d", "-s", name, `exec tail -n +1 -f ${shellQuote(logPath)}`]);

      const attach: HarnessAttachInfo = { session: name, command: `tmux attach -t ${name}` };
      let closed = false;
      const closeMirror = (): void => {
        if (closed) return;
        closed = true;
        write(RULE);
        write("── session ended ──");
        try {
          closeSync(fd);
        } catch {
          // Already closed is fine; the kill below still runs.
        }
        // The watcher sees the end line, then tmux goes with the session —
        // orphaned `tail -f` sessions accumulating on a daemon is the
        // alternative, and it is worse.
        runTmux(["kill-session", "-t", name]);
      };

      return {
        events: tee(session.events, write, closeMirror),
        attach,
        send(message: string): void {
          // The watcher must see steering too — mid-run `send_to_worker` is
          // the feature the mirror exists to make visible.
          write(`⇄ user: ${message}`);
          session.send(message);
        },
        end: () => session.end(),
        kill: () => session.kill(),
      };
    },
  };
}

/** Pass events through, writing each rendered line as it goes by. */
async function* tee(
  inner: AsyncIterable<HarnessEvent>,
  write: (line: string) => void,
  closeMirror: () => void,
): AsyncIterable<HarnessEvent> {
  try {
    for await (const event of inner) {
      write(renderEventLine(event));
      yield event;
    }
  } finally {
    // Runs on natural exhaustion AND when the runner abandons iteration
    // (abort → kill), so the mirror always closes exactly once.
    closeMirror();
  }
}

const RULE = "─".repeat(60);

function head(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= 200 ? flat : `${flat.slice(0, 199)}…`;
}

/** Single-quote a path for the `sh -c` command tmux runs the tail under. */
function shellQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}
