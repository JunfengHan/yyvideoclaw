// Video Studio feature flag.
//
// The embedded Video Studio tab is ship-enabled by default. This helper is
// deliberately tiny and side-effect-free so that:
//
//   - the main-process bootstrap can import it before the config store is
//     fully hydrated without risking circular initialization, and
//   - the UI bundle can tree-shake it trivially when the flag is off.
//
// Resolution order (highest priority first):
//
//   1. Explicit process env override `YYVIDEOCLAW_VIDEO_STUDIO=1|0`.
//      Useful for one-shot debugging, CI matrix runs, and letting power
//      users force the tab off without touching their config.
//   2. The user's persisted config (`videoStudio.enabled`) when provided
//      via `resolveVideoStudioFeatureFlag({ userConfig })`. Set to `false`
//      to hide the tab even in production builds.
//   3. Default: `true` in every build. Video Studio ships on by default
//      so new installs get the tab without extra opt-in.
//
// Callers that already have a config snapshot should always pass it in; code
// paths that run before config is available can rely on the env + default
// fallback.

export type VideoStudioUserConfig = {
  readonly enabled?: boolean | undefined;
};

export type VideoStudioFeatureFlagInput = {
  readonly userConfig?: VideoStudioUserConfig | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly isProduction?: boolean | undefined;
};

const ENV_KEY = "YYVIDEOCLAW_VIDEO_STUDIO";

function parseEnvFlag(raw: string | undefined): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "" ||
    normalized === "0" ||
    normalized === "false" ||
    normalized === "off" ||
    normalized === "no"
  ) {
    return false;
  }
  if (normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes") {
    return true;
  }
  return undefined;
}

/**
 * Pure resolver so it can be unit-tested without touching `process.env`.
 */
export function resolveVideoStudioFeatureFlag(input: VideoStudioFeatureFlagInput = {}): boolean {
  const env = input.env ?? (typeof process !== "undefined" ? process.env : undefined);
  const envOverride = parseEnvFlag(env?.[ENV_KEY]);
  if (envOverride !== undefined) {
    return envOverride;
  }
  const userValue = input.userConfig?.enabled;
  if (typeof userValue === "boolean") {
    return userValue;
  }
  // Ship-enabled by default across every build flavour. The `isProduction`
  // input is intentionally ignored here — it is kept on the signature for
  // backwards compatibility with call sites that already pass it, and so a
  // future policy change (e.g. region-based gating) can re-introduce the
  // distinction without reshaping the public API.
  void (input.isProduction ?? env?.NODE_ENV === "production");
  return true;
}

/**
 * Convenience wrapper for call sites that already have a config snapshot.
 */
export function isVideoStudioEnabled(userConfig?: VideoStudioUserConfig): boolean {
  return resolveVideoStudioFeatureFlag({ userConfig });
}
