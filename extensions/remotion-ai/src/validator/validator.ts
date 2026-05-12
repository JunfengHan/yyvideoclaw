// extensions/remotion-ai/src/validator/validator.ts
//
// Public validator surface used by `orchestrator.ts`. Wraps `render-spawn`
// with a `ValidationReport` shape that the orchestrator can hand directly
// to either the success path (publish workspaceDir) or the retry path
// (build digest + sendUserTurn).
//
// Keep this module dependency-light — no extension-internal imports outside
// `./types`, `./render-spawn`, and `./error-digest`.

import path from "node:path";
import { buildErrorDigest } from "./error-digest.js";
import { spawnAiRenderValidation } from "./render-spawn.js";
import type {
  AiRenderWorkerInput,
  AiRenderWorkerMessage,
  ValidationStage,
  ValidationStageTimings,
} from "./types.js";

export type { ValidationStage, ValidationStageTimings } from "./types.js";

export type ValidationReport =
  | {
      readonly outcome: "success";
      readonly compositionId: string;
      readonly outputPath: string;
      readonly sizeBytes: number;
      readonly durationMs: number;
      readonly stages: ValidationStageTimings;
    }
  | {
      readonly outcome: "failure";
      readonly stage: ValidationStage;
      readonly errorName: string;
      readonly errorMessage: string;
      /** Pre-built Markdown digest safe to feed back to the agent. */
      readonly digest: string;
      readonly stages: Partial<ValidationStageTimings>;
    };

export interface ValidateOptions {
  readonly workspaceDir: string;
  readonly entryPointRelative?: string;
  readonly compositionId?: string;
  readonly cacheDir?: string;
  readonly outputPath?: string;
  readonly allowNetwork: boolean;
  readonly chromiumExecutablePath?: string;
  readonly maxOutputBytes: number;
  readonly jobTimeoutMs: number;
  readonly attemptIndex: number;
  readonly retryMax: number;
  readonly abortSignal?: AbortSignal;
  /**
   * Worker mode. Defaults to "still" (the cheap retry-safe validation
   * path that produces a PNG smoke-test). Pass "video" once the still
   * path has succeeded to render the final mp4 the user actually wants
   * to play. The video pass shares the bundler cache from the still pass
   * inside the same workspace, so the second call is much faster.
   */
  readonly mode?: import("./types.js").AiRenderWorkerMode;
  /** Test seam — bypass the real spawn. */
  readonly spawn?: (input: AiRenderWorkerInput) => Promise<AiRenderWorkerMessage>;
  /** Test seam — override the worker entry path. */
  readonly workerPath?: string;
}

const DEFAULT_ENTRY_POINT_RELATIVE = "src/index.ts";
const DEFAULT_CACHE_SUBPATH = ".cache/remotion-ai";
const DEFAULT_OUTPUT_SUBPATH = ".cache/remotion-ai/validation-still.png";

/**
 * Run a single validation pass over the AI workspace. The caller is
 * responsible for retry counting and digest re-feeding (see
 * `orchestrator.ts`); this function is stateless.
 */
export async function runValidation(options: ValidateOptions): Promise<ValidationReport> {
  const entryPointRelative = options.entryPointRelative ?? DEFAULT_ENTRY_POINT_RELATIVE;
  const cacheDir = options.cacheDir ?? path.join(options.workspaceDir, DEFAULT_CACHE_SUBPATH);
  const outputPath = options.outputPath ?? path.join(options.workspaceDir, DEFAULT_OUTPUT_SUBPATH);

  const input: AiRenderWorkerInput = {
    workspaceDir: options.workspaceDir,
    entryPointRelative,
    outputPath,
    cacheDir,
    allowNetwork: options.allowNetwork,
    chromiumExecutablePath: options.chromiumExecutablePath,
    maxOutputBytes: options.maxOutputBytes,
    compositionId: options.compositionId,
    // CRITICAL: forward the mode to the worker. Without this the video
    // pass silently re-runs the cheap still path and writes a PNG where
    // the orchestrator expects an mp4 — sidecar.videoOutputPath then
    // points at validation-still.png and the library streaming endpoint
    // 404s when the UI asks for output.mp4.
    ...(options.mode ? { mode: options.mode } : {}),
  };

  const message = options.spawn
    ? await options.spawn(input)
    : await spawnAiRenderValidation({
        input,
        jobTimeoutMs: options.jobTimeoutMs,
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(options.workerPath ? { workerPath: options.workerPath } : {}),
      });

  return projectMessage(message, options);
}

function projectMessage(
  message: AiRenderWorkerMessage,
  options: ValidateOptions,
): ValidationReport {
  if (message.kind === "validation-success") {
    return {
      outcome: "success",
      compositionId: message.compositionId,
      outputPath: message.outputPath,
      sizeBytes: message.sizeBytes,
      durationMs: message.durationMs,
      stages: message.stages,
    };
  }
  if (message.kind === "validation-failure") {
    const digest = buildErrorDigest(message, {
      workspaceDir: options.workspaceDir,
      attemptIndex: options.attemptIndex,
      retryMax: options.retryMax,
    });
    return {
      outcome: "failure",
      stage: message.stage,
      errorName: message.errorName,
      errorMessage: message.errorMessage,
      digest,
      stages: message.stages,
    };
  }
  // worker-error path: the spawn wrapper already throws for these, but the
  // injected `options.spawn` test seam might still surface one. Treat it as
  // a failure at the bundle stage (earliest stage) so the orchestrator
  // retries with the message as the digest.
  const fakeFailure: Extract<AiRenderWorkerMessage, { kind: "validation-failure" }> = {
    kind: "validation-failure",
    stage: "bundle",
    errorName: "WorkerError",
    errorMessage: message.message,
    errorPreview: message.stack ?? message.message,
    stages: {},
  };
  return projectMessage(fakeFailure, options);
}
