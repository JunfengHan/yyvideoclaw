// extensions/remotion-ai/src/engine/engine.ts
//
// The `RemotionAgentEngine` interface is the engine-agnostic seam consumed
// by `orchestrator.ts`. M1 ships one implementation (`codex-engine.ts`);
// M2 adds Claude Code / remote-worker. The orchestrator MUST NOT branch on
// engine id beyond what `engine-registry.ts` exposes.

import type {
  AgentEngineAttemptResult,
  AgentEngineCapabilities,
  EngineId,
  JobEvent,
} from "../types.js";

export interface EngineRunParams {
  readonly jobId: string;
  readonly workspaceDir: string;
  /** First user turn. */
  readonly prompt: string;
  /** Optional developer instructions prepended to every turn (e.g. agent contract). */
  readonly developerInstructions?: string;
  readonly allowNetwork: boolean;
  readonly jobTimeoutMs: number;
  readonly abortSignal: AbortSignal;
  readonly onEvent: (event: JobEvent) => void;
  /**
   * Optional env-vars to inject into the engine subprocess. Used by the
   * remotion-ai auth integration to point the codex CLI at the
   * yyvideoclaw hosted proxy (`OPENAI_BASE_URL` + `OPENAI_API_KEY`)
   * without leaking those secrets into the gateway's `process.env`.
   *
   * `clearEnv` lets us strip pre-existing keys (e.g. an unrelated
   * `OPENAI_API_KEY` set in the operator's shell) so the explicit
   * `env` value wins deterministically.
   */
  readonly envInjection?: {
    readonly env: Record<string, string>;
    readonly clearEnv?: string[];
  };
}

export interface EngineRetryParams {
  readonly jobId: string;
  readonly sessionRef: string;
  readonly digest: string;
  readonly abortSignal: AbortSignal;
  readonly onEvent: (event: JobEvent) => void;
}

export interface RemotionAgentEngine {
  readonly id: EngineId;
  readonly capabilities: AgentEngineCapabilities;
  /**
   * Run the FIRST agent turn for a job. The engine is responsible for
   * starting whatever underlying session it needs and for keeping it open
   * (the orchestrator may call `retry` afterwards).
   */
  runAttempt(params: EngineRunParams): Promise<AgentEngineAttemptResult>;
  /**
   * Send a follow-up turn to the SAME underlying session that produced
   * `sessionRef`. Used by the validate-then-retry loop with the failure
   * digest as the prompt.
   */
  retry(params: EngineRetryParams): Promise<AgentEngineAttemptResult>;
  /**
   * Release the underlying session for a given `sessionRef`. Called by
   * the orchestrator after success / final failure / cancellation.
   * Idempotent.
   */
  dispose(sessionRef: string): Promise<void>;
}
