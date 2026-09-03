/**
 * A tier-2 worker's tool surface.
 *
 * Declared the same way `orchestrator/tools.ts` declares the initiator's: JSON
 * Schema for the model and zod for us, written side by side so the pair cannot
 * drift, and a bad call returns a tool *result* rather than throwing. A worker
 * that dies because it passed a number where a string was wanted has burned a
 * whole subtask over something a one-turn correction would have fixed.
 *
 * The set is deliberately small. Every tool here is one a worker cannot do its
 * job without, because each one is also a way to reach the disk, and the gate in
 * `approvals.ts` has to be consulted from every single one of them.
 *
 * **`web_search` is conditional.** It is declared to a worker only when the
 * daemon has a search backend configured (`search.provider` in the config; see
 * `docs/design/web-search.md`). Offering a tool that returns an error every time
 * is worse than not having it — the model spends a turn discovering that, and
 * may well try again — so `workerToolDefinitions({ webSearch })` leaves it out
 * and `parseWorkerArgs` refuses it when there is nothing behind it.
 *
 * Two conventions the descriptions carry, because the model learns them nowhere
 * else: `edit_file` needs a *unique* anchor string, and `finish_report` is how a
 * run ends. A worker that never calls `finish_report` is a worker whose result
 * has to be scraped out of its last message.
 */
import type { ToolDefinition } from "@rewter/shared";
import { z } from "zod";

/** Bumped when the tool surface changes shape; snapshot-tested. */
export const WORKER_TOOLS_VERSION = 3;

const str = (description: string) => ({ type: "string", description }) as const;

/** A path as the worker wrote it. Kept verbatim for the approval prompt. */
const PathSchema = z.string().trim().min(1).max(4_000);

export const ReadFileArgs = z.object({
  path: PathSchema,
  /** 1-based, inclusive. Omitted means "from the top". */
  start_line: z.number().int().positive().optional(),
  max_lines: z.number().int().positive().max(5_000).optional(),
});

export const WriteFileArgs = z.object({
  path: PathSchema,
  content: z.string(),
});

export const EditFileArgs = z.object({
  path: PathSchema,
  old_text: z.string().min(1),
  new_text: z.string(),
});

export const ListDirArgs = z.object({
  path: PathSchema.default("."),
});

export const GlobArgs = z.object({
  pattern: z.string().trim().min(1).max(500),
  path: PathSchema.default("."),
});

export const GrepArgs = z.object({
  pattern: z.string().min(1).max(1_000),
  path: PathSchema.default("."),
  glob: z.string().trim().min(1).max(500).optional(),
});

export const ShellArgs = z.object({
  command: z.string().trim().min(1).max(10_000),
  /** Seconds. Capped hard: a worker cannot ask to hang forever. */
  timeout: z.number().int().positive().max(600).optional(),
});

export const WebFetchArgs = z.object({
  url: z.string().trim().min(1).max(4_000),
});

export const WebSearchArgs = z.object({
  query: z.string().trim().min(1).max(500),
  /** Capped further by the daemon's `search.maxResults`. */
  max_results: z.number().int().positive().max(20).optional(),
});

export const LoadSkillArgs = z.object({
  slug: z.string().trim().min(1).max(100),
});

export const ReportProgressArgs = z.object({
  note: z.string().trim().min(1).max(300),
});

export const FinishReportArgs = z.object({
  status: z.enum(["success", "failure", "partial"]),
  summary: z.string().trim().min(1).max(500),
  details: z.string().optional(),
  artifacts: z.array(z.string().trim().min(1)).max(50).optional(),
});

export interface WorkerTool {
  definition: ToolDefinition;
  schema: z.ZodTypeAny;
}

export const WORKER_TOOLS: Record<string, WorkerTool> = {
  read_file: {
    schema: ReadFileArgs,
    definition: {
      name: "read_file",
      description:
        "Read a text file. Returns numbered lines so you can quote them back to edit_file. " +
        "Large files are truncated — pass start_line and max_lines to page through one.",
      parameters: {
        type: "object",
        properties: {
          path: str("Absolute, or relative to your working directory."),
          start_line: { type: "integer", description: "1-based first line. Default 1." },
          max_lines: { type: "integer", description: "How many lines to return." },
        },
        required: ["path"],
      },
    },
  },

  write_file: {
    schema: WriteFileArgs,
    definition: {
      name: "write_file",
      description:
        "Create a file, or replace one entirely. Parent directories are created. This " +
        "discards any existing content, so prefer edit_file when the file already exists " +
        "and you only want part of it changed.",
      parameters: {
        type: "object",
        properties: {
          path: str("Absolute, or relative to your working directory."),
          content: str("The complete new contents of the file."),
        },
        required: ["path", "content"],
      },
    },
  },

  edit_file: {
    schema: EditFileArgs,
    definition: {
      name: "edit_file",
      description:
        "Replace one exact passage in a file. old_text must appear EXACTLY ONCE — include " +
        "enough surrounding lines to make it unique, or the edit is refused rather than " +
        "applied to the wrong place. Read the file first; do not guess at its contents.",
      parameters: {
        type: "object",
        properties: {
          path: str("Absolute, or relative to your working directory."),
          old_text: str("The exact text to replace, including indentation."),
          new_text: str("What to put there. Empty string deletes the passage."),
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },

  list_dir: {
    schema: ListDirArgs,
    definition: {
      name: "list_dir",
      description: "List one directory's entries, marking which are directories.",
      parameters: {
        type: "object",
        properties: { path: str("Directory. Default '.' — your working directory.") },
        required: [],
      },
    },
  },

  glob: {
    schema: GlobArgs,
    definition: {
      name: "glob",
      description:
        "Find files by name pattern, recursively. Use '**' to cross directories, e.g. " +
        "'src/**/*.ts'. Faster and cheaper than listing directories one at a time.",
      parameters: {
        type: "object",
        properties: {
          pattern: str("Glob pattern, e.g. '**/*.test.ts'."),
          path: str("Directory to search from. Default '.'."),
        },
        required: ["pattern"],
      },
    },
  },

  grep: {
    schema: GrepArgs,
    definition: {
      name: "grep",
      description:
        "Search file contents by regular expression, recursively. Returns matching lines " +
        "with their file and line number. Use this to find code, not to read it.",
      parameters: {
        type: "object",
        properties: {
          pattern: str("Regular expression."),
          path: str("Directory or file to search. Default '.'."),
          glob: str("Optional name filter, e.g. '*.ts'."),
        },
        required: ["pattern"],
      },
    },
  },

  shell: {
    schema: ShellArgs,
    definition: {
      name: "shell",
      description:
        "Run one shell command in your working directory. Anything that is not plainly " +
        "read-only needs the user's approval, which takes real time — so prefer the file " +
        "tools above for reading and editing, and use this for builds, tests and tooling. " +
        "Output is truncated to the last 32KB. There is no interactive input: a command " +
        "that waits for a prompt will hit the timeout.",
      parameters: {
        type: "object",
        properties: {
          command: str("The command line, run through a POSIX shell as `-c`."),
          timeout: { type: "integer", description: "Seconds before it is killed. Default 120." },
        },
        required: ["command"],
      },
    },
  },

  web_fetch: {
    schema: WebFetchArgs,
    definition: {
      name: "web_fetch",
      description:
        "Fetch a URL and return its text, with HTML reduced to readable content. " +
        "Truncated to the first 100KB.",
      parameters: {
        type: "object",
        properties: { url: str("Absolute http(s) URL.") },
        required: ["url"],
      },
    },
  },

  web_search: {
    schema: WebSearchArgs,
    definition: {
      name: "web_search",
      description:
        "Search the web. Returns a ranked list of results, each with a title, URL and " +
        "snippet — then use web_fetch on the URLs worth reading. Keep queries short and " +
        "specific; one good query beats three vague ones.",
      parameters: {
        type: "object",
        properties: {
          query: str("The search query."),
          max_results: { type: "integer", description: "How many results to return. Default 8." },
        },
        required: ["query"],
      },
    },
  },

  load_skill: {
    schema: LoadSkillArgs,
    definition: {
      name: "load_skill",
      description:
        "Fetch the full text of a learned skill by slug. If your instructions name a " +
        "skill, load it before starting and follow its procedure. Reads from the skill " +
        "library, not your workspace — it needs no approval.",
      parameters: {
        type: "object",
        properties: { slug: str("The skill's slug, e.g. 'deploy-checklist'.") },
        required: ["slug"],
      },
    },
  },

  report_progress: {
    schema: ReportProgressArgs,
    definition: {
      name: "report_progress",
      description:
        "Tell the user what you are doing, in one sentence. Shown live in their progress " +
        "feed. Use it before anything slow, so a long step does not look like a hang.",
      parameters: {
        type: "object",
        properties: { note: str("One sentence, present tense.") },
        required: ["note"],
      },
    },
  },

  finish_report: {
    schema: FinishReportArgs,
    definition: {
      name: "finish_report",
      description:
        "End your run and hand back the result. The summary is the ONE line the initiator " +
        "sees, so it must carry the answer, not describe that you finished — put the " +
        "reasoning in details, which it reads only if it needs to. Report status 'failure' " +
        "honestly: a wrong answer costs more than an admitted one.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["success", "failure", "partial"],
            description: "Did you accomplish the task you were given?",
          },
          summary: str("One line carrying the actual result."),
          details: str("Full findings, for the initiator to read on demand."),
          artifacts: {
            type: "array",
            items: { type: "string" },
            description: "Paths you created or changed.",
          },
        },
        required: ["status", "summary"],
      },
    },
  },
};

/**
 * Which tools are optional, and the option that switches each one on. Today that
 * is one tool; the shape is a table so the next backend-dependent tool adds a
 * row here rather than another `if` in the loop.
 */
export interface WorkerToolAvailability {
  /** A search backend is configured, so `web_search` has something to call. */
  webSearch: boolean;
}

/** Every tool, including the conditional ones. What the tests audit. */
export const WORKER_TOOL_DEFINITIONS: ToolDefinition[] = Object.values(WORKER_TOOLS).map(
  (t) => t.definition,
);

function isAvailable(name: string, availability: WorkerToolAvailability): boolean {
  return name !== "web_search" || availability.webSearch;
}

/** The names a worker may call on this daemon, in declaration order. */
export function availableWorkerToolNames(availability: WorkerToolAvailability): string[] {
  return Object.keys(WORKER_TOOLS).filter((name) => isAvailable(name, availability));
}

/**
 * The definitions to send with a chat request — the surface **this** daemon can
 * honour, which is the whole point of the conditional tool: a worker is told
 * about `web_search` only where calling it can succeed.
 */
export function workerToolDefinitions(availability: WorkerToolAvailability): ToolDefinition[] {
  return Object.entries(WORKER_TOOLS)
    .filter(([name]) => isAvailable(name, availability))
    .map(([, t]) => t.definition);
}

export type ParsedWorkerArgs = { ok: true; args: unknown } | { ok: false; error: string };

/**
 * Validate a tool call's arguments.
 *
 * Takes the raw JSON string off `ToolCall.arguments`, because that is what a
 * provider hands us — parsing it here rather than at each call site is what
 * keeps a malformed-JSON model reply from becoming a thrown error somewhere.
 * Like the orchestrator's `parseToolArgs`, every failure is a string for the
 * model to read and fix in one turn.
 *
 * `availability` defaults to everything, which is right for the tests that audit
 * schemas; the loop passes what it declared, so a model that calls an undeclared
 * `web_search` anyway (it happens — models remember tools from other runs) gets
 * the same "no such tool" answer it would for any invented name.
 */
export function parseWorkerArgs(
  name: string,
  rawArguments: string,
  availability: WorkerToolAvailability = { webSearch: true },
): ParsedWorkerArgs {
  const tool = isAvailable(name, availability) ? WORKER_TOOLS[name] : undefined;
  if (tool === undefined) {
    const known = availableWorkerToolNames(availability).join(", ");
    return { ok: false, error: `no such tool "${name}". Available: ${known}.` };
  }

  // An argument-less call arrives as "", "{}", or whitespace depending on the
  // provider; all three mean the same thing and none is a syntax error.
  const trimmed = rawArguments.trim();
  let value: unknown;
  try {
    value = trimmed === "" ? {} : JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      error: `arguments were not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = tool.schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `invalid arguments for ${name} — ${issues}` };
  }
  return { ok: true, args: parsed.data };
}
