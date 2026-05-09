// Internal types shared across the Remotion plugin modules.
//
// These mirror the user-visible tool contract but add fields that only make
// sense inside the plugin (jobId, resolved absolute paths, sanitized props).

export interface CompositionInfo {
  id: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

export type RemotionCodec = "h264" | "h265" | "vp8" | "vp9";

export type RemotionImageFormat = "jpeg" | "png";

/**
 * Parameters for a single render job after tool-level input has been validated
 * and the entry point has been resolved to a real, allowlisted absolute path.
 */
export interface RenderJobRequest {
  jobId: string;
  entryPoint: string; // already resolved + realpath-checked absolute path
  compositionId: string;
  inputProps: Record<string, unknown>;
  kind: "video" | "still";
  codec: RemotionCodec;
  imageFormat: RemotionImageFormat;
  frame?: number; // only used when kind === "still"
}

export interface RenderJobResult {
  jobId: string;
  outputPath: string;
  fileUrl: string; // file:// URL pointing at outputPath
  sizeBytes: number;
  durationMs: number;
}

/**
 * Resolved, validated plugin configuration. The JSON Schema in
 * `openclaw.plugin.json` is the source of truth for the *shape*; this type
 * mirrors it plus defaults that the runtime fills in.
 */
export interface RemotionPluginConfig {
  templateRoots: string[];
  outputDir: string;
  cacheDir: string;
  jobTimeoutMs: number;
  maxOutputBytes: number;
  allowNetwork: boolean;
  chromiumExecutablePath?: string;
}

/**
 * Worker → parent IPC messages. Kept intentionally narrow: the worker only
 * ever emits one of these shapes. Anything else counts as a protocol error.
 */
export type WorkerIpcMessage =
  | {
      kind: "list-compositions";
      compositions: CompositionInfo[];
    }
  | {
      kind: "render-complete";
      outputPath: string;
      sizeBytes: number;
      durationMs: number;
    }
  | {
      kind: "worker-error";
      message: string;
      stack?: string;
    };
