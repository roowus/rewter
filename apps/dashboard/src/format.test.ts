import { describe, expect, it } from "vitest";
import { clockTime, duration, elapsed, shortModelId, usd } from "./format.js";

describe("usd", () => {
  it("keeps digits on the amounts orchestration actually spends", () => {
    // A worker turn costs fractions of a cent. Two decimal places would print
    // `$0.00` beside every row and make the whole thing look free.
    expect(usd(0.0042)).toBe("$0.0042");
    expect(usd(0.00004)).toBe("$0.0000");
  });

  it("uses currency places once the amount is worth reading that way", () => {
    expect(usd(1.375)).toBe("$1.38");
    expect(usd(0.01)).toBe("$0.01");
  });

  it("prints a true zero as $0 rather than a suspiciously precise one", () => {
    // `$0.0000` reads as "too small to see"; `$0` reads as "nothing yet".
    expect(usd(0)).toBe("$0");
  });
});

describe("duration", () => {
  it("scales the unit to the magnitude", () => {
    expect(duration(840)).toBe("840ms");
    expect(duration(4200)).toBe("4.2s");
    expect(duration(42_000)).toBe("42s");
    expect(duration(246_000)).toBe("4m 06s");
  });
});

describe("elapsed", () => {
  it("measures a finished entity against when it finished", () => {
    expect(elapsed({ createdAt: 1000, finishedAt: 4000 }, 9_000_000)).toBe("3.0s");
  });

  it("measures a running one against the clock it was passed", () => {
    // `now` is a parameter so a render is a pure function of state; reading the
    // clock inside one is a test that passes at different times of day.
    expect(elapsed({ createdAt: 1000, finishedAt: null }, 3000)).toBe("2.0s");
  });
});

describe("shortModelId", () => {
  it("drops the provider half that repeats down a column", () => {
    expect(shortModelId("anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("leaves an unqualified id alone", () => {
    expect(shortModelId("llama3")).toBe("llama3");
  });
});

describe("clockTime", () => {
  it("includes seconds so two events in one minute are different lines", () => {
    expect(clockTime(1_756_252_800_000)).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });
});
