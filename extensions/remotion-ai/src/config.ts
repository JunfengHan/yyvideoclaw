// Resolve and validate the remotion-ai plugin configuration.
//
// Parallel to `extensions/remotion/src/config.ts`: throws `RemotionAiConfigError`
// on structural/value misconfiguration so `index.ts` can surface a single,
// human-readable error and skip route registration.

import os from "node:os";
import path from "node:path";

export class RemotionAiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemotionAiConfigError";
  }
}

export type RemotionAiEngineId = "codex";

export interface ResolvedRemotionAiConfig {
  readonly engine: RemotionAiEngineId;
  /**
   * Absolute directory where every AI Create job lands by default. The user
   * does not need to configure or pick an output directory — the plugin
   * owns this path as a stable "library root". Any job that isn't given an
   * explicit `outputRoot` at submit time falls back to this.
   *
   * M1 default: `<os.homedir()>/.openclaw/remotion-ai/library`.
   */
  readonly defaultOutputRoot: string;
  /**
   * Optional allowlist of directories the caller is *also* allowed to
   * target via explicit `outputRoot`. Empty / undefined = only the default
   * library root is accepted. `defaultOutputRoot` is always implicitly
   * allowed regardless of this list.
   */
  readonly outputRootAllowlist: readonly string[] | undefined;
  readonly retryMax: number;
  readonly jobTimeoutMs: number;
  readonly skillsBundled: boolean;
  readonly starterDir: string | undefined;
  readonly allowNetwork: boolean;
  readonly chromiumExecutablePath: string | undefined;
  readonly maxOutputBytes: number;
}

const DEFAULTS = {
  engine: "codex" as const,
  retryMax: 3,
  jobTimeoutMs: 600_000,
  skillsBundled: true,
  allowNetwork: false,
  maxOutputBytes: 10 * 1024 * 1024,
} as const;

const ALLOWED_ENGINES: ReadonlySet<RemotionAiEngineId> = new Set(["codex"]);

/**
 * Compute the default library root. Exported so tests (and the library
 * route) can know the canonical path without duplicating the formula.
 *
 * Windows + POSIX are both fine here because we only rely on
 * `os.homedir() + path.join(...)`.
 */
export function computeDefaultOutputRoot(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".openclaw", "remotion-ai", "library");
}

export function resolveRemotionAiConfig(raw: unknown): ResolvedRemotionAiConfig {
  const cfg = asObject(raw);
  const engine = resolveEngine(cfg.engine);
  const defaultOutputRoot =
    resolveOptionalAbsolutePath(cfg.defaultOutputRoot, "defaultOutputRoot") ??
    computeDefaultOutputRoot();
  const outputRootAllowlist = resolveOutputRootAllowlist(cfg.outputRootAllowlist);
  const retryMax = resolveNumber(cfg.retryMax, DEFAULTS.retryMax, {
    field: "retryMax",
    min: 0,
    max: 10,
    integer: true,
  });
  const jobTimeoutMs = resolveNumber(cfg.jobTimeoutMs, DEFAULTS.jobTimeoutMs, {
    field: "jobTimeoutMs",
    min: 1000,
    integer: true,
  });
  const skillsBundled = resolveBoolean(cfg.skillsBundled, DEFAULTS.skillsBundled, "skillsBundled");
  const starterDir = resolveOptionalAbsolutePath(cfg.starterDir, "starterDir");
  const allowNetwork = resolveBoolean(cfg.allowNetwork, DEFAULTS.allowNetwork, "allowNetwork");
  const chromiumExecutablePath = resolveOptionalAbsolutePath(
    cfg.chromiumExecutablePath,
    "chromiumExecutablePath",
  );
  const maxOutputBytes = resolveNumber(cfg.maxOutputBytes, DEFAULTS.maxOutputBytes, {
    field: "maxOutputBytes",
    min: 1024,
    integer: true,
  });

  return {
    engine,
    defaultOutputRoot,
    outputRootAllowlist,
    retryMax,
    jobTimeoutMs,
    skillsBundled,
    starterDir,
    allowNetwork,
    chromiumExecutablePath,
    maxOutputBytes,
  };
}

function asObject(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RemotionAiConfigError("plugin config must be a JSON object");
  }
  return raw as Record<string, unknown>;
}

function resolveEngine(value: unknown): RemotionAiEngineId {
  if (value === undefined) {
    return DEFAULTS.engine;
  }
  if (typeof value !== "string") {
    throw new RemotionAiConfigError("engine must be a string");
  }
  if (!ALLOWED_ENGINES.has(value as RemotionAiEngineId)) {
    const allowed = [...ALLOWED_ENGINES].join(", ");
    throw new RemotionAiConfigError(`engine must be one of: ${allowed}`);
  }
  return value as RemotionAiEngineId;
}

function resolveOutputRootAllowlist(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new RemotionAiConfigError("outputRootAllowlist must be an array of absolute paths");
  }
  const entries: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new RemotionAiConfigError(`outputRootAllowlist[${index}] must be a non-empty string`);
    }
    if (!entry.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(entry)) {
      throw new RemotionAiConfigError(
        `outputRootAllowlist[${index}] must be an absolute path: ${entry}`,
      );
    }
    entries.push(entry);
  }
  return Object.freeze(entries);
}

function resolveNumber(
  value: unknown,
  fallback: number,
  options: { field: string; min?: number; max?: number; integer?: boolean },
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RemotionAiConfigError(`${options.field} must be a finite number`);
  }
  if (options.integer && !Number.isInteger(value)) {
    throw new RemotionAiConfigError(`${options.field} must be an integer`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new RemotionAiConfigError(`${options.field} must be >= ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new RemotionAiConfigError(`${options.field} must be <= ${options.max}`);
  }
  return value;
}

function resolveBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new RemotionAiConfigError(`${field} must be a boolean`);
  }
  return value;
}

function resolveOptionalAbsolutePath(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new RemotionAiConfigError(`${field} must be a non-empty absolute path`);
  }
  if (!value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value)) {
    throw new RemotionAiConfigError(`${field} must be an absolute path: ${value}`);
  }
  return value;
}
