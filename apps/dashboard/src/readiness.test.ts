/**
 * The readiness verdict.
 *
 * What is worth proving here is not the arithmetic — it is the two judgements
 * the arithmetic feeds: that "cannot start" and "starts and picks badly" stay
 * separate, and that each blocked state names the command that actually fixes
 * *that* state. A registry that is empty and one that is entirely switched off
 * produce the same `0` and need opposite advice, so the split is tested rather
 * than assumed.
 */
import type { DaemonHealth } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import { readinessOf } from "./readiness.js";

const health = (registry: Partial<DaemonHealth["registry"]> = {}): DaemonHealth => ({
  status: "ok",
  version: "0.1.0",
  models: 3,
  providers: 2,
  uptimeMs: 246_000,
  startedAt: 1_756_252_800_000 - 246_000,
  pid: 4242,
  url: "http://localhost:2746",
  registry: {
    providersTotal: 8,
    providersEnabled: 2,
    modelsTotal: 180,
    modelsEnabled: 3,
    cards: 41,
    ...registry,
  },
  db: { path: "/home/o/.rewter/rewter.db", sizeBytes: 421_888 },
  events: { count: 1234, lastSeq: 1240 },
  tasks: { running: 1, pendingApprovals: 0 },
});

const check = (r: ReturnType<typeof readinessOf>, id: string) => {
  const found = r.checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found;
};

describe("readinessOf", () => {
  it("is ready, with nothing to do, when providers and models are enabled and cards exist", () => {
    const r = readinessOf(health());
    expect(r.ready).toBe(true);
    expect(r.checks.every((c) => c.level === "ok")).toBe(true);
    expect(r.checks.every((c) => c.fix === null)).toBe(true);
    expect(check(r, "models").label).toBe("3 of 180 models enabled");
    expect(check(r, "cards").label).toBe("41 capability cards");
  });

  it("blocks when no model is enabled — there is nothing to route to", () => {
    const r = readinessOf(health({ modelsEnabled: 0 }));
    expect(r.ready).toBe(false);
    expect(check(r, "models").level).toBe("blocked");
  });

  // The same `0` from two different situations. An empty registry needs a sync;
  // a full one that is switched off needs the editor, and telling someone to
  // sync 180 models they already have is advice that does nothing.
  it("distinguishes an empty registry from one that is entirely switched off", () => {
    const empty = check(readinessOf(health({ modelsTotal: 0, modelsEnabled: 0 })), "models");
    expect(empty.label).toBe("no models in the registry");
    expect(empty.fix).toBe("rewter sync-models");

    const off = check(readinessOf(health({ modelsEnabled: 0 })), "models");
    expect(off.label).toBe("all 180 models are switched off");
    expect(off.fix).toBe("enable one in the registry above");
  });

  it("makes the same split for providers", () => {
    const empty = check(
      readinessOf(health({ providersTotal: 0, providersEnabled: 0 })),
      "providers",
    );
    expect(empty.level).toBe("blocked");
    expect(empty.label).toBe("no providers configured");

    const off = check(readinessOf(health({ providersEnabled: 0 })), "providers");
    expect(off.label).toBe("all 8 providers are switched off");
  });

  // The distinction the whole card is built on: no cards is a worse answer, not
  // a missing one. The orchestrator starts either way.
  it("warns about missing cards without calling the daemon unready", () => {
    const r = readinessOf(health({ cards: 0 }));
    expect(r.ready).toBe(true);
    expect(check(r, "cards").level).toBe("warn");
    expect(check(r, "cards").fix).toBe("rewter card <model>");
  });

  it("pluralises the counts it prints", () => {
    const r = readinessOf(health({ providersTotal: 1, providersEnabled: 1, cards: 1 }));
    expect(check(r, "providers").label).toBe("1 of 1 provider enabled");
    expect(check(r, "cards").label).toBe("1 capability card");
  });

  it("reports every blocked check at once rather than stopping at the first", () => {
    const r = readinessOf(health({ providersEnabled: 0, modelsEnabled: 0, cards: 0 }));
    expect(r.ready).toBe(false);
    expect(r.checks.map((c) => c.level)).toEqual(["blocked", "blocked", "warn"]);
    expect(r.checks.every((c) => c.fix !== null)).toBe(true);
  });
});
