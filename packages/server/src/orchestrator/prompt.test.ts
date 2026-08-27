/**
 * Prompt-assembly tests.
 *
 * The prompt is the product, so these assert the two things that would break it
 * silently: the *order* of the assembled system message (the registry digest sits
 * between two stable blocks so an Anthropic cache breakpoint lands in the same
 * place across requests), and the fact that the client's own conversation —
 * including its own system message — is passed through untouched. A router that
 * quietly rewrote the caller's system prompt would be a bug the caller could
 * never see from the outside.
 */
import type { ChatMessage } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import {
  ORCHESTRATOR_CORE_PROMPT,
  ORCHESTRATOR_PROMPT_VERSION,
  WORKER_SYSTEM_PROMPT,
  buildInitiatorMessages,
  buildWorkerMessages,
} from "./prompt.js";

const DIGEST = "zai/glm-5.3 — $0.6/$2.2 MTok, 1M ctx — best_at:[summarize]";
const CONVERSATION: ChatMessage[] = [
  { role: "system", content: "You are Claude Code." },
  { role: "user", content: "summarize these three URLs" },
];

describe("the core prompt", () => {
  it("keeps the version constant in step with the text", () => {
    expect(ORCHESTRATOR_PROMPT_VERSION).toBe(1);
  });

  it("teaches every behaviour the engine relies on the model knowing", () => {
    // Each of these is a capability the engine implements but the model only
    // learns about here; drop one and the orchestration silently degrades to a
    // single sequential worker.
    for (const topic of ["parallel", "handoff", "tier", "finish"]) {
      expect(
        ORCHESTRATOR_CORE_PROMPT.toLowerCase(),
        `core prompt never mentions ${topic}`,
      ).toContain(topic);
    }
  });
});

describe("buildInitiatorMessages", () => {
  it("puts the stable core first and the task last, with the digest between", () => {
    const messages = buildInitiatorMessages({
      digest: DIGEST,
      conversation: CONVERSATION,
      taskId: "task_abc",
    });

    const system = messages[0];
    expect(system?.role).toBe("system");
    const text = system?.content ?? "";

    const core = text.indexOf(ORCHESTRATOR_CORE_PROMPT.slice(0, 40));
    const registry = text.indexOf(DIGEST);
    const task = text.indexOf("task_abc");
    expect(core).toBeGreaterThanOrEqual(0);
    // Ordering is what makes a cache breakpoint after the digest worth setting.
    expect(registry).toBeGreaterThan(core);
    expect(task).toBeGreaterThan(registry);
  });

  it("passes the client's conversation through unchanged, system message and all", () => {
    const messages = buildInitiatorMessages({
      digest: DIGEST,
      conversation: CONVERSATION,
      taskId: "task_abc",
    });

    expect(messages.slice(1)).toEqual(CONVERSATION);
  });

  it("says so plainly when there is no registry to choose from", () => {
    const messages = buildInitiatorMessages({
      digest: "",
      conversation: CONVERSATION,
      taskId: "task_abc",
    });

    // An empty section would read as "no models exist"; the model needs to know
    // it must do the work itself rather than guess at model ids.
    expect(messages[0]?.content).toContain("registry is empty");
  });

  it("includes the dashboard url only when the daemon knows one", () => {
    const withUrl = buildInitiatorMessages({
      digest: DIGEST,
      conversation: CONVERSATION,
      taskId: "task_abc",
      dashboardUrl: "http://localhost:20130/t/task_abc",
    });
    expect(withUrl[0]?.content).toContain("http://localhost:20130/t/task_abc");

    const without = buildInitiatorMessages({
      digest: DIGEST,
      conversation: CONVERSATION,
      taskId: "task_abc",
    });
    expect(without[0]?.content).not.toContain("Dashboard:");
  });

  it("produces exactly one system message of its own", () => {
    const messages = buildInitiatorMessages({
      digest: DIGEST,
      conversation: [{ role: "user", content: "go" }],
      taskId: "task_abc",
    });
    expect(messages).toHaveLength(2);
    expect(messages.filter((m) => m.role === "system")).toHaveLength(1);
  });
});

describe("buildWorkerMessages", () => {
  it("gives the worker the sign-off convention and its instructions, and nothing else", () => {
    const messages = buildWorkerMessages("count the vowels in 'orchestrator'");

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "system", content: WORKER_SYSTEM_PROMPT });
    expect(messages[1]).toEqual({ role: "user", content: "count the vowels in 'orchestrator'" });
  });

  it("mandates the SUMMARY line the initiator reads back", () => {
    // `splitSummary` looks for exactly this; if the prompt stopped asking for it,
    // every worker would fall back to a truncated first paragraph.
    expect(WORKER_SYSTEM_PROMPT).toContain("SUMMARY:");
  });

  it("does not leak the orchestrator's own tool vocabulary to a worker", () => {
    // A tier-1 worker has no tools. Mentioning spawn_worker would invite it to
    // narrate tool calls it cannot make.
    expect(WORKER_SYSTEM_PROMPT).not.toContain("spawn_worker");
  });
});
