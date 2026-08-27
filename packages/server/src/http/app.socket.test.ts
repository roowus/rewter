/**
 * Streaming over a **real socket**.
 *
 * `app.inject()` fakes the socket, and that is exactly the blind spot that let
 * a real bug ship: the abort listener sat on `req.raw`, whose "close" fires as
 * soon as the *request body* has been read — immediately, on any POST — so
 * every real streaming request aborted before its first token while all 31
 * inject-based wire-format tests stayed green. These two tests pay for a port:
 * one pins that a stream survives its own request body, the other that a
 * genuine disconnect still cancels the upstream (the behaviour the broken
 * listener was reaching for).
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, openDb } from "../db/connection.js";
import { Repos } from "../db/repos.js";
import { EventBus } from "../events/bus.js";
import { Router } from "../router/router.js";
import { FakeAdapter, type FakeAdapterOptions, end, text } from "../testing/fake-adapter.js";
import { model, provider } from "../testing/registry.js";
import { buildApp } from "./app.js";

const MODEL_ID = "anthropic/claude-sonnet-5";

let db: Db;
let repos: Repos;
let bus: EventBus;
let app: FastifyInstance;

beforeEach(() => {
  db = openDb(":memory:");
  let tick = 1_756_252_800_000;
  const clock = () => ++tick;
  bus = new EventBus(db, clock);
  repos = new Repos(db, bus, clock);
  repos.upsertProvider(provider());
  repos.upsertModel(model(MODEL_ID));
});

afterEach(async () => {
  // `close()` drains open connections, and after a client-side abort undici
  // holds its socket for ~4s before releasing it — a test-client artifact (a
  // real hang-up closes the TCP socket at once), but a 4s teardown either way.
  app?.server.closeAllConnections();
  await app?.close();
});

/** Boots the app on an ephemeral port and returns its base URL. */
async function listen(
  scripts: ConstructorParameters<typeof FakeAdapter>[0],
  adapterOpts: FakeAdapterOptions = {},
): Promise<{ url: string; base: string; adapter: FakeAdapter }> {
  const adapter = new FakeAdapter(scripts, adapterOpts);
  app = buildApp({
    router: new Router({ repos, createAdapter: () => adapter, sleep: async () => undefined }),
    repos,
    bus,
    sse: { heartbeatMs: 0 },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  return { url: `${base}/v1/chat/completions`, base, adapter };
}

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: MODEL_ID,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    ...over,
  });

const messagesBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: MODEL_ID,
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    ...over,
  });

const HEADERS = { "content-type": "application/json" };

describe("POST /v1/chat/completions (streaming, real socket)", () => {
  it("streams to completion rather than aborting once the request body is read", async () => {
    const { url } = await listen([[text("hello"), text(" world"), end()]]);
    const res = await fetch(url, { method: "POST", headers: HEADERS, body: body() });
    const raw = await res.text();

    // The bug's signature was a role frame followed by "request aborted".
    expect(raw).not.toContain("aborted");
    const content = raw
      .split("\n\n")
      .filter((b) => b.startsWith("data: ") && !b.endsWith("[DONE]"))
      .map((b) => JSON.parse(b.slice("data: ".length)) as { choices: [{ delta: unknown }] })
      .map((f) => (f.choices[0].delta as { content?: string }).content ?? "")
      .join("");
    expect(content).toBe("hello world");
    expect(raw.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("aborts the upstream when the client really goes away", async () => {
    // `hang` keeps the upstream call open past the script, so the only thing
    // that can end it is the disconnect we are testing for.
    const { url, adapter } = await listen([[text("first")]], { hang: true });
    const ctl = new AbortController();
    const res = await fetch(url, {
      method: "POST",
      headers: HEADERS,
      body: body(),
      signal: ctl.signal,
    });
    // Read once so the upstream call is genuinely in flight before we hang up.
    await res.body?.getReader().read();
    ctl.abort();

    await vi.waitFor(() => expect(adapter.lastSignal?.aborted).toBe(true));
  });
});

describe("POST /v1/messages (streaming, real socket)", () => {
  // The Anthropic route carries its own copy of the disconnect listener, so it
  // needs its own socket-level cover — the same bug is re-introducible here,
  // and `inject()` still cannot see it.
  it("streams to completion rather than aborting once the request body is read", async () => {
    const { base } = await listen([[text("hello"), text(" world"), end()]]);
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: HEADERS,
      body: messagesBody(),
    });
    const raw = await res.text();

    expect(raw).not.toContain("aborted");
    const assembled = raw
      .split("\n\n")
      .filter((b) => b.startsWith("event: content_block_delta"))
      .map((b) => JSON.parse((b.split("\n")[1] as string).slice("data: ".length)))
      .map((f: { delta: { text?: string } }) => f.delta.text ?? "")
      .join("");
    expect(assembled).toBe("hello world");
    // Anthropic clients terminate on message_stop; there is no [DONE] sentinel.
    expect(raw.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
  });

  it("aborts the upstream when the client really goes away", async () => {
    const { base, adapter } = await listen([[text("first")]], { hang: true });
    const ctl = new AbortController();
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: HEADERS,
      body: messagesBody(),
      signal: ctl.signal,
    });
    await res.body?.getReader().read();
    ctl.abort();

    await vi.waitFor(() => expect(adapter.lastSignal?.aborted).toBe(true));
  });
});
