/**
 * The estimator's contract is directional, not exact: for the symbol-dense
 * content digests are made of, it must land AT OR ABOVE what a real BPE
 * tokenizer would count. An estimate that runs low silently pushes the
 * prompt-cache breakpoint (a per-request cost bug); one that runs high drops a
 * model with an honest note. Reference counts below are from OpenAI's cl100k
 * tokenizer, hand-checked — the floor the estimate must clear.
 */
import { describe, expect, it } from "vitest";
import { estimateTokens } from "./tokens.js";

describe("estimateTokens", () => {
  it("counts prose near 4 chars/token", () => {
    // "the quick brown fox jumps over the lazy dog" — cl100k: 9 tokens.
    const text = "the quick brown fox jumps over the lazy dog";
    const estimate = estimateTokens(text);
    expect(estimate).toBeGreaterThanOrEqual(9);
    expect(estimate).toBeLessThanOrEqual(14);
  });

  it("charges a full digest line well above 4 chars/token", () => {
    // The exact content class issue #8 names: ids with slashes and hyphens,
    // price strings. cl100k counts this 42-char line at 20 tokens — a flat
    // 4 chars/token estimate says 11 and runs the budget dry.
    const line = "zai/glm-5.3 — $0.6/$2.2 per MTok, 200K ctx";
    const estimate = estimateTokens(line);
    expect(estimate).toBeGreaterThanOrEqual(20);
    // But not absurdly high either — the budget still has to admit models.
    expect(estimate).toBeLessThanOrEqual(30);
  });

  it("charges bracketed tag lists at least their symbol count", () => {
    // cl100k: 15 tokens.
    const tags = "best:[coding,fast_cheap] — avoid:[vision]";
    expect(estimateTokens(tags)).toBeGreaterThanOrEqual(15);
  });

  it("splits long digit runs instead of treating them as words", () => {
    // "1000000" — cl100k: 3 tokens ("100","000","0"-ish). 7 chars at
    // 4 chars/token would say 2 and run low.
    expect(estimateTokens("1000000")).toBeGreaterThanOrEqual(3);
  });

  it("does not charge for whitespace", () => {
    expect(estimateTokens("a          b")).toBe(estimateTokens("a b"));
  });

  it("returns 0 for empty and whitespace-only input", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("   \n\t  ")).toBe(0);
  });

  it("is monotonic: appending text never lowers the estimate", () => {
    const base = "anthropic/claude-sonnet-5 — $3/$15 per MTok";
    expect(estimateTokens(`${base}, 200K ctx`)).toBeGreaterThanOrEqual(estimateTokens(base));
  });

  it("handles multi-byte punctuation without NaN or crash", () => {
    // The em dash is the digest's field separator; it must count as a token,
    // not explode the segmenter.
    expect(estimateTokens("———")).toBe(3);
  });
});
