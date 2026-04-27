// Preflight checks for the embedded Video Studio backend.
//
// Pixelle relies on two host-level tools that the PyInstaller bundle cannot
// usefully embed:
//
//   - FFmpeg — invoked as a subprocess to compose frames + audio into the
//     final MP4. Users without FFmpeg on PATH would otherwise see an opaque
//     failure half-way through generation.
//   - Chromium (via Playwright) — used to rasterise HTML frame templates
//     into PNGs. Playwright itself is Python-side and bundled, but the
//     browser binary is installed separately (`playwright install chromium`).
//
// This module returns a structured report so the installer wizard (Settings
// UI and first-run card) can present actionable guidance rather than a raw
// error string. It is intentionally read-only — no side effects, no
// auto-install. Auto-install decisions belong to the wizard flow, which may
// prompt the user first.

import type { SpawnSyncOptionsWithBufferEncoding, SpawnSyncReturns } from "node:child_process";

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export type PreflightSpawnSync = (
  file: string,
  args: readonly string[],
  options?: SpawnSyncOptionsWithBufferEncoding,
) => SpawnSyncReturns<Buffer>;

export type PreflightDeps = {
  readonly spawnSync: PreflightSpawnSync;
  readonly platform?: NodeJS.Platform | undefined;
};

export type DependencyStatus =
  | { readonly state: "ok"; readonly version: string }
  | { readonly state: "missing"; readonly hint: string }
  | { readonly state: "error"; readonly message: string };

export type PreflightReport = {
  readonly ffmpeg: DependencyStatus;
  readonly chromium: DependencyStatus;
  /** True when every dependency is `ok`. */
  readonly ready: boolean;
  /** The set of human-readable hints the UI should surface together. */
  readonly hints: readonly string[];
};

// ---------------------------------------------------------------------------
// Implementation.
// ---------------------------------------------------------------------------

function firstLine(buf: Buffer | string | undefined): string {
  if (!buf) {
    return "";
  }
  const text = typeof buf === "string" ? buf : buf.toString("utf8");
  const idx = text.indexOf("\n");
  return (idx >= 0 ? text.slice(0, idx) : text).trim();
}

function checkFfmpeg(deps: PreflightDeps): DependencyStatus {
  try {
    const res = deps.spawnSync("ffmpeg", ["-version"], { stdio: "pipe" });
    if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "missing", hint: ffmpegInstallHint(deps.platform) };
    }
    if (res.status !== 0) {
      return {
        state: "error",
        message: `ffmpeg -version exited with status ${res.status ?? "null"}.`,
      };
    }
    return { state: "ok", version: firstLine(res.stdout) || "ffmpeg (version unknown)" };
  } catch (err) {
    return { state: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

function ffmpegInstallHint(platform: NodeJS.Platform | undefined): string {
  switch (platform ?? process.platform) {
    case "darwin":
      return "Install FFmpeg via `brew install ffmpeg` or download from https://ffmpeg.org.";
    case "linux":
      return "Install FFmpeg via your distribution's package manager (e.g. `apt install ffmpeg`).";
    case "win32":
      return "Install FFmpeg from https://ffmpeg.org and add the executable to PATH.";
    default:
      return "Install FFmpeg and make sure the `ffmpeg` executable is on PATH.";
  }
}

function checkChromium(deps: PreflightDeps): DependencyStatus {
  // We deliberately don't shell out to Playwright here — that would require
  // the bundled Python runtime to be resolvable, which may not yet be the
  // case at preflight time. Instead we trust the supervisor to run Pixelle's
  // own `/health?preflight=1` endpoint once the process is up. Until then,
  // give a hint based on an env var that Playwright sets after a successful
  // browser install (`PLAYWRIGHT_BROWSERS_PATH`) and otherwise report a soft
  // "unknown → likely missing" so the wizard surfaces the install command.
  const marker = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (marker && marker.length > 0) {
    return { state: "ok", version: `PLAYWRIGHT_BROWSERS_PATH=${marker}` };
  }
  return {
    state: "missing",
    hint: "Run `playwright install chromium` inside the Video Studio venv, or let the installer wizard do it for you.",
  };
}

/**
 * Run all preflight checks and aggregate the result.
 */
export function runPreflight(deps: PreflightDeps): PreflightReport {
  const ffmpeg = checkFfmpeg(deps);
  const chromium = checkChromium(deps);
  const hints: string[] = [];
  if (ffmpeg.state !== "ok") {
    hints.push(ffmpeg.state === "missing" ? ffmpeg.hint : ffmpeg.message);
  }
  if (chromium.state !== "ok") {
    hints.push(chromium.state === "missing" ? chromium.hint : chromium.message);
  }
  return {
    ffmpeg,
    chromium,
    ready: ffmpeg.state === "ok" && chromium.state === "ok",
    hints,
  };
}
