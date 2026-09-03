/**
 * `rewter practices` — the CLI half of the practices gate.
 *
 * The skills command one tree over: talks to the running daemon over
 * `/internal/practices`, never to the files directly, for the same reason —
 * the daemon owns the index. Same discovery and auth as `rewter chat`.
 */
import { type Practice, PracticeSchema } from "@rewter/shared";
import { type Connection, discoverDaemon } from "./chat/client.js";

const USAGE = `rewter practices — review the standing facts the daemon has drafted

Usage:
  rewter practices [list] [--pending|--approved]  the index; pending drafts are
                                                  marked and not yet in context
  rewter practices show <slug>                    print a practice's PRACTICE.md
                                                  path and its fact
  rewter practices approve <slug> [--overwrite]   move a pending draft into its
                                                  scope — every task then sees it
  rewter practices reject <slug>                  delete a pending draft
`;

export interface PracticesOptions {
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  pidfilePath: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function practicesCommand(args: string[], opts: PracticesOptions): Promise<number> {
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

async function fetchPractices(
  conn: Connection,
  fetchImpl: typeof globalThis.fetch,
): Promise<Practice[] | string> {
  const res = await fetchImpl(`${conn.baseUrl}/internal/practices`, { headers: conn.headers });
  if (!res.ok) return await errorMessage(res);
  const body = (await res.json()) as { practices?: unknown };
  if (!Array.isArray(body.practices)) return "daemon answered with an unexpected shape";
  const practices: Practice[] = [];
  for (const row of body.practices) {
    const parsed = PracticeSchema.safeParse(row);
    if (!parsed.success) return "daemon answered with an unexpected shape";
    practices.push(parsed.data);
  }
  return practices;
}

async function list(
  conn: Connection,
  fetchImpl: typeof globalThis.fetch,
  args: string[],
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  const practices = await fetchPractices(conn, fetchImpl);
  if (typeof practices === "string") {
    err(practices);
    return 1;
  }

  const wanted = args.includes("--pending")
    ? practices.filter((p) => p.status === "pending")
    : args.includes("--approved")
      ? practices.filter((p) => p.status === "approved")
      : practices;

  if (wanted.length === 0) {
    out(
      args.includes("--pending")
        ? "no proposed practices waiting for review"
        : "no practices yet — they are drafted from tasks you steered or denied",
    );
    return 0;
  }

  for (const p of wanted) {
    out(formatPracticeLine(p));
  }
  const pending = wanted.filter((p) => p.status === "pending").length;
  if (pending > 0) {
    out("");
    out(
      `${pending} proposed — review with \`rewter practices show <slug>\`, then approve or reject`,
    );
  }
  return 0;
}

/** One practice, one line: status marker, slug, scope, then the fact itself. */
function formatPracticeLine(p: Practice): string {
  const marker = p.status === "pending" ? "?" : "✓";
  const scope =
    p.status === "pending"
      ? `proposed → ${p.projectSlug ?? "global"}`
      : (p.projectSlug ?? "global");
  return `${marker} ${p.slug}  [${scope}]  ${p.fact}`;
}

async function show(
  conn: Connection,
  fetchImpl: typeof globalThis.fetch,
  slug: string | undefined,
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  if (slug === undefined) {
    err("name a practice: rewter practices show <slug>");
    return 1;
  }
  const practices = await fetchPractices(conn, fetchImpl);
  if (typeof practices === "string") {
    err(practices);
    return 1;
  }
  const matches = practices.filter((p) => p.slug === slug);
  if (matches.length === 0) {
    err(`no such practice: ${slug}`);
    return 1;
  }
  for (const p of matches) {
    out(formatPracticeLine(p));
    out(`  file: ${p.path}`);
    if (p.learnedFrom !== null) out(`  learned from task ${p.learnedFrom}`);
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
    err(`name a practice: rewter practices ${verb} <slug>`);
    return 1;
  }
  const res = await fetchImpl(`${conn.baseUrl}/internal/practices/${slug}/${verb}`, {
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
  const body = (await res.json()) as { practice?: Practice };
  const where = body.practice?.projectSlug ?? "global";
  out(
    `approved ${slug} into ${where} — every task ${where === "global" ? "" : `in ${where} `}now carries it`,
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
