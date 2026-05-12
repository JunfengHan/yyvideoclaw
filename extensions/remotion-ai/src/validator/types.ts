// extensions/remotion-ai/src/validator/types.ts
//
// IPC message shapes shared between `ai-render-worker.ts` (child process) and
// `render-spawn.ts` (parent). Kept tiny and disjoint from the remotion plugin's
// own types — the AI workspace lives outside the user's `templateRoots` and
// must NOT round-trip through any of those security primitives.

/**
 * Worker run mode.
 *
 *   - `still`: bundle + selectComposition + renderStill(frame=0). The cheap,
 *     fast validation cycle; what every retry attempt runs. Output is a PNG.
 *   - `video`: bundle + selectComposition + renderMedia (mp4, h264). Used
 *     once after `still` validation passes to produce the user-facing video
 *     artifact. Output is an mp4. Re-uses the same workspace/cache layout
 *     so we benefit from the bundler cache.
 */
export type AiRenderWorkerMode = "still" | "video";

/** Inputs accepted by the worker on stdin (single JSON line). */
export interface AiRenderWorkerInput {
  readonly workspaceDir: string;
  readonly entryPointRelative: string;
  readonly outputPath: string;
  readonly cacheDir: string;
  readonly allowNetwork: boolean;
  readonly chromiumExecutablePath: string | undefined;
  readonly maxOutputBytes: number;
  /** Optional override; default is the first composition discovered. */
  readonly compositionId: string | undefined;
  /**
   * Defaults to "still" for backwards-compatible behaviour with older
   * call sites. New call sites that want an mp4 set this to "video".
   */
  readonly mode?: AiRenderWorkerMode;
}

/** Outputs emitted by the worker on stdout (single JSON line). */
export type AiRenderWorkerMessage =
  | {
      readonly kind: "validation-success";
      readonly compositionId: string;
      readonly outputPath: string;
      readonly sizeBytes: number;
      readonly durationMs: number;
      readonly stages: ValidationStageTimings;
    }
  | {
      readonly kind: "validation-failure";
      /** Which stage failed first. */
      readonly stage: ValidationStage;
      readonly errorName: string;
      readonly errorMessage: string;
      /** Truncated stack/log preview safe to feed back into the agent. */
      readonly errorPreview: string;
      readonly stages: Partial<ValidationStageTimings>;
    }
  | {
      readonly kind: "worker-error";
      readonly message: string;
      readonly stack?: string;
    };

export type ValidationStage = "bundle" | "select_composition" | "render_still" | "render_video";

export interface ValidationStageTimings {
  readonly bundleMs: number;
  readonly selectCompositionMs: number;
  readonly renderStillMs: number;
  /** Populated only in `mode: "video"` runs. */
  readonly renderVideoMs?: number;
}
