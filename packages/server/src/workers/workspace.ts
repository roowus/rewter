/**
 * Where a tier-2 worker is allowed to touch the disk.
 *
 * Two directories, and the difference between them is the whole point:
 *
 * - **`root`** — `~/.rewter/workspaces/<taskId>/`, created on demand, one per
 *   task and shared by every worker in it. This is the *auto-approve zone*: a
 *   write in here damages nothing a user would miss, so gating it would train
 *   people to click approve without reading, which is worse than not gating.
 * - **`cwd`** — where relative paths resolve and `shell` runs. Equal to `root`
 *   unless the task points at a real project directory, in which case the
 *   worker works *in the user's code* and every write there is outside the
 *   auto-approve zone by construction. That is deliberate: pointing a worker at
 *   your repo is exactly when you want to be asked.
 *
 * So `classify` answers one question — *is this path inside the zone?* — and
 * hands the answer to `approvals.require`. Nothing here refuses a path; refusal
 * is a policy decision made one layer up with the task's `autoApprove` in hand.
 * A sandbox that decides on its own is a sandbox you cannot point at a repo.
 *
 * The traversal check is done on **resolved, symlink-followed** paths, because
 * the cheap check — does the string start with the root? — is defeated by both
 * `root/../etc/passwd` and by a symlink inside the workspace pointing out of it.
 * A path whose parent does not exist yet (the common case for `write_file`) is
 * resolved as far up as it does exist, since you cannot realpath a file you are
 * about to create.
 */
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { TaskId } from "@rewter/shared";

export interface Workspace {
  /** The auto-approve zone. Writes inside it need no approval. */
  root: string;
  /** Where relative paths resolve. Outside `root` when the task names a project dir. */
  cwd: string;
}

export interface ResolvedPath {
  /** Absolute, `..`-free, with existing components symlink-resolved. */
  absolute: string;
  /** True when the path is inside the auto-approve zone. */
  inside: boolean;
  /** The path as the worker wrote it — quoted back in approval prompts. */
  requested: string;
}

/**
 * Build (and create) a task's workspace.
 *
 * `workspaceDir` is expanded and resolved but *not* created: a typo in a project
 * path should fail loudly on first use, not silently mkdir a new directory next
 * to the one the user meant.
 */
export function openWorkspace(opts: {
  taskId: TaskId;
  baseDir: string;
  /**
   * `undefined` is spelled out because `exactOptionalPropertyTypes` is on: the
   * caller reads this off `task.settings`, where it is legitimately absent, and
   * a signature that only allows *omitting* the key forces every caller to
   * branch on a value this function already handles.
   */
  workspaceDir?: string | null | undefined;
}): Workspace {
  const raw = resolve(opts.baseDir, String(opts.taskId));
  mkdirSync(raw, { recursive: true });
  // Both fields are symlink-resolved, and must be: on macOS `/var` is a symlink
  // to `/private/var`, so a resolved root and an unresolved cwd compare unequal
  // while naming the same directory — and `contains(root, cwd)` would then say
  // the workspace is outside itself.
  const root = realpathish(raw);
  const dir = opts.workspaceDir;
  const cwd =
    dir === null || dir === undefined || dir.trim() === "" ? root : realpathish(resolve(dir));
  return { root, cwd };
}

/**
 * Resolve a worker-supplied path and say whether it landed inside the zone.
 *
 * Relative paths resolve against `cwd`, which is what a worker means by
 * `notes.md` — but the zone check is always against `root`, so a task working in
 * a project directory gets `inside: false` for its own relative paths. Correct,
 * and the reason `cwd` and `root` are separate fields rather than one.
 */
export function classify(ws: Workspace, requested: string): ResolvedPath {
  const absolute = realpathish(isAbsolute(requested) ? requested : resolve(ws.cwd, requested));
  return { absolute, inside: contains(ws.root, absolute), requested };
}

/**
 * Is `child` at or below `parent`?
 *
 * The separator is appended before comparing, or `/workspaces/task-1-evil`
 * counts as inside `/workspaces/task-1`. Both are already resolved, so a
 * prefix test is sound here in a way it is not on raw input.
 */
export function contains(parent: string, child: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(withSep);
}

/**
 * `realpathSync` for a path that may not exist yet.
 *
 * Walks up to the nearest existing ancestor, resolves *that*, and re-appends
 * what was missing. Without this, `write_file("new/dir/file.txt")` could not be
 * checked at all — and skipping the check for non-existent paths is precisely
 * the hole worth caring about, since that is the write case.
 */
function realpathish(path: string): string {
  const resolved = resolve(path);
  let head = resolved;
  const tail: string[] = [];
  // Loop terminates: `dirname` reaches the filesystem root, which always exists.
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync(head) : resolve(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolved;
      tail.unshift(head.slice(parent.length + 1));
      head = parent;
    }
  }
}
