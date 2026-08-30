/**
 * The run client.
 *
 * Two things are worth proving here rather than in the panel, because both are
 * translations this module performs and nobody else can check:
 *
 *  - **The pin becomes a model string.** The daemon takes one field, `model`,
 *    and encodes "who leads" inside it as `auto/orchestrator:<id>`. A blank pin
 *    must produce the bare pseudo-model, not `auto/orchestrator:` — which the
 *    daemon would try to resolve as a model named the empty string.
 *  - **An omitted budget is omitted.** Blank means "inherit the daemon's
 *    default", `null` means "uncapped", and `0` means nothing at all. The three
 *    are one text field on screen and must stay three distinct requests on the
 *    wire, because the daemon layers request over configured over schema and a
 *    field sent as `null` by accident silently uncaps a configured ceiling.
 */
import { describe, expect, it, vi } from "vitest";
import { parseBudget, runTask } from "./run.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ACCEPTED = {
  taskId: "task_a1b2c3d4e5f6",
  title: "compare these three things",
  initiatorModelId: "anthropic/claude-opus-5",
};

/** Returns the parsed body of the single request the stub received. */
function sent(fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("runTask", () => {
  it("asks for the orchestrator, not a model, when nothing is pinned", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(ACCEPTED));
    await runTask({ prompt: "do a thing" }, fetchImpl as unknown as typeof fetch);

    // Not `auto/orchestrator:` — an empty pin is no pin, and the suffixed form
    // would name a model the registry cannot find.
    expect(sent(fetchImpl).model).toBe("auto/orchestrator");
  });

  it("encodes a pinned initiator into the model string", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(ACCEPTED));
    await runTask(
      { prompt: "do a thing", initiator: "zai/glm-5.3" },
      fetchImpl as unknown as typeof fetch,
    );

    expect(sent(fetchImpl).model).toBe("auto/orchestrator:zai/glm-5.3");
  });

  it("omits settings entirely when none were chosen", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(ACCEPTED));
    await runTask({ prompt: "do a thing" }, fetchImpl as unknown as typeof fetch);

    // Not `settings: {}` — an empty object is a request to keep the schema's
    // values, which is not the same as saying nothing about them.
    expect("settings" in sent(fetchImpl)).toBe(false);
  });

  it("sends a null budget as null, which is not the same as sending nothing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(ACCEPTED));
    await runTask(
      { prompt: "do a thing", maxSpendUsd: null },
      fetchImpl as unknown as typeof fetch,
    );

    expect(sent(fetchImpl).settings).toEqual({ maxSpendUsd: null });
  });

  it("returns the daemon's own sentence when it refuses", async () => {
    const message = "anthropic/claude-opus-5 is a single model — use the chat tester";
    const fetchImpl = vi.fn().mockResolvedValue(json({ error: { message } }, 400));

    const out = await runTask({ prompt: "hi" }, fetchImpl as unknown as typeof fetch);
    expect(out).toEqual({ ok: false, message });
  });

  it("reports an unreachable daemon rather than throwing at the caller", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("failed to fetch"));

    const out = await runTask({ prompt: "hi" }, fetchImpl as unknown as typeof fetch);
    expect(out).toEqual({ ok: false, message: "daemon unreachable" });
  });

  it("refuses a body that does not parse, instead of passing a shape along", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ taskId: "not-a-task-id" }));

    const out = await runTask({ prompt: "hi" }, fetchImpl as unknown as typeof fetch);
    expect(out).toEqual({ ok: false, message: "unrecognized response from daemon" });
  });

  it("hands back the title and initiator the daemon decided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(ACCEPTED, 202));

    const out = await runTask({ prompt: "hi" }, fetchImpl as unknown as typeof fetch);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.initiatorModelId).toBe("anthropic/claude-opus-5");
  });
});

describe("parseBudget", () => {
  it("reads blank as 'say nothing', so the daemon's default survives", () => {
    expect(parseBudget("")).toEqual({ ok: true, value: undefined });
    expect(parseBudget("   ")).toEqual({ ok: true, value: undefined });
  });

  it("reads the word as uncapped, since the number zero is not how you say it", () => {
    expect(parseBudget("uncapped")).toEqual({ ok: true, value: null });
    expect(parseBudget("none")).toEqual({ ok: true, value: null });
  });

  it("refuses zero rather than guessing which of the two it meant", () => {
    // The dangerous reading is "no limit"; the other is "spend nothing", which
    // no one types on purpose. Refusing is the only safe answer.
    const out = parseBudget("0");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("uncapped");
  });

  it("takes a dollar sign off, because that is how the amount gets typed", () => {
    expect(parseBudget("$2.50")).toEqual({ ok: true, value: 2.5 });
  });

  it("refuses a typo instead of sending NaN", () => {
    expect(parseBudget("a lot").ok).toBe(false);
  });
});
