/**
 * Card generation. Almost every test here is the same question from a different
 * angle: what happens when the generator — an LLM, and therefore an unreliable
 * narrator — returns something other than what we asked for? The answer must
 * always be "a usable card, or a named failure", never a bad row in the
 * registry and never a thrown stack.
 */
import type { CapabilityCard, ChatMessage, ChatResponse, Model } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { model as fixtureModel } from "../testing/registry.js";
import {
  CAPABILITY_TAGS,
  CARD_SYSTEM_PROMPT,
  CardError,
  type CardTarget,
  buildCardMessages,
  formatCard,
  formatCardReport,
  generateCard,
  generateCards,
  parseCardJson,
} from "./cards.js";

const GLM = fixtureModel("zai/glm-5.3", undefined, {
  contextWindow: 1_000_000,
  pricing: {
    inputPerMTok: 0.6,
    outputPerMTok: 2.2,
    cacheReadPerMTok: null,
    cacheWritePerMTok: null,
  },
});
const SONNET = fixtureModel("anthropic/claude-sonnet-5");

const GOOD = JSON.stringify({
  summary: "Cheap 1M-context workhorse; strong at code, weak at hard math.",
  strengths: ["coding", "long_context", "fast_cheap"],
  weaknesses: ["math"],
  bestAt: ["coding", "long_context"],
  notes: "Prefers explicit output-format instructions.",
});

/** A generator that replies with fixed text, and records what it was asked. */
function scripted(replies: string[] | ((n: number) => string)) {
  const calls: ChatMessage[][] = [];
  let n = 0;
  return {
    calls,
    resolve: (id: string) => ({ model: fixtureModel(id) }),
    async complete(req: { model: string; messages: ChatMessage[] }): Promise<ChatResponse> {
      calls.push(req.messages);
      const content = typeof replies === "function" ? replies(n) : (replies[n] ?? replies[0] ?? "");
      n += 1;
      return {
        message: { role: "assistant", content },
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

/** An in-memory CardTarget — storage policy is `db/cards.test.ts`'s job, not this file's. */
function target(
  models: Model[] = [GLM],
  cards: CapabilityCard[] = [],
): CardTarget & {
  stored: Map<string, CapabilityCard>;
} {
  const stored = new Map(cards.map((c) => [String(c.modelId), c]));
  return {
    stored,
    getModel: (id) => models.find((m) => m.id === id),
    listModels: () => models,
    getCard: (id) => stored.get(id),
    upsertCard(card) {
      stored.set(String(card.modelId), card);
      return card;
    },
  };
}

const OPTS = { using: "anthropic/claude-sonnet-5", now: () => 1_756_252_800_000 };

describe("buildCardMessages", () => {
  it("offers the whole tag vocabulary, so a new tag cannot go unused", () => {
    // The prompt interpolates the schema rather than a retyped list; if that
    // ever drifts, a tag exists that the generator is never told about.
    for (const tag of CAPABILITY_TAGS) expect(CARD_SYSTEM_PROMPT).toContain(tag);
  });

  it("states the facts we already hold instead of asking for them", () => {
    const [, user] = buildCardMessages(GLM);
    expect(user?.content).toContain("1000000 tokens");
    expect(user?.content).toContain("$0.6");
    expect(user?.content).toContain("zai/glm-5.3");
  });

  it("says a missing price is unknown rather than free", () => {
    const priceless = fixtureModel("x/y", undefined, {
      pricing: {
        inputPerMTok: null,
        outputPerMTok: null,
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
      },
    });
    expect(buildCardMessages(priceless)[1]?.content).toContain("in unknown, out unknown");
  });
});

describe("parseCardJson", () => {
  it("reads a clean reply", () => {
    const { draft, unknownTags, contradictions } = parseCardJson(GOOD);
    expect(draft.bestAt).toEqual(["coding", "long_context"]);
    expect(draft.weaknesses).toEqual(["math"]);
    expect(draft.notes).toBe("Prefers explicit output-format instructions.");
    expect(unknownTags).toEqual([]);
    expect(contradictions).toEqual([]);
  });

  it("digs the object out of a fenced, prefaced reply", () => {
    const raw = `Sure! Here is the card:\n\n\`\`\`json\n${GOOD}\n\`\`\`\n\nHope that helps.`;
    expect(parseCardJson(raw).draft.summary).toContain("workhorse");
  });

  it("does not let trailing prose with a brace swallow the parse", () => {
    // Slicing to the *last* `}` — the obvious implementation — breaks here.
    const raw = `${GOOD}\n\nNote: use {curly} braces carefully.`;
    expect(parseCardJson(raw).draft.strengths).toContain("coding");
  });

  it("drops invented tags instead of losing the good ones with them", () => {
    const { draft, unknownTags } = parseCardJson(
      JSON.stringify({
        summary: "s",
        strengths: ["coding", "vibes", "agentic"],
        bestAt: ["coding"],
      }),
    );
    expect(draft.strengths).toEqual(["coding"]);
    expect(unknownTags).toEqual(["vibes", "agentic"]);
  });

  it("normalizes case and whitespace on tags, and dedupes", () => {
    const { draft, unknownTags } = parseCardJson(
      JSON.stringify({ summary: "s", strengths: [" Coding ", "CODING", "reasoning"] }),
    );
    expect(draft.strengths).toEqual(["coding", "reasoning"]);
    expect(unknownTags).toEqual([]);
  });

  it("resolves good-and-bad-at-the-same-thing in favour of the weakness", () => {
    // A false strength gets the model chosen for work it bills for and fails;
    // a false weakness only forgoes an option. Asymmetric, so weakness wins.
    const { draft, contradictions } = parseCardJson(
      JSON.stringify({
        summary: "s",
        strengths: ["math", "coding"],
        weaknesses: ["math"],
        bestAt: ["math"],
      }),
    );
    expect(draft.strengths).toEqual(["coding"]);
    expect(draft.bestAt).toEqual([]);
    expect(draft.weaknesses).toEqual(["math"]);
    expect(contradictions).toEqual(["math"]);
  });

  it("collapses a multi-line summary — the digest is one line per model", () => {
    const { draft } = parseCardJson(JSON.stringify({ summary: "first line\n\nsecond   line" }));
    expect(draft.summary).toBe("first line second line");
  });

  it("truncates a summary that would blow the digest budget", () => {
    const { draft } = parseCardJson(JSON.stringify({ summary: "word ".repeat(100) }));
    expect(draft.summary.length).toBeLessThanOrEqual(181);
    expect(draft.summary.endsWith("…")).toBe(true);
  });

  it("defaults the lists, so a minimal reply still yields a card", () => {
    const { draft } = parseCardJson(JSON.stringify({ summary: "I do not know this model." }));
    expect(draft).toMatchObject({ strengths: [], weaknesses: [], bestAt: [], notes: null });
  });

  it("throws when there is no card to be had", () => {
    expect(() => parseCardJson("I'm sorry, I can't help with that.")).toThrow(CardError);
    // Unterminated: the extractor counts braces, so this never reaches JSON.parse.
    expect(() => parseCardJson('{"summary": "x"')).toThrow(/no JSON object/);
    // Balanced but not JSON — unquoted keys are the classic LLM slip.
    expect(() => parseCardJson("{summary: 'x'}")).toThrow(/invalid JSON/);
    expect(() => parseCardJson(JSON.stringify({ strengths: ["coding"] }))).toThrow(/schema/);
  });
});

describe("generateCard", () => {
  it("stores a card stamped with who wrote it and when", async () => {
    const t = target();
    const result = await generateCard(scripted([GOOD]), t, GLM, OPTS);
    expect(result.card?.generatedBy).toBe("anthropic/claude-sonnet-5");
    expect(result.card?.generatedAt).toBe(OPTS.now());
    expect(t.stored.get("zai/glm-5.3")?.summary).toContain("workhorse");
  });

  it("never authors the override half", async () => {
    // The card writes only the generated half; a generated `userOverrides`
    // would be a claim about a column this code cannot see.
    const result = await generateCard(scripted([GOOD]), target(), GLM, OPTS);
    expect(result.card?.userOverrides).toBeNull();
  });

  it("returns the card but writes nothing on dryRun", async () => {
    const t = target();
    const result = await generateCard(scripted([GOOD]), t, GLM, { ...OPTS, dryRun: true });
    expect(result.card?.summary).toContain("workhorse");
    expect(t.stored.size).toBe(0);
  });

  it("reports an upstream failure as a result, not a throw", async () => {
    const generator = {
      resolve: (id: string) => ({ model: fixtureModel(id) }),
      complete: async () => {
        throw new Error("429 rate limited");
      },
    };
    const result = await generateCard(generator, target(), GLM, OPTS);
    expect(result.error).toContain("429");
    expect(result.card).toBeUndefined();
  });

  it("reports an unparseable reply as a result, not a throw", async () => {
    const result = await generateCard(scripted(["nope"]), target(), GLM, OPTS);
    expect(result.error).toContain("no JSON object");
  });

  it("asks the generator by resolved id, so a bare name is not sent upstream", async () => {
    const generator = scripted([GOOD]);
    const seen: string[] = [];
    const spy = {
      ...generator,
      async complete(req: { model: string; messages: ChatMessage[] }) {
        seen.push(req.model);
        return await generator.complete(req);
      },
    };
    await generateCard(spy, target(), GLM, { ...OPTS, using: "claude-sonnet-5" });
    // `resolve` expands the loose name; that expansion is what gets billed.
    expect(seen).toEqual(["claude-sonnet-5"]);
  });
});

describe("generateCards", () => {
  it("skips models that already have a card — regeneration costs money", async () => {
    const existing = (await generateCard(scripted([GOOD]), target(), GLM, OPTS)).card;
    const t = target([GLM, SONNET], existing === undefined ? [] : [existing]);
    const generator = scripted([GOOD]);
    const report = await generateCards(generator, t, [GLM, SONNET], OPTS);
    expect(report.results.map((r) => r.modelId)).toEqual(["anthropic/claude-sonnet-5"]);
    expect(generator.calls).toHaveLength(1);
  });

  it("rewrites them under regenerate", async () => {
    const existing = (await generateCard(scripted([GOOD]), target(), GLM, OPTS)).card;
    const t = target([GLM], existing === undefined ? [] : [existing]);
    const report = await generateCards(scripted([GOOD]), t, [GLM], { ...OPTS, regenerate: true });
    expect(report.results).toHaveLength(1);
  });

  it("keeps going after one model fails", async () => {
    const t = target([GLM, SONNET]);
    const report = await generateCards(scripted(["nope", GOOD]), t, [GLM, SONNET], OPTS);
    expect(report.results[0]?.error).toBeDefined();
    expect(report.results[1]?.card).toBeDefined();
    expect(t.stored.size).toBe(1);
  });
});

describe("formatting", () => {
  it("prints a card a human can check", async () => {
    const { card } = await generateCard(scripted([GOOD]), target(), GLM, OPTS);
    const text = formatCard(card as CapabilityCard);
    expect(text).toContain("zai/glm-5.3");
    expect(text).toContain("best at:    coding, long_context");
    expect(text).toContain("written by: anthropic/claude-sonnet-5");
  });

  it("shows an empty list as a dash rather than nothing", async () => {
    const { card } = await generateCard(
      scripted([JSON.stringify({ summary: "unknown model" })]),
      target(),
      GLM,
      OPTS,
    );
    expect(formatCard(card as CapabilityCard)).toContain("weaknesses: —");
  });

  it("says what it threw away", async () => {
    const reply = JSON.stringify({
      summary: "s",
      strengths: ["coding", "vibes"],
      weaknesses: ["coding"],
    });
    const report = await generateCards(scripted([reply]), target(), [GLM], OPTS);
    const text = formatCardReport(report);
    expect(text).toContain("vibes");
    expect(text).toContain("kept as weaknesses");
  });

  it("says so when there was nothing to do", async () => {
    const existing = (await generateCard(scripted([GOOD]), target(), GLM, OPTS)).card;
    const t = target([GLM], existing === undefined ? [] : [existing]);
    const report = await generateCards(scripted([GOOD]), t, [GLM], OPTS);
    expect(formatCardReport(report)).toContain("already has a card");
  });
});
