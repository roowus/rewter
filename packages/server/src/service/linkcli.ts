/**
 * `rewter install-cli` — putting the command on `PATH`.
 *
 * A monorepo builds to `packages/cli/dist/index.js`, and nothing makes that a
 * word you can type. This is the one step between a working build and a working
 * command, and three decisions shape it:
 *
 * 1. **A symlink, not a copy.** A copy is correct for exactly as long as it takes
 *    to run `pnpm build` again, and then it is a stale binary that reports the
 *    old version and fails in ways that make no sense next to a repo that looks
 *    right. The symlink follows the checkout. It works because node resolves a
 *    symlinked entry point to its *real* path before resolving imports, so
 *    `@rewter/server` still resolves through the workspace's `node_modules` —
 *    which also means moving or deleting the checkout breaks the command, as it
 *    should, rather than leaving a half-working one behind.
 *
 * 2. **We do not edit your shell rc.** If the chosen directory is not on `PATH`,
 *    the result says so and prints the `export` line to add. Same rule as
 *    `install-service` printing the `launchctl` lines instead of running them:
 *    a tool holding your API keys does not get to rewrite your dotfiles.
 *
 * 3. **Nothing gets clobbered.** An existing symlink already pointing at this
 *    target is `unchanged`; one pointing somewhere else, or a real file, needs
 *    `--force`. `rewter` is a short name and the file sitting there might be
 *    someone else's.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

/** The name typed at the prompt. Also the filename created in the bin directory. */
export const CLI_COMMAND = "rewter";

/**
 * Where to put it, best first.
 *
 * `~/.local/bin` leads because it needs no `sudo` and is the convention every
 * other per-user tool follows; `/usr/local/bin` is here for machines set up
 * before that was true. Selection is by `PATH` membership only, never by whether
 * the directory happens to exist: the point of the command is that the word
 * works, and a directory we can create is strictly better than one that already
 * exists but needs `sudo` to write to.
 */
const CANDIDATE_DIRS = ["~/.local/bin", "/usr/local/bin"];

export interface LinkOptions {
  /** Absolute path to the CLI entry point (`packages/cli/dist/index.js`). */
  target: string;
  /** Where to create the link. Defaults to the best candidate for this machine. */
  dir?: string | undefined;
  /** The user's home, for expanding `~` in candidates. */
  home: string;
  /** `PATH` as the shell has it, for deciding whether the link will be found. */
  pathEnv: string;
  /** Report what would happen; touch nothing. */
  dryRun?: boolean | undefined;
  /** Replace whatever is at the link path already. */
  force?: boolean | undefined;
}

export interface LinkResult {
  linkPath: string;
  target: string;
  /**
   * `linked` — created. `relinked` — replaced a link that pointed elsewhere.
   * `unchanged` — already correct. `exists` — something else is there and
   * `--force` was not passed. `dry-run` — nothing was written.
   */
  action: "linked" | "relinked" | "unchanged" | "exists" | "dry-run";
  /** True when the link's directory is on `PATH`, i.e. the command will be found. */
  onPath: boolean;
  /** What the user still has to do: add to `PATH`, or force past an obstruction. */
  next: string[];
}

/**
 * Create the symlink, or say why it did not.
 *
 * The target is made executable if it is not already: `tsc` emits mode 644, and
 * a symlink to a non-executable file fails with a permission error that blames
 * the link rather than the shebang'd file behind it.
 *
 * That includes the `unchanged` path, which is not a shortcut for "do nothing".
 * A rebuild rewrites the target at 644 and leaves the link pointing at it, so
 * the state where the command is installed and broken is reached by running
 * `pnpm build` — the single most likely thing to happen between installs. The
 * `build` script chmods too; this is the belt to that suspenders, because the
 * failure is `permission denied` on a word the user was told would work.
 */
export function installCli(opts: LinkOptions): LinkResult {
  const dir = resolve(expandHome(opts.dir ?? chooseDir(opts.home, opts.pathEnv), opts.home));
  const linkPath = join(dir, CLI_COMMAND);
  const onPath = isOnPath(dir, opts.pathEnv);
  const next: string[] = [];
  if (!onPath) next.push(`export PATH="${dir}:$PATH"   # add to ~/.zshrc`);

  const existing = readLink(linkPath);
  if (existing === opts.target) {
    if (opts.dryRun !== true) ensureExecutable(opts.target);
    return { linkPath, target: opts.target, action: "unchanged", onPath, next };
  }

  const occupied = existing !== undefined || existsSync(linkPath);
  if (occupied && opts.force !== true) {
    return {
      linkPath,
      target: opts.target,
      action: "exists",
      onPath,
      next: [`rewter install-cli --force   # replace what is at ${linkPath}`, ...next],
    };
  }

  if (opts.dryRun === true) {
    return { linkPath, target: opts.target, action: "dry-run", onPath, next };
  }

  mkdirSync(dir, { recursive: true });
  ensureExecutable(opts.target);
  // `rm` then `symlink`, because `symlinkSync` will not overwrite and there is
  // no atomic swap for this that is worth the complexity on a developer machine.
  if (occupied) rmSync(linkPath, { force: true });
  symlinkSync(opts.target, linkPath);

  return {
    linkPath,
    target: opts.target,
    action: occupied ? "relinked" : "linked",
    onPath,
    next,
  };
}

/** Remove the link — but only if it is ours, never a file someone else put there. */
export function uninstallCli(opts: {
  target: string;
  dir?: string | undefined;
  home: string;
  pathEnv: string;
}): { removed: boolean; linkPath: string; reason?: string } {
  const dir = resolve(expandHome(opts.dir ?? chooseDir(opts.home, opts.pathEnv), opts.home));
  const linkPath = join(dir, CLI_COMMAND);
  const existing = readLink(linkPath);

  if (existing === undefined) {
    return existsSync(linkPath)
      ? { removed: false, linkPath, reason: "not a symlink — left alone" }
      : { removed: false, linkPath };
  }
  if (existing !== opts.target) {
    return { removed: false, linkPath, reason: `points at ${existing} — left alone` };
  }

  rmSync(linkPath, { force: true });
  return { removed: true, linkPath };
}

/**
 * Pick a directory: the first candidate already on `PATH`, else `~/.local/bin`,
 * which `installCli` will create. Falling back to `/usr/local/bin` merely
 * because it exists would trade a directory we can write for one that needs
 * `sudo`, and it is not on every machine's `PATH` either.
 */
function chooseDir(home: string, pathEnv: string): string {
  const expanded = CANDIDATE_DIRS.map((c) => expandHome(c, home));
  return expanded.find((d) => isOnPath(d, pathEnv)) ?? join(home, ".local", "bin");
}

function isOnPath(dir: string, pathEnv: string): boolean {
  const target = resolve(dir);
  return pathEnv
    .split(delimiter)
    .filter((p) => p !== "")
    .some((p) => resolve(p) === target);
}

/** The link's target, or undefined when the path is absent or not a symlink. */
function readLink(path: string): string | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) return undefined;
    // Relative targets resolve against the link's own directory, not the cwd.
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return undefined;
  }
}

/** `tsc` emits mode 644; a shebang is useless without the execute bit. */
function ensureExecutable(target: string): void {
  try {
    const mode = lstatSync(target).mode & 0o777;
    if ((mode & 0o111) !== 0o111) chmodSync(target, mode | 0o111);
  } catch {
    // A missing target is the caller's problem to report, not ours to throw on.
  }
}

function expandHome(path: string, home: string): string {
  return path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path;
}
