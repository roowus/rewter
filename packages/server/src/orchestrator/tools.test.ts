/**
 * Tool-surface tests.
 *
 * The one this file exists for is the parity test the module header promises:
 * every tool is declared twice — once as JSON Schema (what the model is shown)
 * and once as zod (what we trust) — and a field that exists in one but not the
 * other is a silent failure. The model would be told about an argument we
 * discard, or we would reject an argument the model was never told to send.
 *
 * The rest pin the "never throw at the model" discipline: a hallucinated tool
 * name, malformed JSON, and a wrong-typed field are all *results*, phrased so
 * the model can fix them in one turn.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  INITIATOR_TOOLS,
  INITIATOR_TOOL_DEFINITIONS,
  ORCHESTRATOR_TOOLS_VERSION,
  parseToolArgs,
} from "./tools.js";

/** The JSON-Schema half, typed only as far as this test needs to read it. */
interface JsonSchemaObject {
  type: string;
  properties: Record<string, unknown>;
  required?: string[];
}

function jsonSchema(name: string): JsonSchemaObject {
  const tool = INITIATOR_TOOLS[name];
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.definition.parameters as unknown as JsonSchemaObject;
}

function zodShape(name: string): Record<string, z.ZodTypeAny> {
  const tool = INITIATOR_TOOLS[name];
  if (tool === undefined) throw new Error(`no tool ${name}`);
  const schema = tool.schema;
  if (!(schema instanceof z.ZodObject)) throw new Error(`${name}'s schema is not an object`);
  return schema.shape as Record<string, z.ZodTypeAny>;
}

const TOOL_NAMES = Object.keys(INITIATOR_TOOLS);

describe("the tool surface", () => {
  it("declares the tools the M5 engine dispatches, and no more", () => {
    // `send_to_worker` is deliberately absent until tier 2 — a tier-1 worker has
    // no inbox, so declaring it would offer the initiator something that cannot
    // work. This assertion is what makes that omission deliberate rather than
    // forgotten.
    expect(TOOL_NAMES.sort()).toEqual(
      [
        "ask_user",
        "cancel_worker",
        "finish",
        "get_result",
        "handoff",
        "plan_note",
        "spawn_worker",
        "wait",
      ].sort(),
    );
    expect(TOOL_NAMES).not.toContain("send_to_worker");
  });

  it("keeps the version constant in step with the surface", () => {
    expect(ORCHESTRATOR_TOOLS_VERSION).toBe(2);
  });

  it("exports one definition per tool, each with the name it is keyed under", () => {
    expect(INITIATOR_TOOL_DEFINITIONS).toHaveLength(TOOL_NAMES.length);
    for (const [name, tool] of Object.entries(INITIATOR_TOOLS)) {
      expect(tool.definition.name).toBe(name);
      expect(tool.definition.description.length).toBeGreaterThan(20);
    }
  });
});

describe("JSON Schema / zod parity", () => {
  it.each(TOOL_NAMES)("%s declares the same properties on both sides", (name) => {
    const json = jsonSchema(name);
    expect(json.type).toBe("object");

    const jsonKeys = Object.keys(json.properties).sort();
    const zodKeys = Object.keys(zodShape(name)).sort();
    expect(jsonKeys).toEqual(zodKeys);
  });

  it.each(TOOL_NAMES)("%s agrees on which properties are required", (name) => {
    const shape = zodShape(name);
    // `isOptional()` is true for both `.optional()` and `.default()` — and a
    // defaulted field is exactly one the model need not send, so the two halves
    // should agree on it too.
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

describe("parseToolArgs", () => {
  it("names the available tools when the model invents one", () => {
    const parsed = parseToolArgs("spawn_agent", "{}");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('no such tool "spawn_agent"');
    // The fix has to be in the message, or the correction costs an extra turn.
    expect(parsed.error).toContain("spawn_worker");
  });

  it("treats an argument-less call as an empty object in all three spellings", () => {
    for (const raw of ["", "  ", "{}"]) {
      const parsed = parseToolArgs("wait", raw);
      expect(parsed.ok, `raw=${JSON.stringify(raw)}`).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.args).toEqual({ mode: "all" });
    }
  });

  it("reports malformed JSON as a message rather than throwing", () => {
    const parsed = parseToolArgs("plan_note", '{"note": "unterminated');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("not valid JSON");
  });

  it("names the offending field when arguments do not fit", () => {
    const parsed = parseToolArgs("spawn_worker", JSON.stringify({ title: "x", model: "" }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("invalid arguments");
    expect(parsed.error).toContain("model");
    expect(parsed.error).toContain("instructions");
  });

  it("defaults a spawn to tier 1", () => {
    const parsed = parseToolArgs(
      "spawn_worker",
      JSON.stringify({ title: "t", model: "m", instructions: "do it" }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args).toMatchObject({ tier: 1 });
  });

  it("normalizes worker labels so W1 and ' w1 ' address the same worker", () => {
    for (const raw of ["W1", " w1 ", "w1"]) {
      const parsed = parseToolArgs("get_result", JSON.stringify({ label: raw }));
      expect(parsed.ok, `raw=${JSON.stringify(raw)}`).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.args).toEqual({ label: "w1" });
    }
  });

  it("rejects a label that is not a worker label at all", () => {
    const parsed = parseToolArgs("cancel_worker", JSON.stringify({ label: "the first one" }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('worker label like "w1"');
  });

  it("accepts a wait for named labels in either mode", () => {
    const parsed = parseToolArgs("wait", JSON.stringify({ labels: ["w1", "W2"], mode: "any" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args).toEqual({ labels: ["w1", "w2"], mode: "any" });
  });

  it("rejects a tier outside the ladder", () => {
    const parsed = parseToolArgs(
      "spawn_worker",
      JSON.stringify({ title: "t", model: "m", instructions: "i", tier: 4 }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("does not accept an empty final answer", () => {
    expect(parseToolArgs("finish", JSON.stringify({ answer: "" })).ok).toBe(false);
    expect(parseToolArgs("finish", JSON.stringify({ answer: "done." })).ok).toBe(true);
  });

  it("accepts a JSON array or scalar without throwing", () => {
    // Some providers emit `[]` or `null` for a no-argument call.
    for (const raw of ["[]", "null", '"hi"', "3"]) {
      const parsed = parseToolArgs("plan_note", raw);
      expect(parsed.ok, `raw=${raw}`).toBe(false);
    }
  });
});
