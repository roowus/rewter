import { describe, expect, it } from "vitest";
import { parseSteering } from "./steering.js";

const ID = "apr_abc123def456";
const ID2 = "apr_zzz999yyy888";

describe("parseSteering", () => {
  it("reads a single approval command and leaves nothing behind", () => {
    const { commands, remainder } = parseSteering(`approve ${ID}`);
    expect(commands).toEqual([
      { decision: "approve", ids: [ID], note: null, source: `approve ${ID}` },
    ]);
    expect(remainder).toBe("");
  });

  it("reads a denial, and treats `reject` as the same decision", () => {
    expect(parseSteering(`deny ${ID}`).commands[0]?.decision).toBe("deny");
    expect(parseSteering(`reject ${ID}`).commands[0]?.decision).toBe("deny");
  });

  it("understands `all` as a blanket decision", () => {
    expect(parseSteering("approve all").commands[0]?.ids).toBe("all");
    expect(parseSteering("deny all").commands[0]?.ids).toBe("all");
  });

  it("takes several ids off one line, however they are separated", () => {
    const cases = [`approve ${ID} ${ID2}`, `approve ${ID}, ${ID2}`, `approve ${ID} and ${ID2}`];
    for (const line of cases) {
      expect(parseSteering(line).commands[0]?.ids).toEqual([ID, ID2]);
    }
  });

  it("carries a note through, so a denial can say why", () => {
    const { commands } = parseSteering(`deny ${ID}: use the fixture instead`);
    expect(commands[0]?.note).toBe("use the fixture instead");
  });

  it("accepts an id a terminal upcased", () => {
    expect(parseSteering(`approve ${ID.toUpperCase()}`).commands[0]?.ids).toEqual([ID]);
  });

  it("keeps commands and steering from one message, in the same message", () => {
    const { commands, remainder } = parseSteering(
      `approve ${ID}\nthen move on to the integration tests\ndeny ${ID2}`,
    );
    expect(commands.map((c) => c.decision)).toEqual(["approve", "deny"]);
    expect(remainder).toBe("then move on to the integration tests");
  });

  // The conservative half of the contract: consuming a line hides it from the
  // initiator, so anything that is not unambiguously a command must survive.
  it("leaves prose that merely mentions approving alone", () => {
    const prose = [
      "approve the plan and carry on",
      "please approve whichever of those you think is right",
      "I approved it in the dashboard already",
      "approve",
      `looks good — approve ${ID} if you agree`,
      `the approval id was ${ID}`,
    ];
    for (const line of prose) {
      const { commands, remainder } = parseSteering(line);
      expect(commands, line).toHaveLength(0);
      expect(remainder).toBe(line);
    }
  });

  it("does not treat a malformed id as a command", () => {
    const line = "approve apr_short";
    expect(parseSteering(line).commands).toHaveLength(0);
    expect(parseSteering(line).remainder).toBe(line);
  });

  it("returns an empty parse for an empty message", () => {
    expect(parseSteering("")).toEqual({ commands: [], remainder: "" });
  });
});
