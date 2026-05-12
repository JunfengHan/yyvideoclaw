// extensions/remotion-ai/src/types.ts
//
// Public-ish (within this plugin) types for jobs and the agent-engine
// abstraction. The orchestrator + HTTP routes + UI controller all depend
// on these names.

import type { ValidationStage, ValidationStageTimings } from "./validator/types.js";

/** High-level lifecycle phase visible to the UI / SSE consumers. */
export type Phase =
  | "queued"
  | "workspace"
  | "skills"
  | "agent"
  | "bundle"
  | "select"
  | "still"
  | "retry"
  | "done"
  | "failed"
  | "cancelled";

/** Engine identifiers — keep in sync with `engine/engine-registry.ts`. */
export type EngineId = "codex";

/**
 * Snapshot returned by GET /remotion-ai/jobs/:id and embedded in SSE
 * "snapshot" events. Stable, machine-readable.
 */
export interface JobSnapshot {
  readonly jobId: string;
  readonly phase: Phase;
  readonly retryCount: number;
  readonly workspaceDir: string;
  readonly engine: EngineId;
  readonly errorSummary?: string;
  readonly compositionId?: string;
  readonly stillPath?: string;
  /**
   * Absolute path to the final rendered mp4 inside the workspace. Set
   * only on `phase === "done"` jobs. Library entries surface this so the
   * UI can stream the video back to the browser via
   * GET `/remotion-ai/library/:jobId/output.mp4`.
   */
  readonly videoOutputPath?: string;
  /**
   * User's original prompt. Included in the snapshot so the Library view
   * (and history list) can display the ask that produced each workspace.
   * Truncated to the first 160 chars for display safety; the full prompt
   * lives in `workspaceDir/.remotion-ai/job.json` on disk.
   */
  readonly promptPreview?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Job spec submitted via POST /remotion-ai/jobs. Validated by the route
 * handler; everything below is already trusted by the orchestrator.
 */
export interface JobSpec {
  readonly jobId: string;
  readonly prompt: string;
  readonly outputRoot: string;
  readonly engine: EngineId;
  readonly retryMax: number;
  readonly jobTimeoutMs: number;
  readonly allowNetwork: boolean;
}

/**
 * Single SSE event delivered to UI subscribers. The shape is intentionally
 * narrow — UI uses this to drive the progress bar / error region; it does
 * NOT replay agent transcripts.
 */
export type JobEvent =
  | { readonly type: "phase"; readonly jobId: string; readonly phase: Phase; readonly at: number }
  | {
      readonly type: "engine_message";
      readonly jobId: string;
      readonly text: string;
      readonly at: number;
    }
  | {
      readonly type: "engine_tool";
      readonly jobId: string;
      readonly name: string;
      readonly status: string;
      readonly at: number;
    }
  | {
      readonly type: "validation_success";
      readonly jobId: string;
      readonly compositionId: string;
      readonly stillPath: string;
      readonly stages: ValidationStageTimings;
      readonly at: number;
    }
  | {
      readonly type: "validation_failure";
      readonly jobId: string;
      readonly stage: ValidationStage;
      readonly errorName: string;
      readonly errorMessage: string;
      readonly retriesLeft: number;
      readonly at: number;
    }
  | {
      readonly type: "error";
      readonly jobId: string;
      readonly message: string;
      readonly at: number;
    };

/**
 * Result returned by `RemotionAgentEngine.runAttempt`. Per-attempt; the
 * orchestrator decides whether to retry based on the validator outcome
 * (not on this result).
 */
export interface AgentEngineAttemptResult {
  /**
   * Opaque identifier for the agent session created by this engine. The
   * orchestrator threads it back into subsequent retries via
   * `engine.retry(...)` so the agent keeps its conversation state.
   */
  readonly sessionRef: string;
  readonly assistantText: string;
}

export interface AgentEngineCapabilities {
  readonly id: EngineId;
  readonly label: string;
  readonly supportsRetry: boolean;
}
