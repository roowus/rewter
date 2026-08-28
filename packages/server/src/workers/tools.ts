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
 * **`web_search` from the design is absent**, and not by oversight: there is no
 * search backend to call. Declaring it would offer a worker a tool that returns
 * an error every time, which is worse than not having it — the model spends a
 * turn discovering that, and may well try again. It lands when a provider does.
 *
 * Two conventions the descriptions carry, because the model learns them nowhere
 * else: `edit_file` needs a *unique* anchor string, and `finish_report` is how a
 * run ends. A worker that never calls `finish_report` is a worker whose result
 * has to be scraped out of its last message.
 */
import type { ToolDefinition } from "@rewter/shared";
import { z } from "zod";

/** Bumped when the tool surface changes shape; snapshot-tested. */
export const WORKER_TOOLS_VERSION = 1;

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
          command: str("The command line, run through zsh -c."),
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

/** The definitions to send with a chat request. */
export const WORKER_TOOL_DEFINITIONS: ToolDefinition[] = Object.values(WORKER_TOOLS).map(
  (t) => t.definition,
);

export type ParsedWorkerArgs = { ok: true; args: unknown } | { ok: false; error: string };

/**
 * Validate a tool call's arguments.
 *
 * Takes the raw JSON string off `ToolCall.arguments`, because that is what a
 * provider hands us — parsing it here rather than at each call site is what
 * keeps a malformed-JSON model reply from becoming a thrown error somewhere.
 * Like the orchestrator's `parseToolArgs`, every failure is a string for the
 * model to read and fix in one turn.
 */
export function parseWorkerArgs(name: string, rawArguments: string): ParsedWorkerArgs {
  const tool = WORKER_TOOLS[name];
  if (tool === undefined) {
    const known = Object.keys(WORKER_TOOLS).join(", ");
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
