// Lazy-loaded Remotion API seam.
//
// SDK RULE (AGENTS.md): do not mix static + dynamic import of the same module
// in the same prod path. This file is the ONE place where Remotion is
// imported, and it always uses dynamic import so the main plugin bundle stays
// light until a job actually runs.
//
// This file is used exclusively inside the render-worker child process —
// Remotion never loads in the main OpenClaw process.

import type { CompositionInfo, RenderJobRequest } from "./types.js";

interface RemotionBundlerApi {
  bundle: (options: {
    entryPoint: string;
    webpackOverride?: (cfg: unknown) => unknown;
    outDir?: string;
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
  renderMedia: (options: {
    composition: unknown;
    serveUrl: string;
    codec: string;
    outputLocation: string;
    inputProps?: Record<string, unknown>;
    chromiumOptions?: Record<string, unknown>;
    browserExecutable?: string;
  }) => Promise<void>;
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
  getCompositions?: (
    serveUrl: string,
    options?: { inputProps?: Record<string, unknown> },
  ) => Promise<
    Array<{ id: string; width: number; height: number; fps: number; durationInFrames: number }>
  >;
}

let bundlerCache: RemotionBundlerApi | null = null;
let rendererCache: RemotionRendererApi | null = null;

async function loadBundler(): Promise<RemotionBundlerApi> {
  if (bundlerCache) {
    return bundlerCache;
  }
  // @ts-expect-error - optional peer dep; resolved only when plugin is used.
  const mod = (await import("@remotion/bundler")) as RemotionBundlerApi;
  bundlerCache = mod;
  return mod;
}

async function loadRenderer(): Promise<RemotionRendererApi> {
  if (rendererCache) {
    return rendererCache;
  }
  // @ts-expect-error - optional peer dep; resolved only when plugin is used.
  const mod = (await import("@remotion/renderer")) as RemotionRendererApi;
  rendererCache = mod;
  return mod;
}

export interface RuntimeOptions {
  /** If false, Chromium is started with a proxy that rejects all traffic. */
  allowNetwork: boolean;
  /** Optional override; falls back to the binary bundled with @remotion/renderer. */
  browserExecutable?: string;
  /** Directory the bundler may use for its webpack cache. */
  cacheDir?: string;
}

function chromiumOptionsFor(options: RuntimeOptions): Record<string, unknown> {
  const chromium: Record<string, unknown> = {};
  if (!options.allowNetwork) {
    // `--proxy-server=per-context` drops network; the string format below is
    // supported by Chromium and yields a loopback-to-nowhere proxy.
    chromium.disableWebSecurity = false;
    chromium.args = ["--proxy-server=http://127.0.0.1:9"];
  }
  return chromium;
}

/**
 * Bundle a Remotion project and return its serveUrl. The bundle is cached on
 * disk under `cacheDir` so repeated renders of the same entry point reuse it.
 */
export async function bundleProject(entryPoint: string, options: RuntimeOptions): Promise<string> {
  const { bundle } = await loadBundler();
  return bundle({
    entryPoint,
    ...(options.cacheDir ? { outDir: options.cacheDir } : {}),
  });
}

export async function listCompositions(
  serveUrl: string,
  options: RuntimeOptions,
): Promise<CompositionInfo[]> {
  const renderer = await loadRenderer();
  if (renderer.getCompositions) {
    const compositions = await renderer.getCompositions(serveUrl);
    return compositions.map((c) => ({
      id: c.id,
      width: c.width,
      height: c.height,
      fps: c.fps,
      durationInFrames: c.durationInFrames,
    }));
  }
  // `@remotion/renderer` historically exposed this helper; if unavailable,
  // surface a clear error rather than silently degrade.
  throw new Error(
    "@remotion/renderer does not expose getCompositions in this version; upgrade @remotion/renderer",
  );
  // Note: `options` is currently unused here because getCompositions in older
  // Remotion versions does not accept chromiumOptions. Kept for API symmetry.
  void options;
}

export async function renderVideo(
  job: RenderJobRequest,
  serveUrl: string,
  outputPath: string,
  options: RuntimeOptions,
): Promise<void> {
  const { selectComposition, renderMedia } = await loadRenderer();
  const chromiumOptions = chromiumOptionsFor(options);
  const composition = await selectComposition({
    serveUrl,
    id: job.compositionId,
    inputProps: job.inputProps,
    chromiumOptions,
    ...(options.browserExecutable ? { browserExecutable: options.browserExecutable } : {}),
  });
  await renderMedia({
    composition,
    serveUrl,
    codec: job.codec,
    outputLocation: outputPath,
    inputProps: job.inputProps,
    chromiumOptions,
    ...(options.browserExecutable ? { browserExecutable: options.browserExecutable } : {}),
  });
}

export async function renderStill(
  job: RenderJobRequest,
  serveUrl: string,
  outputPath: string,
  options: RuntimeOptions,
): Promise<void> {
  const { selectComposition, renderStill: rsApi } = await loadRenderer();
  const chromiumOptions = chromiumOptionsFor(options);
  const composition = await selectComposition({
    serveUrl,
    id: job.compositionId,
    inputProps: job.inputProps,
    chromiumOptions,
    ...(options.browserExecutable ? { browserExecutable: options.browserExecutable } : {}),
  });
  await rsApi({
    composition,
    serveUrl,
    output: outputPath,
    inputProps: job.inputProps,
    ...(job.frame !== undefined ? { frame: job.frame } : {}),
    imageFormat: job.imageFormat,
    chromiumOptions,
    ...(options.browserExecutable ? { browserExecutable: options.browserExecutable } : {}),
  });
}
