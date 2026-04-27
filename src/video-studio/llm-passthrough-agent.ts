// Default configuration for the `llm-passthrough` agent.
//
// The embedded Video Studio backend routes every LLM call through a
// single transparent agent whose sole job is to forward the user's prompt
// to the user-selected underlying model. For security and determinism, the
// configuration must lock down every "agent-style" feature (tools, memory,
// skills, hooks, compaction, heartbeat) so a compromised Pixelle (or any
// other embedded consumer) cannot escalate through these surfaces even if
// it somehow obtains the internal token.
//
// This module is the **single source of truth** for that shape. Settings
// (task 9) imports `buildDefaultLlmPassthroughAgent(...)` and writes it
// into the user's `agents.list` on first launch. The startup validation
// hook (task 10) also consumes it to detect drift — if the live config
// differs from this baseline, we alert loudly rather than silently honour
// the unsafe override.

export const LLM_PASSTHROUGH_AGENT_ID = "openclaw/llm-passthrough" as const;

/**
 * Minimal shape of an agent entry we care about here. Other yyvideoclaw
 * fields (display name, owner, etc.) are left untouched by callers and
 * not modelled in this file.
 */
export type LlmPassthroughAgentConfig = {
  readonly id: typeof LLM_PASSTHROUGH_AGENT_ID;
  readonly systemPrompt: string;
  readonly model: string;
  readonly tools: {
    readonly profile: "none";
    readonly alsoAllow: readonly string[];
  };
  readonly memory: { readonly enabled: false };
  readonly skills: { readonly enabled: false };
  readonly hooks: { readonly enabled: false };
  readonly compaction: { readonly enabled: false };
  readonly heartbeat: { readonly enabled: false };
  readonly thinkingDefault: false;
  readonly reasoningDefault: false;
};

export type BuildOptions = {
  /** Default underlying model (e.g. `qwen/qwen-max`). */
  readonly defaultModel: string;
};

/**
 * Build a canonical `llm-passthrough` agent config. Every agent-style
 * surface is off; every field has a literal / readonly type so drift
 * shows up as a TypeScript error rather than a runtime surprise.
 */
export function buildDefaultLlmPassthroughAgent(opts: BuildOptions): LlmPassthroughAgentConfig {
  return {
    id: LLM_PASSTHROUGH_AGENT_ID,
    // Empty prompt: the caller's prompt goes straight to the underlying
    // model. `x-openclaw-model` header overrides `model` per-request.
    systemPrompt: "",
    model: opts.defaultModel,
    tools: { profile: "none", alsoAllow: [] },
    memory: { enabled: false },
    skills: { enabled: false },
    hooks: { enabled: false },
    compaction: { enabled: false },
    heartbeat: { enabled: false },
    thinkingDefault: false,
    reasoningDefault: false,
  };
}

// ---------------------------------------------------------------------------
// Drift detection — consumed by the startup validator.
// ---------------------------------------------------------------------------

export type DriftReport = {
  readonly ok: boolean;
  /** Dot-path fields whose values disagree with the baseline. */
  readonly disagreements: readonly string[];
};

/**
 * Compare a user-supplied `llm-passthrough` agent entry against the
 * baseline produced by `buildDefaultLlmPassthroughAgent(...)`.
 *
 * The check is intentionally strict: we demand exact equality on every
 * security-sensitive toggle, because "enabled: false" turning into
 * "enabled: true" silently is exactly what this agent exists to prevent.
 */
export function detectLlmPassthroughDrift(actual: unknown, opts: BuildOptions): DriftReport {
  const expected = buildDefaultLlmPassthroughAgent(opts);
  const disagreements: string[] = [];
  if (!actual || typeof actual !== "object") {
    return { ok: false, disagreements: ["<agent entry missing or non-object>"] };
  }
  const a = actual as Record<string, unknown>;

  compareScalar("id", a.id, expected.id, disagreements);
  compareScalar("systemPrompt", a.systemPrompt, expected.systemPrompt, disagreements);
  // Model is allowed to drift from the baseline — that is literally what
  // the UI lets users change — so we explicitly exclude it from the
  // strict check. The key invariants are everything below.
  compareScalar(
    "tools.profile",
    (a.tools as Record<string, unknown> | undefined)?.profile,
    "none",
    disagreements,
  );
  compareScalar(
    "memory.enabled",
    (a.memory as Record<string, unknown> | undefined)?.enabled,
    false,
    disagreements,
  );
  compareScalar(
    "skills.enabled",
    (a.skills as Record<string, unknown> | undefined)?.enabled,
    false,
    disagreements,
  );
  compareScalar(
    "hooks.enabled",
    (a.hooks as Record<string, unknown> | undefined)?.enabled,
    false,
    disagreements,
  );
  compareScalar(
    "compaction.enabled",
    (a.compaction as Record<string, unknown> | undefined)?.enabled,
    false,
    disagreements,
  );
  compareScalar(
    "heartbeat.enabled",
    (a.heartbeat as Record<string, unknown> | undefined)?.enabled,
    false,
    disagreements,
  );
  compareScalar("thinkingDefault", a.thinkingDefault, false, disagreements);
  compareScalar("reasoningDefault", a.reasoningDefault, false, disagreements);

  return { ok: disagreements.length === 0, disagreements };
}

function compareScalar(field: string, actual: unknown, expected: unknown, out: string[]): void {
  if (actual !== expected) {
    out.push(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
