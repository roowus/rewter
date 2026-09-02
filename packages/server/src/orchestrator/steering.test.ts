import { describe, expect, it } from "vitest";
import { parseSteering } from "./steering.js";

const ID = "apr_abc123def456";
const ID2 = "apr_zzz999yyy888";

describe("parseSteering", () => {
  it("reads a single approval command and leaves nothing behind", () => {
    const { commands, remainder } = parseSteering(`approve ${ID}`);
    expect(commands).toEqual([
      { decision: "approve", ids: [ID], labels: [], note: null, source: `approve ${ID}` },
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

  describe("worker-label keystrokes", () => {
    it("reads `a w1` / `d w1` as approve/deny of that worker", () => {
      expect(parseSteering("a w1").commands).toEqual([
        { decision: "approve", ids: [], labels: ["w1"], note: null, source: "a w1" },
      ]);
      expect(parseSteering("d w2").commands[0]).toMatchObject({
        decision: "deny",
        labels: ["w2"],
        ids: [],
      });
    });

    it("takes a space-separated note on the short form, because a keystroke has no colon", () => {
      const { commands, remainder } = parseSteering("d w1 too dangerous");
      expect(commands[0]).toMatchObject({
        decision: "deny",
        labels: ["w1"],
        note: "too dangerous",
      });
      expect(remainder).toBe("");
    });

    it("still takes a colon-note on the long form with a label", () => {
      expect(parseSteering("deny w1: use the fixture").commands[0]).toMatchObject({
        decision: "deny",
        labels: ["w1"],
        note: "use the fixture",
      });
    });

    it("accepts several labels the same way it accepts several ids", () => {
      for (const line of ["a w1 w2", "a w1, w2", "a w1 and w2", "approve w1 and w2"]) {
        expect(parseSteering(line).commands[0]?.labels, line).toEqual(["w1", "w2"]);
      }
    });

    it("accepts `a all` as the same blanket as `approve all`", () => {
      expect(parseSteering("a all").commands[0]?.ids).toBe("all");
      expect(parseSteering("d all").commands[0]?.decision).toBe("deny");
    });

    it("mixes an id and a label on one line without dropping either", () => {
      const { commands } = parseSteering(`approve ${ID} and w1`);
      expect(commands[0]?.ids).toEqual([ID]);
      expect(commands[0]?.labels).toEqual(["w1"]);
    });

    // Conservative: a lone letter, a letter plus prose, or a non-label word
    // after `a`/`d` must not be swallowed. "a plan" in particular would be a
    // disastrous false positive — it is how a person starts an instruction.
    it("leaves short-form prose that is not a label or an id alone", () => {
      const prose = [
        "a",
        "d",
        "a plan",
        "a the tests",
        "and then",
        "approve w",
        "a w0",
        "a worker 1",
        "d wait for it",
      ];
      for (const line of prose) {
        const { commands, remainder } = parseSteering(line);
        expect(commands, line).toHaveLength(0);
        expect(remainder).toBe(line);
      }
    });
  });
});
