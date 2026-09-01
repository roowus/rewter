/**
 * The tier-2 tool surface.
 *
 * Same two properties as the initiator's surface, for the same reasons: the
 * JSON-Schema half and the zod half must agree field for field (or the model is
 * told about an argument we discard, or we reject one it was never told to
 * send), and a bad call must come back as a *result* the model can fix in one
 * turn rather than an exception that ends the subtask.
 *
 * One extra assertion carries its weight here: the exact tool-name list. It is
 * what makes `web_search`'s absence a decision — there is no search backend, so
 * declaring it would hand a worker a tool that fails every time — rather than
 * something that fell out during editing.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WORKER_TOOLS,
  WORKER_TOOLS_VERSION,
  WORKER_TOOL_DEFINITIONS,
  parseWorkerArgs,
} from "./tools.js";

/** The JSON-Schema half, typed only as far as this test reads it. */
interface JsonSchemaObject {
  type: string;
  properties: Record<string, unknown>;
  required?: string[];
}

function jsonSchema(name: string): JsonSchemaObject {
  const tool = WORKER_TOOLS[name];
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.definition.parameters as unknown as JsonSchemaObject;
}

function zodShape(name: string): Record<string, z.ZodTypeAny> {
  const tool = WORKER_TOOLS[name];
  if (tool === undefined) throw new Error(`no tool ${name}`);
  const schema = tool.schema;
  if (!(schema instanceof z.ZodObject)) throw new Error(`${name}'s schema is not an object`);
  return schema.shape as Record<string, z.ZodTypeAny>;
}

const TOOL_NAMES = Object.keys(WORKER_TOOLS);

describe("the worker tool surface", () => {
  it("declares exactly the tools the tier-2 loop dispatches", () => {
    // `web_search` is absent on purpose: there is no search backend to call, and
    // a tool that errors every time costs a turn to discover and invites a
    // retry. This assertion is what keeps that a decision. Most of these live in
    // execute.ts; `load_skill`, `report_progress` and `finish_report` are the
    // loop's own (they never touch the workspace).
    expect(TOOL_NAMES.sort()).toEqual(
      [
        "edit_file",
        "finish_report",
        "glob",
        "grep",
        "list_dir",
        "load_skill",
        "read_file",
        "report_progress",
        "shell",
        "web_fetch",
        "write_file",
      ].sort(),
    );
    expect(TOOL_NAMES).not.toContain("web_search");
  });

  it("keeps the version constant in step with the surface", () => {
    expect(WORKER_TOOLS_VERSION).toBe(2);
  });

  it("exports one definition per tool, each with the name it is keyed under", () => {
    expect(WORKER_TOOL_DEFINITIONS).toHaveLength(TOOL_NAMES.length);
    for (const [name, tool] of Object.entries(WORKER_TOOLS)) {
      expect(tool.definition.name).toBe(name);
      expect(tool.definition.description.length).toBeGreaterThan(20);
    }
  });

  it("tells the worker how a run ends", () => {
    // The loop needs `finish_report` to be called, and the only place the model
    // learns that is this description.
    const finish = WORKER_TOOLS.finish_report;
    expect(finish?.definition.description).toContain("End your run");
  });
});

describe("JSON Schema / zod parity", () => {
  it.each(TOOL_NAMES)("%s declares the same properties on both sides", (name) => {
    const json = jsonSchema(name);
    expect(json.type).toBe("object");
    expect(Object.keys(json.properties).sort()).toEqual(Object.keys(zodShape(name)).sort());
  });

  it.each(TOOL_NAMES)("%s agrees on which properties are required", (name) => {
    const shape = zodShape(name);
    // `isOptional()` covers `.optional()` and `.default()` alike, and a defaulted
    // field is exactly one the model need not send.
    const zodRequired = Object.entries(shape)
      .filter(([, schema]) => !schema.isOptional())
      .map(([key]) => key)
      .sort();
    expect([...(jsonSchema(name).required ?? [])].sort()).toEqual(zodRequired);
  });

  it.each(TOOL_NAMES)("%s describes every property to the model", (name) => {
    for (const [key, prop] of Object.entries(jsonSchema(name).properties)) {
      const described = (prop as { description?: string }).description ?? "";
      expect(described.length, `${name}.${key} has no description`).toBeGreaterThan(0);
    }
  });
});

describe("parseWorkerArgs", () => {
  it("names the available tools when the model invents one", () => {
    const parsed = parseWorkerArgs("bash", "{}");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('no such tool "bash"');
    // The fix belongs in the message, or the correction costs an extra turn.
    expect(parsed.error).toContain("shell");
  });

  it("treats an argument-less call as an empty object in all three spellings", () => {
    for (const raw of ["", "  ", "{}"]) {
      const parsed = parseWorkerArgs("list_dir", raw);
      expect(parsed.ok, `raw=${JSON.stringify(raw)}`).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.args).toEqual({ path: "." });
    }
  });

  it("reports malformed JSON as a message rather than throwing", () => {
    const parsed = parseWorkerArgs("read_file", '{"path": "unterminated');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("not valid JSON");
  });

  it("names the offending field when arguments do not fit", () => {
    const parsed = parseWorkerArgs("read_file", JSON.stringify({ path: 42 }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("invalid arguments for read_file");
    expect(parsed.error).toContain("path");
  });

  it("rejects an empty path rather than resolving it to the workspace root", () => {
    // `resolve(cwd, "")` is `cwd`, so an empty path would silently mean "the
    // working directory" — a delete or write there is not what the model asked
    // for, and the schema is the cheapest place to stop it.
    for (const path of ["", "   "]) {
      expect(parseWorkerArgs("write_file", JSON.stringify({ path, content: "x" })).ok).toBe(false);
    }
  });

  it("keeps an empty write as a legitimate way to truncate a file", () => {
    const parsed = parseWorkerArgs("write_file", JSON.stringify({ path: "a.txt", content: "" }));
    expect(parsed.ok).toBe(true);
  });

  it("requires a non-empty edit anchor but allows an empty replacement", () => {
    // Empty `new_text` is how a passage gets deleted; empty `old_text` would
    // match everywhere and is refused.
    expect(
      parseWorkerArgs("edit_file", JSON.stringify({ path: "a", old_text: "", new_text: "b" })).ok,
    ).toBe(false);
    expect(
      parseWorkerArgs("edit_file", JSON.stringify({ path: "a", old_text: "b", new_text: "" })).ok,
    ).toBe(true);
  });

  it("trims a path so ' src ' and 'src' name the same directory", () => {
    const parsed = parseWorkerArgs("list_dir", JSON.stringify({ path: "  src  " }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args).toEqual({ path: "src" });
  });

  it("caps a shell timeout rather than letting a worker ask to hang forever", () => {
    expect(parseWorkerArgs("shell", JSON.stringify({ command: "ls", timeout: 600 })).ok).toBe(true);
    expect(parseWorkerArgs("shell", JSON.stringify({ command: "ls", timeout: 601 })).ok).toBe(
      false,
    );
    expect(parseWorkerArgs("shell", JSON.stringify({ command: "ls", timeout: 0 })).ok).toBe(false);
  });

  it("defaults glob and grep to the working directory", () => {
    const g = parseWorkerArgs("glob", JSON.stringify({ pattern: "**/*.ts" }));
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.args).toEqual({ pattern: "**/*.ts", path: "." });

    const r = parseWorkerArgs("grep", JSON.stringify({ pattern: "TODO" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual({ pattern: "TODO", path: "." });
  });

  it("accepts only the three report statuses", () => {
    for (const status of ["success", "failure", "partial"]) {
      expect(parseWorkerArgs("finish_report", JSON.stringify({ status, summary: "s" })).ok).toBe(
        true,
      );
    }
    expect(
      parseWorkerArgs("finish_report", JSON.stringify({ status: "ok", summary: "s" })).ok,
    ).toBe(false);
  });

  it("does not accept an empty report summary", () => {
    // The summary is the one line the initiator sees; empty makes the run
    // useless to it even though the work may have succeeded.
    expect(
      parseWorkerArgs("finish_report", JSON.stringify({ status: "success", summary: "" })).ok,
    ).toBe(false);
  });

  it("accepts a JSON array or scalar without throwing", () => {
    // Some providers emit `[]` or `null` for a no-argument call.
    for (const raw of ["[]", "null", '"hi"', "3"]) {
      expect(parseWorkerArgs("read_file", raw).ok, `raw=${raw}`).toBe(false);
    }
  });
});
