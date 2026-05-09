// Runtime-side configuration resolution for the Remotion plugin.
//
// The JSON Schema in `openclaw.plugin.json` guarantees structural shape of the
// values OpenClaw passes in via `api.pluginConfig`. This module narrows those
// `unknown` values to a typed `RemotionPluginConfig`, applies defaults for
// optional fields, and performs the minimum sanity checks needed before the
// value is safe to use elsewhere in the plugin.

import { homedir } from "node:os";
import path from "node:path";
import type { RemotionPluginConfig } from "./types.js";

const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_OUTPUT_BYTES = 500 * 1024 * 1024; // 500 MiB

export class RemotionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemotionConfigError";
  }
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new RemotionConfigError(`config.${field} must be an array of strings`);
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new RemotionConfigError(`config.${field} entries must be non-empty strings`);
    }
    result.push(entry);
  }
  return result;
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new RemotionConfigError(`config.${field} must be a non-empty string when provided`);
  }
  return value;
}

function asOptionalPositiveNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RemotionConfigError(`config.${field} must be a positive finite number`);
  }
  return value;
}

function asOptionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new RemotionConfigError(`config.${field} must be a boolean`);
  }
  return value;
}

/**
 * Resolve a user-supplied path. We REFUSE relative paths here — the plugin
 * operates on trusted absolute paths only so that `templateRoots` can be used
 * as a security-relevant allowlist without any ambient-cwd surprises.
 */
function requireAbsolute(value: string, field: string): string {
  if (!path.isAbsolute(value)) {
    throw new RemotionConfigError(`config.${field} must be an absolute path, got: ${value}`);
  }
  return path.normalize(value);
}

export function resolveRemotionConfig(raw: unknown): RemotionPluginConfig {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const templateRootsRaw = asStringArray(input.templateRoots, "templateRoots");
  if (templateRootsRaw.length === 0) {
    throw new RemotionConfigError("config.templateRoots must contain at least one directory");
  }
  const templateRoots = templateRootsRaw.map((root) => requireAbsolute(root, "templateRoots[]"));

  const outputDirRaw = asOptionalString(input.outputDir, "outputDir");
  const cacheDirRaw = asOptionalString(input.cacheDir, "cacheDir");
  const chromiumExecutablePathRaw = asOptionalString(
    input.chromiumExecutablePath,
    "chromiumExecutablePath",
  );

  return {
    templateRoots,
    outputDir: outputDirRaw
      ? requireAbsolute(outputDirRaw, "outputDir")
      : path.join(homedir(), ".openclaw", "remotion", "outputs"),
    cacheDir: cacheDirRaw
      ? requireAbsolute(cacheDirRaw, "cacheDir")
      : path.join(homedir(), ".openclaw", "remotion", "cache"),
    jobTimeoutMs: asOptionalPositiveNumber(
      input.jobTimeoutMs,
      "jobTimeoutMs",
      DEFAULT_JOB_TIMEOUT_MS,
    ),
    maxOutputBytes: asOptionalPositiveNumber(
      input.maxOutputBytes,
      "maxOutputBytes",
      DEFAULT_MAX_OUTPUT_BYTES,
    ),
    allowNetwork: asOptionalBoolean(input.allowNetwork, "allowNetwork", false),
    ...(chromiumExecutablePathRaw
      ? {
          chromiumExecutablePath: requireAbsolute(
            chromiumExecutablePathRaw,
            "chromiumExecutablePath",
          ),
        }
      : {}),
  };
}
