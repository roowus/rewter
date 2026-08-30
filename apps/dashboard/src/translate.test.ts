/**
 * The debug panel's two clients.
 *
 * `parseBody` gets most of the attention because it is the only part of this
 * file that decides anything: it is what stands between a half-typed brace and
 * a round-trip, and what keeps `null` and `[1,2]` — both perfectly valid JSON —
 * from being sent as request bodies.
 *
 * For the fetch pair, the thing worth pinning is the error path. The daemon's
 * own sentence has to survive: "invalid x-api-key" is the entire answer someone
 * pressed Test to get, and a client that flattens it to "daemon said 401" sends
 * them back to the logs they came from.
 */
import { describe, expect, it, vi } from "vitest";
import { SAMPLE_BODY, chatTest, describeRequest, parseBody } from "./translate.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const RESULT = {
  modelId: "openai/gpt-5",
  text: "hi",
  finishReason: "stop",
  usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costUsd: 0.000_04,
  latencyMs: 120,
};

describe("parseBody", () => {
  it("accepts an object", () => {
    expect(parseBody('{"model":"a"}')).toEqual({ ok: true, value: { model: "a" } });
  });

  it("names the syntax error rather than saying 'invalid'", () => {
    const out = parseBody('{"model":');
    expect(out.ok).toBe(false);
    // The message the JSON parser produced, not a summary of it — a position
    // is the difference between "fix this" and "read it all again".
    if (!out.ok) expect(out.message).toMatch(/^invalid JSON: /);
  });

  it("rejects JSON that parses but is not a request body", () => {
    // Both are valid JSON and neither is an object with fields on it.
    for (const text of ["null", "[1,2]", '"hello"', "7"]) {
      const out = parseBody(text);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.message).toBe("expected a JSON object");
    }
  });

  it("says an empty box is empty, not malformed", () => {
    const out = parseBody("   ");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toBe("nothing to translate yet");
  });

  it("parses both samples, so the panel opens on something valid", () => {
    expect(parseBody(SAMPLE_BODY.openai).ok).toBe(true);
    expect(parseBody(SAMPLE_BODY.anthropic).ok).toBe(true);
  });
});

describe("chatTest", () => {
  it("posts the model and prompt and parses the result", async () => {
    const fetchImpl = vi.fn(async () => json(RESULT));
    const out = await chatTest({ model: "openai/gpt-5", prompt: "hi" }, fetchImpl as never);

    expect(out).toEqual({ ok: true, value: RESULT });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/internal/chat-test");
    expect(JSON.parse(String(init.body))).toEqual({ model: "openai/gpt-5", prompt: "hi" });
  });

  it("surfaces the upstream's own refusal, not the status code", async () => {
    const fetchImpl = vi.fn(async () => json({ error: { message: "invalid x-api-key" } }, 401));
    const out = await chatTest({ model: "m", prompt: "hi" }, fetchImpl as never);

    expect(out).toEqual({ ok: false, message: "invalid x-api-key" });
  });

  it("falls back to the status when the daemon sends no sentence", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>", { status: 502 }));
    const out = await chatTest({ model: "m", prompt: "hi" }, fetchImpl as never);

    expect(out).toEqual({ ok: false, message: "daemon said 502" });
  });

  it("a shape it does not recognize is not silently accepted", async () => {
    // A 200 carrying the wrong body is worse than an error: rendered, it would
    // read as a successful test of a model that never answered.
    const fetchImpl = vi.fn(async () => json({ modelId: "m" }));
    const out = await chatTest({ model: "m", prompt: "hi" }, fetchImpl as never);

    expect(out).toEqual({ ok: false, message: "unrecognized response from daemon" });
  });

  it("a dead daemon is reported as such, not as a crash", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const out = await chatTest({ model: "m", prompt: "hi" }, fetchImpl as never);

    expect(out).toEqual({ ok: false, message: "daemon unreachable" });
  });
});

describe("describeRequest", () => {
  it("sends the parsed body and the dialect to the translate route", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        dialect: "openai",
        normalized: { model: "openai/gpt-5", messages: [{ role: "user", content: "hello" }] },
        resolution: null,
        upstream: null,
        note: "unknown model",
      }),
    );
    const out = await describeRequest(
      { dialect: "openai", body: { model: "openai/gpt-5" } },
      fetchImpl as never,
    );

    expect(out.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/internal/translate");
    expect(JSON.parse(String(init.body))).toEqual({
      dialect: "openai",
      body: { model: "openai/gpt-5" },
    });
  });

  /**
   * An abort is the panel superseding its own request as the user types. It has
   * to be distinguishable from a failure, because the panel keeps the last good
   * render up for one and shows a red line for the other.
   */
  it("reports an abort as 'aborted' rather than as an error to display", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const out = await describeRequest(
      { dialect: "openai", body: {} },
      fetchImpl as never,
      controller.signal,
    );

    expect(out).toEqual({ ok: false, message: "aborted" });
  });
});
