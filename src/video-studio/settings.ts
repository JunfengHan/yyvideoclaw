// Video Studio user-facing settings model.
//
// This module is the **single source of truth** for everything behind the
// `videoStudio.*` config key-space (requirements §7.4). It is deliberately
// independent from yyvideoclaw's global config schema because:
//
//   - The feature is ship-gated and may land incrementally; forcing a
//     migration of the generated config baseline on every experiment would
//     be painful.
//   - The supervisor + UI only need a tiny, strongly-typed snapshot rather
//     than the full schema form-control pipeline.
//
// Responsibilities:
//
//   1. Declare the canonical shape of the settings (`VideoStudioSettings`).
//   2. Provide the default values so callers can render the Settings
//      section before the user has persisted anything.
//   3. Coerce / validate arbitrary user input (parsed from the config file)
//      into the strongly-typed shape, rejecting obviously bogus entries
//      instead of crashing.
//   4. Report which fields have changed between two snapshots so the
//      caller can decide whether to restart the Pixelle subprocess
//      (needed for `Default LLM Model` — requirements §7.3 / §4.5).
//
// The module is pure; no side effects, no filesystem, no network.

import type { AspectRatio, Pipeline } from "../../ui/src/ui/video-studio/client.js";

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/** Storage key prefix used by callers that persist via the host's config. */
export const VIDEO_STUDIO_SETTINGS_KEY_PREFIX = "videoStudio" as const;

/**
 * Canonical shape of the user-tunable settings. Kept readonly so callers
 * can treat it as immutable state (React/Lit-friendly).
 */
export type VideoStudioSettings = {
  /** Feature toggle (corresponds to `features.videoStudio`). */
  readonly enabled: boolean;
  /** Default underlying LLM model id (e.g. `qwen/qwen-max`). */
  readonly defaultModel: string;
  /** Default aspect ratio for new generations. */
  readonly defaultAspectRatio: AspectRatio;
  /** Default pipeline id. */
  readonly defaultPipeline: Pipeline;
  /** Default frame template key, or `null` to let Pixelle pick. */
  readonly defaultFrameTemplate: string | null;
  /**
   * Auto-stop the Pixelle subprocess after N minutes of no activity.
   * `0` disables the behaviour (supervisor stays running).
   */
  readonly autoStopIdleMinutes: number;
};

/**
 * The builder for Settings also wants the current read-only runtime
 * Backend Status. It lives outside `VideoStudioSettings` because the
 * user cannot edit it — it is projected from the supervisor.
 */
export type VideoStudioBackendStatusSnapshot = {
  readonly state: "running" | "stopped" | "starting" | "retrying" | "idle";
  readonly pid?: number | null;
  readonly port?: number | null;
  readonly uptimeMs?: number | null;
};

// ---------------------------------------------------------------------------
// Defaults + coercion.
// ---------------------------------------------------------------------------

const VALID_ASPECT_RATIOS: readonly AspectRatio[] = ["9:16", "16:9", "1:1"];
const VALID_PIPELINES: readonly Pipeline[] = ["standard", "asset-based", "linear", "custom"];

export const DEFAULT_VIDEO_STUDIO_SETTINGS: VideoStudioSettings = Object.freeze({
  // Shipping default is OFF so a stock yyvideoclaw install does not appear
  // to gain a new feature overnight; users opt in via Settings.
  enabled: false,
  defaultModel: "qwen/qwen-max",
  defaultAspectRatio: "9:16",
  defaultPipeline: "standard",
  defaultFrameTemplate: null,
  autoStopIdleMinutes: 30,
});

function coerceBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

function coerceString(raw: unknown, fallback: string): string {
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return fallback;
}

function coerceNumber(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function coerceAspectRatio(raw: unknown, fallback: AspectRatio): AspectRatio {
  return typeof raw === "string" && (VALID_ASPECT_RATIOS as readonly string[]).includes(raw)
    ? (raw as AspectRatio)
    : fallback;
}

function coercePipeline(raw: unknown, fallback: Pipeline): Pipeline {
  return typeof raw === "string" && (VALID_PIPELINES as readonly string[]).includes(raw)
    ? (raw as Pipeline)
    : fallback;
}

function coerceNullableString(raw: unknown, fallback: string | null): string | null {
  if (raw === null || raw === "") return null;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return fallback;
}

/**
 * Parse arbitrary user-supplied settings (typically read from disk) into
 * a strongly-typed snapshot. Unknown / invalid fields are replaced with
 * the documented defaults so the UI never sees `undefined`.
 */
export function parseVideoStudioSettings(raw: unknown): VideoStudioSettings {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_VIDEO_STUDIO_SETTINGS };
  }
  const input = raw as Record<string, unknown>;
  const defaults = DEFAULT_VIDEO_STUDIO_SETTINGS;
  const autoStop = coerceNumber(input.autoStopIdleMinutes, defaults.autoStopIdleMinutes);
  return {
    enabled: coerceBoolean(input.enabled, defaults.enabled),
    defaultModel: coerceString(input.defaultModel, defaults.defaultModel),
    defaultAspectRatio: coerceAspectRatio(input.defaultAspectRatio, defaults.defaultAspectRatio),
    defaultPipeline: coercePipeline(input.defaultPipeline, defaults.defaultPipeline),
    defaultFrameTemplate: coerceNullableString(
      input.defaultFrameTemplate,
      defaults.defaultFrameTemplate,
    ),
    // Negative values collapse to `0` (disabled) rather than treated as
    // valid — users who want to keep the backend alive can set `0`.
    autoStopIdleMinutes: Math.max(0, Math.floor(autoStop)),
  };
}

// ---------------------------------------------------------------------------
// Change detection (for restart decisions).
// ---------------------------------------------------------------------------

export type SettingsChange =
  | "enabled"
  | "defaultModel"
  | "defaultAspectRatio"
  | "defaultPipeline"
  | "defaultFrameTemplate"
  | "autoStopIdleMinutes";

/** Fields whose change requires restarting the Pixelle subprocess. */
export const RESTART_REQUIRED_FIELDS: readonly SettingsChange[] = ["defaultModel"];

export type SettingsDiff = {
  readonly changed: readonly SettingsChange[];
  readonly requiresRestart: boolean;
};

export function detectSettingsChanges(
  previous: VideoStudioSettings,
  next: VideoStudioSettings,
): SettingsDiff {
  const changed: SettingsChange[] = [];
  if (previous.enabled !== next.enabled) changed.push("enabled");
  if (previous.defaultModel !== next.defaultModel) changed.push("defaultModel");
  if (previous.defaultAspectRatio !== next.defaultAspectRatio) changed.push("defaultAspectRatio");
  if (previous.defaultPipeline !== next.defaultPipeline) changed.push("defaultPipeline");
  if (previous.defaultFrameTemplate !== next.defaultFrameTemplate)
    changed.push("defaultFrameTemplate");
  if (previous.autoStopIdleMinutes !== next.autoStopIdleMinutes)
    changed.push("autoStopIdleMinutes");
  return {
    changed,
    requiresRestart: changed.some((f) =>
      (RESTART_REQUIRED_FIELDS as readonly string[]).includes(f),
    ),
  };
}

// ---------------------------------------------------------------------------
// Persistence path helpers.
// ---------------------------------------------------------------------------

/**
 * Flatten the settings into the dotted-key shape the existing host config
 * layer expects (`videoStudio.enabled`, `videoStudio.defaultModel`, ...).
 */
export function flattenForPersistence(settings: VideoStudioSettings): Record<string, unknown> {
  return {
    [`${VIDEO_STUDIO_SETTINGS_KEY_PREFIX}.enabled`]: settings.enabled,
    [`${VIDEO_STUDIO_SETTINGS_KEY_PREFIX}.defaultModel`]: settings.defaultModel,
    [`${VIDEO_STUDIO_SETTINGS_KEY_PREFIX}.defaultAspectRatio`]: settings.defaultAspectRatio,
    [`${VIDEO_STUDIO_SETTINGS_KEY_PREFIX}.defaultPipeline`]: settings.defaultPipeline,
    [`${VIDEO_STUDIO_SETTINGS_KEY_PREFIX}.defaultFrameTemplate`]: settings.defaultFrameTemplate,
    [`${VIDEO_STUDIO_SETTINGS_KEY_PREFIX}.autoStopIdleMinutes`]: settings.autoStopIdleMinutes,
  };
}
