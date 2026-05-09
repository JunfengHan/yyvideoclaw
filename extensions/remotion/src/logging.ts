// Logging helpers that enforce the plugin's redaction rules.
//
// Rule: we never print inputProps values — only their top-level key names
// and their JSON byte size. This prevents accidental leakage of arbitrary
// user-controlled data (URLs, API keys embedded in props, etc.) to the
// OpenClaw logs.

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

export interface PropsSummary {
  keys: string[];
  byteSize: number;
  truncatedKeys: boolean;
}

const MAX_KEYS_IN_SUMMARY = 32;

export function summarizeInputProps(props: unknown): PropsSummary {
  if (props === null || typeof props !== "object" || Array.isArray(props)) {
    const byteSize = safeJsonByteSize(props);
    return { keys: [], byteSize, truncatedKeys: false };
  }
  const allKeys = Object.keys(props as Record<string, unknown>);
  const truncated = allKeys.length > MAX_KEYS_IN_SUMMARY;
  const keys = truncated ? allKeys.slice(0, MAX_KEYS_IN_SUMMARY) : allKeys;
  return {
    keys,
    byteSize: safeJsonByteSize(props),
    truncatedKeys: truncated,
  };
}

function safeJsonByteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  } catch {
    return -1; // non-serialisable; caller logs a sentinel, not the value
  }
}

/**
 * Truncate an error message to a sane length for logs. Never include an
 * error's full stack in user-facing logs — we keep it at debug level only.
 */
export function describeError(err: unknown, maxLen = 512): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.length <= maxLen) {
    return message;
  }
  return `${message.slice(0, maxLen)}… [truncated ${message.length - maxLen} chars]`;
}

export function logJobStart(
  logger: PluginLogger,
  info: {
    jobId: string;
    kind: "video" | "still" | "list";
    entryPoint: string;
    compositionId?: string;
    propsSummary?: PropsSummary;
  },
): void {
  logger.info("remotion job starting", {
    jobId: info.jobId,
    kind: info.kind,
    entryPoint: info.entryPoint,
    ...(info.compositionId ? { compositionId: info.compositionId } : {}),
    ...(info.propsSummary
      ? {
          propsKeys: info.propsSummary.keys,
          propsBytes: info.propsSummary.byteSize,
          propsKeysTruncated: info.propsSummary.truncatedKeys,
        }
      : {}),
  });
}

export function logJobFinish(
  logger: PluginLogger,
  info: { jobId: string; durationMs: number; outputPath?: string; sizeBytes?: number },
): void {
  logger.info("remotion job finished", info);
}

export function logJobFailure(
  logger: PluginLogger,
  info: { jobId: string; durationMs: number; error: unknown },
): void {
  logger.warn("remotion job failed", {
    jobId: info.jobId,
    durationMs: info.durationMs,
    error: describeError(info.error),
  });
}
