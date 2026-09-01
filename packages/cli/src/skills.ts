/**
 * `rewter skills` — the CLI half of the approval gate (phase-2 M4 slice 3).
 *
 * Talks to the running daemon over `/internal/skills`, never to the tree
 * directly: the daemon owns the index, and a file moved behind its back would
 * leave the index stale until the next boot. Same discovery and auth as
 * `rewter chat` (pidfile → health probe, `REWTER_URL` override,
 * `REWTER_INTERNAL_KEY` in `x-api-key`).
 */
import { type Skill, SkillSchema } from "@rewter/shared";
import { type Connection, discoverDaemon } from "./chat/client.js";

const USAGE = `rewter skills — review what the daemon has learned

Usage:
  rewter skills [list] [--pending|--approved]   the index; pending drafts are
                                                marked, and are never retrieved
  rewter skills show <slug>                     print a skill's SKILL.md path
                                                and description
  rewter skills approve <slug> [--overwrite]    move a pending draft into its
                                                scope — from then on tasks see it
  rewter skills reject <slug>                   delete a pending draft
`;

export interface SkillsOptions {
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  pidfilePath: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function skillsCommand(args: string[], opts: SkillsOptions): Promise<number> {
  const out = opts.out ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = opts.err ?? ((l: string) => process.stderr.write(`${l}\n`));

  const sub = args[0] !== undefined && !args[0].startsWith("--") ? args[0] : "list";
  if (sub === "help" || args.includes("--help")) {
    out(USAGE.trimEnd());
    return 0;
  }
  if (!["list", "show", "approve", "reject"].includes(sub)) {
    err(`unknown subcommand: ${sub}\n\n${USAGE.trimEnd()}`);
    return 1;
  }

  const found = await discoverDaemon({
    env: opts.env,
    pidfilePath: opts.pidfilePath,
    fetch: opts.fetch,
  });
  if (!found.ok) {
    err(found.reason);
    return 1;
  }
  const conn = found.connection;

  switch (sub) {
    case "list":
      return await list(conn, opts.fetch, args, out, err);
    case "show":
      return await show(conn, opts.fetch, args[1], out, err);
    case "approve":
      return await mutate(
        conn,
        opts.fetch,
        "approve",
        args[1],
        args.includes("--overwrite"),
        out,
        err,
      );
    default:
      return await mutate(conn, opts.fetch, "reject", args[1], false, out, err);
  }
}

async function fetchSkills(
  conn: Connection,
  fetchImpl: typeof globalThis.fetch,
): Promise<Skill[] | string> {
  const res = await fetchImpl(`${conn.baseUrl}/internal/skills`, { headers: conn.headers });
  if (!res.ok) return await errorMessage(res);
  // The CLI carries no zod of its own; the shared schema validates each row —
  // same defensive parse, one dependency fewer.
  const body = (await res.json()) as { skills?: unknown };
  if (!Array.isArray(body.skills)) return "daemon answered with an unexpected shape";
  const skills: Skill[] = [];
  for (const row of body.skills) {
    const parsed = SkillSchema.safeParse(row);
    if (!parsed.success) return "daemon answered with an unexpected shape";
    skills.push(parsed.data);
  }
  return skills;
}

async function list(
  conn: Connection,
  fetchImpl: typeof globalThis.fetch,
  args: string[],
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  const skills = await fetchSkills(conn, fetchImpl);
  if (typeof skills === "string") {
    err(skills);
    return 1;
  }

  const wanted = args.includes("--pending")
    ? skills.filter((s) => s.status === "pending")
    : args.includes("--approved")
      ? skills.filter((s) => s.status === "approved")
      : skills;

  if (wanted.length === 0) {
    out(
      args.includes("--pending")
        ? "no proposed skills waiting for review"
        : "no skills yet — they appear as tasks succeed",
    );
    return 0;
  }

  for (const s of wanted) {
    out(`${formatSkillLine(s)}`);
  }
  const pending = wanted.filter((s) => s.status === "pending").length;
  if (pending > 0) {
    out("");
    out(`${pending} proposed — review with \`rewter skills show <slug>\`, then approve or reject`);
  }
  return 0;
}

/** One skill, one line: status marker, slug, scope, then the digest line itself. */
function formatSkillLine(s: Skill): string {
  const marker = s.status === "pending" ? "?" : "✓";
  const scope =
    s.status === "pending"
      ? `proposed → ${s.projectSlug ?? "global"}`
      : (s.projectSlug ?? "global");
  return `${marker} ${s.slug}  [${scope}]  ${s.description}`;
}

async function show(
  conn: Connection,
  fetchImpl: typeof globalThis.fetch,
  slug: string | undefined,
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  if (slug === undefined) {
    err("name a skill: rewter skills show <slug>");
    return 1;
  }
  const skills = await fetchSkills(conn, fetchImpl);
  if (typeof skills === "string") {
    err(skills);
    return 1;
  }
  const matches = skills.filter((s) => s.slug === slug);
  if (matches.length === 0) {
    err(`no such skill: ${slug}`);
    return 1;
  }
  for (const s of matches) {
    out(formatSkillLine(s));
    out(`  file: ${s.path}`);
    if (s.learnedFrom !== null) out(`  learned from task ${s.learnedFrom}`);
    if (s.uses > 0) out(`  used ${s.uses} time${s.uses === 1 ? "" : "s"}`);
  }
  return 0;
}

async function mutate(
  conn: Connection,
  fetchImpl: typeof globalThis.fetch,
  verb: "approve" | "reject",
  slug: string | undefined,
  overwrite: boolean,
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  if (slug === undefined) {
    err(`name a skill: rewter skills ${verb} <slug>`);
    return 1;
  }
  const res = await fetchImpl(`${conn.baseUrl}/internal/skills/${slug}/${verb}`, {
    method: "POST",
    headers: { ...conn.headers, "content-type": "application/json" },
    body: JSON.stringify(verb === "approve" && overwrite ? { overwrite: true } : {}),
  });
  if (!res.ok) {
    err(await errorMessage(res));
    return 1;
  }
  if (verb === "reject") {
    out(`rejected ${slug} — the draft is gone`);
    return 0;
  }
  const body = (await res.json()) as { skill?: Skill };
  const where = body.skill?.projectSlug ?? "global";
  out(
    `approved ${slug} into ${where} — tasks ${where === "global" ? "" : `in ${where} `}see it now`,
  );
  return 0;
}

/** The daemon's error envelope, when there is one worth relaying. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (typeof body.error?.message === "string") return body.error.message;
  } catch {
    // fall through — not JSON, or empty
  }
  return `daemon returned ${res.status}`;
}
