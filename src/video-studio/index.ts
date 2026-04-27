// Public barrel for the embedded Video Studio core modules.
//
// Only export symbols that are genuinely part of the cross-package contract.
// Internal helpers should stay un-exported so refactors inside this folder do
// not force changes elsewhere in the monorepo.

export {
  isVideoStudioEnabled,
  resolveVideoStudioFeatureFlag,
  type VideoStudioFeatureFlagInput,
  type VideoStudioUserConfig,
} from "./feature-flag.js";

export {
  defaultPlatformTag,
  VideoStudioInstaller,
  type BackendResolution,
  type InstallerConfig,
  type InstallerDeps,
  type InstallerFs,
  type InstallerPath,
  type InstallerPlatformTag,
  type InstallerSpawnSync,
} from "./installer.js";

export {
  runPreflight,
  type DependencyStatus,
  type PreflightDeps,
  type PreflightReport,
  type PreflightSpawnSync,
} from "./preflight.js";

export {
  BackendNotInstalledError,
  HealthTimeoutError,
  PixelleBackendSupervisor,
  type EphemeralPortFn,
  type HealthFetchFn,
  type LogLine,
  type SpawnFn,
  type SupervisorChildProcess,
  type SupervisorDeps,
  type SupervisorRuntimeConfig,
  type SupervisorStartResult,
  type SupervisorStatus,
  type SupervisorTimers,
} from "./process-manager.js";

export {
  bindInternalToken,
  INTERNAL_TOKEN_ALLOWED_ROUTES,
  InternalTokenRegistry,
  type AuditEvent,
  type AuditSink,
  type AuthorizationCheckInput,
  type AuthorizationCheckResult,
  type InternalTokenMetadata,
  type IssueOptions,
  type RegistryDeps,
  type TokenGenerator,
} from "./internal-token.js";

export {
  buildDefaultLlmPassthroughAgent,
  detectLlmPassthroughDrift,
  LLM_PASSTHROUGH_AGENT_ID,
  type BuildOptions as LlmPassthroughBuildOptions,
  type DriftReport as LlmPassthroughDriftReport,
  type LlmPassthroughAgentConfig,
} from "./llm-passthrough-agent.js";

export {
  DEFAULT_VIDEO_STUDIO_SETTINGS,
  detectSettingsChanges,
  flattenForPersistence,
  parseVideoStudioSettings,
  RESTART_REQUIRED_FIELDS,
  VIDEO_STUDIO_SETTINGS_KEY_PREFIX,
  type SettingsChange,
  type SettingsDiff,
  type VideoStudioBackendStatusSnapshot,
  type VideoStudioSettings,
} from "./settings.js";

export {
  redact,
  VideoStudioDiagnostics,
  type DiagnosticsBundle,
  type DiagnosticsConfig,
  type HealthCheckObservation,
  type LlmCallSummary,
} from "./diagnostics.js";
