// extensions/remotion-ai/src/logging.ts
//
// Tiny logging facade. Keeps log payloads narrow (no prompt text, no full
// stack traces, no host paths) so jobs can be observed without leaking
// workspace contents into the gateway log stream.
//
// PluginLogger only accepts a single `message: string` argument
// (see `src/plugins/types.ts`). Structured fields are serialized into a
// compact `key=value` suffix, which is grep-friendly while staying within
// the SDK contract.

import path from "node:path";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { Phase } from "./types.js";
import type { ValidationStage, ValidationStageTimings } from "./validator/types.js";

export interface JobStartLog {
  readonly jobId: string;
  readonly engine: string;
  readonly workspaceDir: string;
}

export interface JobPhaseLog {
  readonly jobId: string;
  readonly phase: Phase;
}

export interface JobValidationLog {
  readonly jobId: string;
  readonly stage: ValidationStage;
  readonly success: boolean;
  readonly stages?: Partial<ValidationStageTimings>;
}

export interface JobRetryLog {
  readonly jobId: string;
  readonly attempt: number;
  readonly retriesLeft: number;
  readonly stage: ValidationStage;
}

export interface JobFinishLog {
  readonly jobId: string;
  readonly outcome: "done" | "failed" | "cancelled";
  readonly retryCount: number;
  readonly durationMs: number;
}

/** Replace the absolute workspace prefix with `<ws>` for safe logging. */
export function redactWorkspacePath(target: string, workspaceDir: string): string {
  const withSep = workspaceDir.endsWith(path.sep) ? workspaceDir : workspaceDir + path.sep;
  if (target === workspaceDir) {
    return "<ws>";
  }
  if (target.startsWith(withSep)) {
    return `<ws>/${target.slice(withSep.length)}`;
  }
  return target;
}

/**
 * Compact `k1=v1 k2=v2` rendering of structured log fields. Preserves
 * order, skips `undefined` values, JSON-encodes any non-primitive value.
 */
function renderFields(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    let rendered: string;
    if (typeof value === "string") {
      rendered = value.includes(" ") ? JSON.stringify(value) : value;
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      rendered = String(value);
    } else {
      rendered = JSON.stringify(value);
    }
    parts.push(`${key}=${rendered}`);
  }
  return parts.join(" ");
}

function format(message: string, fields: Record<string, unknown>): string {
  const rendered = renderFields(fields);
  return rendered.length === 0 ? message : `${message} ${rendered}`;
}

export function logJobStart(logger: PluginLogger, info: JobStartLog): void {
  logger.info(
    format("remotion-ai job start", {
      jobId: info.jobId,
      engine: info.engine,
      workspaceDir: redactWorkspacePath(info.workspaceDir, info.workspaceDir),
    }),
  );
}

export function logJobPhase(logger: PluginLogger, info: JobPhaseLog): void {
  logger.debug?.(format("remotion-ai job phase", { jobId: info.jobId, phase: info.phase }));
}

export function logJobValidation(logger: PluginLogger, info: JobValidationLog): void {
  logger.info(
    format(`remotion-ai validation ${info.success ? "ok" : "failed"}`, {
      jobId: info.jobId,
      stage: info.stage,
      ...(info.stages ? { stages: info.stages } : {}),
    }),
  );
}

export function logJobRetry(logger: PluginLogger, info: JobRetryLog): void {
  logger.info(
    format("remotion-ai retry", {
      jobId: info.jobId,
      attempt: info.attempt,
      retriesLeft: info.retriesLeft,
      stage: info.stage,
    }),
  );
}

export function logJobFinish(logger: PluginLogger, info: JobFinishLog): void {
  logger.info(
    format(`remotion-ai job ${info.outcome}`, {
      jobId: info.jobId,
      retryCount: info.retryCount,
      durationMs: info.durationMs,
    }),
  );
}
