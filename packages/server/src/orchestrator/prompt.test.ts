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
import { type ChatMessage, ProjectSchema, newProjectId } from "@rewter/shared";
import { describe, expect, it } from "vitest";
import {
  ORCHESTRATOR_CORE_PROMPT,
  ORCHESTRATOR_MESSAGE_PREFIX,
  ORCHESTRATOR_PROMPT_VERSION,
  TIER2_SYSTEM_PROMPT,
  WORKER_SYSTEM_PROMPT,
  buildInitiatorMessages,
  buildTier2Messages,
  buildWorkerMessages,
  renderProjectBlock,
} from "./prompt.js";

const DIGEST = "zai/glm-5.3 — $0.6/$2.2 MTok, 1M ctx — best_at:[summarize]";
const CONVERSATION: ChatMessage[] = [
  { role: "system", content: "You are Claude Code." },
  { role: "user", content: "summarize these three URLs" },
];

describe("the core prompt", () => {
  it("keeps the version constant in step with the text", () => {
    expect(ORCHESTRATOR_PROMPT_VERSION).toBe(4);
  });

  it("offers tier 2 as available work rather than a promise", () => {
    // The ladder said "not yet available" until M6. An initiator that still reads
    // that never spawns a worker that can touch a file, and the whole tier is
    // dead code the model politely declines to use.
    const ladder = ORCHESTRATOR_CORE_PROMPT.slice(
      ORCHESTRATOR_CORE_PROMPT.indexOf("**tier 2**"),
      ORCHESTRATOR_CORE_PROMPT.indexOf("**tier 3**"),
    );
    expect(ladder).not.toContain("Not yet available");
    expect(ladder).toContain("approval");
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

  it("renders the project block after the digest, in the per-task region", () => {
    // The digest is the cacheable region; a project block before it would
    // invalidate the prompt cache for every other project's tasks.
    const messages = buildInitiatorMessages({
      digest: DIGEST,
      conversation: CONVERSATION,
      taskId: "task_abc",
      project: makeProject(),
    });
    const text = messages[0]?.content ?? "";
    expect(text.indexOf("Project: Rewter (rewter)")).toBeGreaterThan(text.indexOf(DIGEST));
    // And a project-less task has no project section at all.
    const without = buildInitiatorMessages({
      digest: DIGEST,
      conversation: CONVERSATION,
      taskId: "task_abc",
    });
    expect(without[0]?.content).not.toContain("Project:");
  });

  it("renders the skills list in the per-task region, and nothing at all without one", () => {
    // Skills visibility is project-dependent, so the block lives with the
    // project section, after the cache breakpoint. Absent or empty renders
    // nothing — a "Skills: (none)" header would spend tokens telling the model
    // about a feature it cannot use.
    const withSkills = buildInitiatorMessages({
      digest: DIGEST,
      conversation: CONVERSATION,
      taskId: "task_abc",
      skillsDigest: "deploy-checklist — Run the deploy checklist end to end",
    });
    const text = withSkills[0]?.content ?? "";
    expect(text).toContain("deploy-checklist — Run the deploy checklist end to end");
    expect(text).toContain("load_skill");
    expect(text.indexOf("deploy-checklist —")).toBeGreaterThan(text.indexOf(DIGEST));

    for (const skillsDigest of [undefined, ""]) {
      const without = buildInitiatorMessages({
        digest: DIGEST,
        conversation: CONVERSATION,
        taskId: "task_abc",
        ...(skillsDigest === undefined ? {} : { skillsDigest }),
      });
      expect(without[0]?.content).not.toContain("Skills available");
    }
  });
});

function makeProject(over: Record<string, unknown> = {}) {
  return ProjectSchema.parse({
    id: newProjectId(),
    slug: "rewter",
    name: "Rewter",
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...over,
  });
}

describe("renderProjectBlock", () => {
  it("names the project, lists resources with kinds, and keeps prefs advisory", () => {
    const block = renderProjectBlock(
      makeProject({
        description: "the router itself",
        resources: [
          { kind: "repo", location: "/Users/x/projects/rewter", note: "main checkout" },
          { kind: "url", location: "https://example.com/spec", note: null },
        ],
        modelPrefs: {
          initiatorPin: null,
          prefer: ["anthropic/claude-opus-5"],
          avoid: ["zai/glm-5.3"],
        },
      }),
    );
    expect(block).toContain("Project: Rewter (rewter)");
    expect(block).toContain("the router itself");
    expect(block).toContain("- [repo] /Users/x/projects/rewter — main checkout");
    // A null note renders nothing, not the word "null".
    expect(block).toContain("- [url] https://example.com/spec\n");
    expect(block).not.toContain("null");
    // Locked decision 4: hints, not rules — the wording is the implementation.
    expect(block).toContain("hints, not rules");
    expect(block).toContain("prefer: anthropic/claude-opus-5");
    expect(block).toContain("avoid: zai/glm-5.3");
  });

  it("omits empty sections rather than rendering headers over nothing", () => {
    const block = renderProjectBlock(makeProject());
    expect(block).toBe("Project: Rewter (rewter)");
  });

  it("never mentions policy — enforcement is the engine's, not the model's", () => {
    const block = renderProjectBlock(
      makeProject({ policy: { autoApprove: false, maxSpendUsd: 5 } }),
    );
    expect(block).not.toContain("approve");
    expect(block).not.toContain("5");
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

describe("buildTier2Messages", () => {
  it("tells the worker how the run ends, since the loop has no other terminator", () => {
    expect(TIER2_SYSTEM_PROMPT).toContain("finish_report");
    // Nothing else stops the loop, so this cannot be a passing mention.
    expect(TIER2_SYSTEM_PROMPT).toContain("End your run");
  });

  it("tells the worker to adapt to a denial rather than retry it", () => {
    // A worker that re-issues the identical denied command until its turn budget
    // runs out turns the approval gate into a failure mode.
    expect(TIER2_SYSTEM_PROMPT).toContain("do not repeat the same call");
  });

  it("names the marker the tier-2 loop actually prefixes orchestrator messages with", () => {
    // The loop writes this literal string into the transcript, and the prompt is
    // the only place the model learns what it means. If they drift, a message
    // arrives looking like the user talking to the worker directly — which is
    // exactly what the paragraph above it says never happens.
    expect(TIER2_SYSTEM_PROMPT).toContain(ORCHESTRATOR_MESSAGE_PREFIX.trim());
  });

  it("does not ask for the tier-1 SUMMARY line, which would collide with the report", () => {
    // Tier 2 reports through `finish_report`. Asking for a SUMMARY line too gives
    // the model two sign-off conventions and a reason to skip the tool call.
    expect(TIER2_SYSTEM_PROMPT).not.toContain("SUMMARY:");
  });

  it("names the working directory before the instructions", () => {
    const messages = buildTier2Messages({
      instructions: "count the TODOs",
      cwd: "/tmp/ws/task_1",
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "system", content: TIER2_SYSTEM_PROMPT });
    const user = messages[1]?.content ?? "";
    expect(user.indexOf("/tmp/ws/task_1")).toBeLessThan(user.indexOf("count the TODOs"));
  });

  it("points at the scratch space only when it is somewhere else", () => {
    // When the task runs in a real project directory, every write there is gated —
    // so the model needs somewhere ungated to put temporaries, and needs to be
    // told that its own cwd is not it.
    const pointed = buildTier2Messages({
      instructions: "audit the config",
      cwd: "/Users/x/projects/thing",
      workspaceRoot: "/tmp/ws/task_1",
    });
    const user = pointed[1]?.content ?? "";
    expect(user).toContain("Scratch space");
    expect(user).toContain("/tmp/ws/task_1");
    expect(user).toContain("may pause for approval");

    // In the ordinary case cwd *is* the workspace, and a second path would only
    // suggest the two differ.
    const plain = buildTier2Messages({
      instructions: "audit the config",
      cwd: "/tmp/ws/task_1",
      workspaceRoot: "/tmp/ws/task_1",
    });
    expect(plain[1]?.content).not.toContain("Scratch space");
  });
});
