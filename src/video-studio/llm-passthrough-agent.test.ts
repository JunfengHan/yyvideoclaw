import { describe, expect, it } from "vitest";
import {
  buildDefaultLlmPassthroughAgent,
  detectLlmPassthroughDrift,
  LLM_PASSTHROUGH_AGENT_ID,
} from "./llm-passthrough-agent.js";

describe("buildDefaultLlmPassthroughAgent", () => {
  it("produces the locked-down baseline with the given model", () => {
    const agent = buildDefaultLlmPassthroughAgent({ defaultModel: "qwen/qwen-max" });
    expect(agent.id).toBe(LLM_PASSTHROUGH_AGENT_ID);
    expect(agent.systemPrompt).toBe("");
    expect(agent.model).toBe("qwen/qwen-max");
    expect(agent.tools.profile).toBe("none");
    expect(agent.tools.alsoAllow).toEqual([]);
    expect(agent.memory.enabled).toBe(false);
    expect(agent.skills.enabled).toBe(false);
    expect(agent.hooks.enabled).toBe(false);
    expect(agent.compaction.enabled).toBe(false);
    expect(agent.heartbeat.enabled).toBe(false);
    expect(agent.thinkingDefault).toBe(false);
    expect(agent.reasoningDefault).toBe(false);
  });
});

describe("detectLlmPassthroughDrift", () => {
  const baseOpts = { defaultModel: "qwen/qwen-max" } as const;

  it("reports ok when the config matches the baseline exactly", () => {
    const agent = buildDefaultLlmPassthroughAgent(baseOpts);
    expect(detectLlmPassthroughDrift(agent, baseOpts)).toEqual({ ok: true, disagreements: [] });
  });

  it("tolerates a custom model (the user-tunable field)", () => {
    const agent = { ...buildDefaultLlmPassthroughAgent(baseOpts), model: "openai/gpt-4o-mini" };
    expect(detectLlmPassthroughDrift(agent, baseOpts).ok).toBe(true);
  });

  it("flags any enabled agent-style surface (security-sensitive drift)", () => {
    const agent = {
      ...buildDefaultLlmPassthroughAgent(baseOpts),
      memory: { enabled: true },
      hooks: { enabled: true },
    };
    const report = detectLlmPassthroughDrift(agent, baseOpts);
    expect(report.ok).toBe(false);
    expect(report.disagreements.some((s) => s.startsWith("memory.enabled"))).toBe(true);
    expect(report.disagreements.some((s) => s.startsWith("hooks.enabled"))).toBe(true);
  });

  it("flags a non-`none` tools profile and a non-empty systemPrompt", () => {
    const agent = {
      ...buildDefaultLlmPassthroughAgent(baseOpts),
      systemPrompt: "you are a pirate",
      tools: { profile: "default", alsoAllow: [] },
    };
    const report = detectLlmPassthroughDrift(agent, baseOpts);
    expect(report.ok).toBe(false);
    expect(report.disagreements.some((s) => s.startsWith("systemPrompt"))).toBe(true);
    expect(report.disagreements.some((s) => s.startsWith("tools.profile"))).toBe(true);
  });

  it("short-circuits to `missing` for non-object input", () => {
    expect(detectLlmPassthroughDrift(null, baseOpts)).toEqual({
      ok: false,
      disagreements: ["<agent entry missing or non-object>"],
    });
    expect(detectLlmPassthroughDrift(undefined, baseOpts).ok).toBe(false);
    expect(detectLlmPassthroughDrift("not an agent", baseOpts).ok).toBe(false);
  });
});
