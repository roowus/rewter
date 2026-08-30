/**
 * The dialect panel's endpoint.
 *
 * Two things are worth testing here and the rest is plumbing. First: the two
 * downstream dialects converge — the *same* conversation written as OpenAI and
 * as Anthropic must normalize to the same `ChatMessage[]`, because that
 * convergence is the claim the router rests on and this is the only place it is
 * asserted directly. Second: describing sends nothing. The panel renders on
 * keystrokes, so a describe path that could reach an upstream would bill the
 * user per character.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { Router } from "../router/router.js";
import { PRV_A, PRV_B, model, provider } from "../testing/registry.js";
import { buildApp } from "./app.js";

const NOW = 1_756_252_800_000;
const GPT = "openai/gpt-5";
const CLAUDE = "anthropic/claude-sonnet-5";
const GEMINI = "google/gemini-3-pro";

let db: Db;
let repos: Repos;
let app: FastifyInstance;

beforeEach(() => {
  db = openDb(":memory:");
  const bus = new EventBus(db, () => NOW);
  repos = new Repos(db, bus, () => NOW);
  repos.upsertProvider(provider(PRV_A, { name: "OpenAI", kind: "openai-compat" }));
  repos.upsertProvider(
    provider(PRV_B, {
      name: "Anthropic",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.test",
    }),
  );
  repos.upsertModel(model(GPT, PRV_A));
  repos.upsertModel(model(CLAUDE, PRV_B));
  app = buildApp({ router: new Router({ repos }), repos, bus, clock: () => NOW });
});

afterEach(async () => {
  await app?.close();
});

const translate = (payload: object) =>
  app.inject({ method: "POST", url: "/internal/translate", payload });

describe("POST /internal/translate", () => {
  it("shows an OpenAI request at all three stages", async () => {
    const res = await translate({
      dialect: "openai",
      body: {
        model: GPT,
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
        ],
        max_tokens: 100,
        temperature: 0.5,
      },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json();

    expect(out.normalized).toEqual({
      model: GPT,
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      maxTokens: 100,
      temperature: 0.5,
    });
    expect(out.resolution).toMatchObject({
      modelId: GPT,
      providerName: "OpenAI",
      providerKind: "openai-compat",
      // The slug is ours; `gpt-5` is what the upstream is asked for.
      upstreamId: "gpt-5",
    });
    expect(out.upstream.kind).toBe("openai-compat");
    expect(out.upstream.path).toBe("/chat/completions");
    // Not `max_tokens`: this provider matches the OpenAI preset, whose
    // `maxCompletionTokens` quirk renames the field. A quirk silently changing
    // the wire is precisely what the panel is for — so it is asserted, not
    // worked around.
    expect(out.upstream.body).toMatchObject({ model: "gpt-5", max_completion_tokens: 100 });
    expect(out.upstream.body.max_tokens).toBeUndefined();
    expect(out.note).toBeNull();
  });

  /**
   * The convergence claim, asserted directly. `/v1/chat/completions` and
   * `/v1/messages` are two front doors onto one router, and that is only true
   * if the same conversation lands in the same place — including the parts
   * where the dialects disagree structurally: Anthropic's system prompt is a
   * top-level parameter, its tool results are user-role blocks.
   */
  it("both dialects normalize the same conversation identically", async () => {
    const openai = await translate({
      dialect: "openai",
      body: {
        model: CLAUDE,
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "t1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Paris"}' },
              },
            ],
          },
          { role: "tool", content: "18C", tool_call_id: "t1" },
        ],
        max_tokens: 100,
      },
    });

    const anthropic = await translate({
      dialect: "anthropic",
      body: {
        model: CLAUDE,
        system: "be brief",
        max_tokens: 100,
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "18C" }],
          },
        ],
      },
    });

    expect(openai.json().normalized).toEqual(anthropic.json().normalized);
    // And therefore the same bytes upstream.
    expect(openai.json().upstream).toEqual(anthropic.json().upstream);
  });

  it("hoists Anthropic's top-level system into a system message", async () => {
    const res = await translate({
      dialect: "anthropic",
      body: {
        model: CLAUDE,
        system: "be brief",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      },
    });
    const out = res.json();
    expect(out.normalized.messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(out.normalized.maxTokens).toBe(64);
    // Anthropic's own adapter puts it back where it started — the round trip is
    // the point: what the panel shows upstream is the native shape again.
    expect(out.upstream.body.system).toEqual([{ type: "text", text: "be brief" }]);
    expect(out.upstream.body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("translates tools into the target provider's declaration shape", async () => {
    repos.upsertProvider(
      provider("prv_cccccccccccc", { name: "Google", kind: "google", baseUrl: null }),
    );
    repos.upsertModel(model(GEMINI, "prv_cccccccccccc"));

    const res = await translate({
      dialect: "openai",
      body: {
        model: GEMINI,
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: { name: "f", description: "d", parameters: { type: "object" } },
          },
        ],
      },
    });
    const out = res.json();
    expect(out.upstream.kind).toBe("google");
    // Gemini carries the model in the URL, which is exactly the kind of thing
    // the panel exists to make visible.
    expect(out.upstream.path).toContain("gemini-3-pro");
    const config = out.upstream.body.config as {
      tools: { functionDeclarations: { name: string }[] }[];
    };
    expect(config.tools[0]?.functionDeclarations[0]?.name).toBe("f");
  });

  /**
   * The property that makes this safe to call on every keystroke. A
   * describe-only adapter is built with a transport that throws, so if any
   * adapter ever tried to send from this path the test fails loudly instead of
   * the user finding out on an invoice.
   */
  it("sends nothing — a provider with no key set still describes", async () => {
    // `TEST_API_KEY` is not in the environment; `createAdapter` would throw
    // MissingApiKeyError here. Describing must not care.
    expect(process.env.TEST_API_KEY).toBeUndefined();
    const res = await translate({
      dialect: "openai",
      body: { model: GPT, messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().upstream.body).toMatchObject({ model: "gpt-5" });
  });

  it("an unresolvable model is a 200 with a note, not an error", async () => {
    const res = await translate({
      dialect: "openai",
      body: { model: "nope/nothing", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    // The first two stages are real information and still answer the question.
    expect(out.normalized.messages).toHaveLength(1);
    expect(out.resolution).toBeNull();
    expect(out.upstream).toBeNull();
    expect(out.note).toContain("nope/nothing");
  });

  it("the orchestrator has no single upstream body and says so", async () => {
    const res = await translate({
      dialect: "openai",
      body: { model: "auto/orchestrator", messages: [{ role: "user", content: "hi" }] },
    });
    const out = res.json();
    expect(out.normalized.model).toBe("auto/orchestrator");
    expect(out.upstream).toBeNull();
    expect(out.note).toContain("orchestration");
  });

  it("rejects a malformed body with the same message the real route would give", async () => {
    const bad = { dialect: "openai", body: { model: GPT, messages: [] } };
    const res = await translate(bad);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("messages");

    const real = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: bad.body,
    });
    expect(real.statusCode).toBe(400);
  });

  it("rejects an unknown dialect", async () => {
    const res = await translate({ dialect: "cohere", body: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("dialect");
  });
});
