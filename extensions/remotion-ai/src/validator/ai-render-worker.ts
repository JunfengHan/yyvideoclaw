// extensions/remotion-ai/src/validator/ai-render-worker.ts
//
// Standalone Node entry that runs INSIDE a subprocess, spawned by
// `render-spawn.ts`. Mirrors the security/IPC discipline of
// `extensions/remotion/src/render-worker.ts` but is scoped to:
//   - one operation: `bundle + selectComposition + render-still (frame 0)`,
//   - one cwd: the AI workspace,
//   - no `templateRoots` crossover: the only allowlist is `workspaceDir`
//     itself, enforced via realpath + path-separator-boundary check.
//
// We deliberately do NOT import `extensions/remotion/src/render.runtime.ts`
// even though the Remotion API calls are identical — cross-extension
// imports are forbidden. The Remotion deps (`@remotion/bundler`,
// `@remotion/renderer`) are loaded dynamically here so the parent's bundle
// stays light.

import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import type {
  AiRenderWorkerInput,
  AiRenderWorkerMessage,
  AiRenderWorkerMode,
  ValidationStage,
} from "./types.js";

interface RemotionBundlerApi {
  bundle: (options: {
    entryPoint: string;
    outDir?: string;
    webpackOverride?: (cfg: unknown) => unknown;
  }) => Promise<string>;
}

interface RemotionRendererApi {
  selectComposition: (options: {
    serveUrl: string;
    id: string;
    inputProps?: Record<string, unknown>;
    chromiumOptions?: Record<string, unknown>;
    browserExecutable?: string;
  }) => Promise<{
    id: string;
    width: number;
    height: number;
    fps: number;
    durationInFrames: number;
  }>;
  renderStill: (options: {
    composition: unknown;
    serveUrl: string;
    output: string;
    inputProps?: Record<string, unknown>;
    frame?: number;
    imageFormat?: "jpeg" | "png";
    chromiumOptions?: Record<string, unknown>;
    browserExecutable?: string;
  }) => Promise<void>;
  renderMedia: (options: {
    composition: unknown;
    serveUrl: string;
    codec?: "h264" | "h265" | "vp8" | "vp9";
    outputLocation: string;
    inputProps?: Record<string, unknown>;
    chromiumOptions?: Record<string, unknown>;
    browserExecutable?: string;
    onProgress?: (params: {
      progress: number;
      renderedFrames: number;
      encodedFrames: number;
    }) => void;
  }) => Promise<void>;
  getCompositions?: (
    serveUrl: string,
  ) => Promise<
    Array<{ id: string; width: number; height: number; fps: number; durationInFrames: number }>
  >;
}

const MAX_PREVIEW_BYTES = 2048;

function sendMessage(msg: AiRenderWorkerMessage): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function readStdinAll(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function isWithin(parent: string, child: string): boolean {
  if (child === parent) {
    return true;
  }
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

async function canonicalise(p: string): Promise<string> {
  return fs.realpath(p);
}

async function ensureWithinWorkspace(target: string, workspaceDir: string): Promise<string> {
  const canonicalTarget = await canonicalise(target);
  const canonicalWorkspace = await canonicalise(workspaceDir);
  if (!isWithin(canonicalWorkspace, canonicalTarget)) {
    throw new Error(`path "${target}" resolves outside the AI workspace "${workspaceDir}"`);
  }
  return canonicalTarget;
}

function buildChromiumOptions(allowNetwork: boolean): Record<string, unknown> {
  if (allowNetwork) {
    return {};
  }
  // Same loopback-to-nowhere proxy trick used by the remotion plugin's
  // render-worker. Drops all network egress for the headless Chromium.
  return { args: ["--proxy-server=http://127.0.0.1:9"] };
}

function truncatePreview(text: string): string {
  if (text.length <= MAX_PREVIEW_BYTES) {
    return text;
  }
  return `${text.slice(0, MAX_PREVIEW_BYTES)}\n…(truncated; original ${text.length} chars)`;
}

function makeStageError(stage: ValidationStage, error: unknown): AiRenderWorkerMessage {
  const isError = error instanceof Error;
  const message = isError ? error.message : String(error);
  const stackOrMessage = isError && error.stack ? error.stack : message;
  return {
    kind: "validation-failure",
    stage,
    errorName: isError ? error.name : "Error",
    errorMessage: message,
    errorPreview: truncatePreview(stackOrMessage),
    stages: {},
  };
}

async function loadBundler(): Promise<RemotionBundlerApi> {
  // @ts-expect-error - optional peer dep; resolved only when validation runs.
  const mod = (await import("@remotion/bundler")) as RemotionBundlerApi;
  return mod;
}

async function loadRenderer(): Promise<RemotionRendererApi> {
  // @ts-expect-error - optional peer dep; resolved only when validation runs.
  const mod = (await import("@remotion/renderer")) as RemotionRendererApi;
  return mod;
}

async function run(input: AiRenderWorkerInput): Promise<AiRenderWorkerMessage> {
  // 1. Lock the entry point inside the workspace. Any escape -> reject before
  //    we touch Remotion. The agent's sandbox already prevents writes outside
  //    workspace, but defense in depth is cheap.
  const canonicalWorkspace = await canonicalise(input.workspaceDir);
  const entryPointAbs = path.resolve(canonicalWorkspace, input.entryPointRelative);
  const canonicalEntry = await ensureWithinWorkspace(entryPointAbs, canonicalWorkspace);
  const entryStat = await fs.stat(canonicalEntry);
  if (!entryStat.isFile()) {
    throw new Error(`entry point is not a regular file: ${canonicalEntry}`);
  }

  // The output and cache directories live INSIDE the workspace by contract;
  // the parent picks them. Same realpath check applies.
  await fs.mkdir(input.cacheDir, { recursive: true });
  await fs.mkdir(path.dirname(input.outputPath), { recursive: true });
  const canonicalCache = await ensureWithinWorkspace(input.cacheDir, canonicalWorkspace);
  const canonicalOutputDir = await ensureWithinWorkspace(
    path.dirname(input.outputPath),
    canonicalWorkspace,
  );
  const canonicalOutput = path.join(canonicalOutputDir, path.basename(input.outputPath));

  const chromiumOptions = buildChromiumOptions(input.allowNetwork);
  const browserExecutable = input.chromiumExecutablePath;

  // Stage 1: bundle.
  const bundleStart = Date.now();
  const { bundle } = await loadBundler();
  let serveUrl: string;
  try {
    serveUrl = await bundle({ entryPoint: canonicalEntry, outDir: canonicalCache });
  } catch (error) {
    return makeStageError("bundle", error);
  }
  const bundleMs = Date.now() - bundleStart;

  // Stage 2: pick a composition. If the caller didn't specify one, we accept
  // the FIRST composition the project registers — the agent must register at
  // least one for validation to make sense.
  const renderer = await loadRenderer();
  const selectStart = Date.now();
  let composition;
  try {
    let compositionId = input.compositionId;
    if (!compositionId) {
      if (!renderer.getCompositions) {
        throw new Error(
          "@remotion/renderer in this version does not expose getCompositions; pass compositionId explicitly",
        );
      }
      const compositions = await renderer.getCompositions(serveUrl);
      const first = compositions[0];
      if (!first) {
        throw new Error(
          "no compositions registered in the AI workspace; the agent must register at least one <Composition>",
        );
      }
      compositionId = first.id;
    }
    composition = await renderer.selectComposition({
      serveUrl,
      id: compositionId,
      chromiumOptions,
      ...(browserExecutable ? { browserExecutable } : {}),
    });
  } catch (error) {
    return makeStageError("select_composition", error);
  }
  const selectCompositionMs = Date.now() - selectStart;

  // Stage 3a: render still (frame 0). PNG is the cheapest reliable format.
  // Even in `video` mode we render a still first as a smoke test before
  // committing to the heavier `renderMedia` call: if the still fails the
  // mp4 will too, and we'd rather know fast.
  const renderStart = Date.now();
  const stillOutput = canonicalOutput;
  try {
    await renderer.renderStill({
      composition,
      serveUrl,
      output: stillOutput,
      frame: 0,
      imageFormat: "png",
      chromiumOptions,
      ...(browserExecutable ? { browserExecutable } : {}),
    });
  } catch (error) {
    return makeStageError("render_still", error);
  }
  const renderStillMs = Date.now() - renderStart;

  const stillStat = statSync(stillOutput);
  if (stillStat.size > input.maxOutputBytes) {
    return {
      kind: "validation-failure",
      stage: "render_still",
      errorName: "MaxOutputBytesExceeded",
      errorMessage: `validation still exceeded maxOutputBytes (${stillStat.size} > ${input.maxOutputBytes})`,
      errorPreview: `output ${stillOutput} is ${stillStat.size} bytes; configured maxOutputBytes is ${input.maxOutputBytes}`,
      stages: { bundleMs, selectCompositionMs, renderStillMs },
    };
  }

  const mode: AiRenderWorkerMode = input.mode ?? "still";
  if (mode === "still") {
    return {
      kind: "validation-success",
      compositionId: composition.id,
      outputPath: stillOutput,
      sizeBytes: stillStat.size,
      durationMs: bundleMs + selectCompositionMs + renderStillMs,
      stages: { bundleMs, selectCompositionMs, renderStillMs },
    };
  }

  // Stage 3b: video mode — render the full mp4. The output path the caller
  // gave us was the still PNG (cheap to overwrite); for video we swap the
  // extension to `.mp4` and write next to it.
  const videoOutput = stillOutput.replace(/\.[^./]+$/u, "") + ".mp4";
  await ensureWithinWorkspace(path.dirname(videoOutput), canonicalWorkspace);
  const renderVideoStart = Date.now();
  try {
    await renderer.renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: videoOutput,
      chromiumOptions,
      ...(browserExecutable ? { browserExecutable } : {}),
    });
  } catch (error) {
    return makeStageError("render_video", error);
  }
  const renderVideoMs = Date.now() - renderVideoStart;

  const videoStat = statSync(videoOutput);
  if (videoStat.size > input.maxOutputBytes) {
    return {
      kind: "validation-failure",
      stage: "render_video",
      errorName: "MaxOutputBytesExceeded",
      errorMessage: `rendered video exceeded maxOutputBytes (${videoStat.size} > ${input.maxOutputBytes})`,
      errorPreview: `output ${videoOutput} is ${videoStat.size} bytes; configured maxOutputBytes is ${input.maxOutputBytes}`,
      stages: { bundleMs, selectCompositionMs, renderStillMs, renderVideoMs },
    };
  }

  return {
    kind: "validation-success",
    compositionId: composition.id,
    outputPath: videoOutput,
    sizeBytes: videoStat.size,
    durationMs: bundleMs + selectCompositionMs + renderStillMs + renderVideoMs,
    stages: { bundleMs, selectCompositionMs, renderStillMs, renderVideoMs },
  };
}

async function main(): Promise<void> {
  const raw = await readStdinAll();
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("worker stdin was empty; expected an AiRenderWorkerInput JSON line");
  }
  let input: AiRenderWorkerInput;
  try {
    input = JSON.parse(trimmed) as AiRenderWorkerInput;
  } catch (err) {
    throw new Error(
      `worker stdin was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const message = await run(input);
  sendMessage(message);
}

main().then(
  () => {
    process.exit(0);
  },
  (err) => {
    sendMessage({
      kind: "worker-error",
      message: err instanceof Error ? err.message : String(err),
      ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
    });
    process.exit(1);
  },
);
