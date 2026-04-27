// Video Studio diagnostics bundle.
//
// Central place that aggregates everything the Debug tab, the "Copy
// diagnostics" button, and the user's bug-report template need to know
// about the embedded Pixelle backend. No I/O lives here on purpose:
//
//   - the supervisor / client owns the raw events
//   - this module owns their shape, ring-buffering and redaction policy
//   - the Debug view + clipboard helper pull a `DiagnosticsBundle`
//     off `VideoStudioDiagnostics.snapshot()` on demand
//
// Redaction rules (requirements §8.2, §9.4):
//
//   - The internal bearer token must never appear in any diagnostic.
//   - Prompts / completions bodies are OUT of scope — we only log
//     model id, token usage counters, latency.
//   - Log lines are stripped of any literal substring that matches a
//     caller-supplied "secret" list (typically the live supervisor
//     token). Callers should register every new token they issue.

import type { LogLine, SupervisorStatus } from "./process-manager.js";

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export type LlmCallSummary = {
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
  readonly at: string;
};

export type HealthCheckObservation = {
  readonly at: string;
  readonly durationMs: number;
  readonly ok: boolean;
};

export type DiagnosticsBundle = {
  readonly capturedAt: string;
  readonly status: SupervisorStatus;
  readonly pid: number | null;
  readonly port: number | null;
  readonly startCommand: string | null;
  readonly lastHealthCheck: HealthCheckObservation | null;
  readonly recentLlmCalls: readonly LlmCallSummary[];
  readonly recentLogs: readonly LogLine[];
  /** Application-side metadata useful for issue triage. */
  readonly appInfo: {
    readonly videoStudioVersion: string;
    readonly pixelleCommit: string | null;
  };
};

export type DiagnosticsConfig = {
  /** How many LLM calls to keep (requirements §9.3: "last 20"). */
  readonly llmRingSize?: number;
  /** How many log lines to keep (requirements §9.4: "last 100"). */
  readonly logRingSize?: number;
  /** How many log lines to include in errorpanel tail (requirements §2.4). */
  readonly errorTailLines?: number;
  /** Secret strings to scrub from every log line before recording. */
  readonly secrets?: readonly string[];
  /** Metadata for the bug-report bundle header. */
  readonly appInfo?: {
    readonly videoStudioVersion?: string;
    readonly pixelleCommit?: string | null;
  };
  /** Inject-able clock for deterministic tests. */
  readonly now?: () => Date;
};

const DEFAULT_LLM_RING_SIZE = 20;
const DEFAULT_LOG_RING_SIZE = 100;
const DEFAULT_ERROR_TAIL_LINES = 200;

// ---------------------------------------------------------------------------
// Redaction.
// ---------------------------------------------------------------------------

export function redact(line: string, secrets: readonly string[]): string {
  let redacted = line;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    // Global literal replace; we deliberately avoid regex so pathological
    // secret values (containing regex metachars) don't slip through.
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  // Always scrub `authorization: bearer ...` headers that may leak in
  // verbose Python tracebacks — even if the secret list is empty.
  redacted = redacted.replace(/(authorization\s*:\s*bearer\s+)\S+/gi, "$1[REDACTED]");
  return redacted;
}

// ---------------------------------------------------------------------------
// Diagnostics store.
// ---------------------------------------------------------------------------

/**
 * Fixed-size ring buffer used for recent logs + LLM calls. Implemented
 * as a plain class (no Array subclass) so the `snapshot()` call is O(n)
 * with a predictable order.
 */
class RingBuffer<T> {
  private readonly buffer: T[] = [];
  constructor(private readonly limit: number) {}
  push(entry: T): void {
    if (this.limit <= 0) return;
    this.buffer.push(entry);
    if (this.buffer.length > this.limit) {
      this.buffer.splice(0, this.buffer.length - this.limit);
    }
  }
  snapshot(): readonly T[] {
    return Array.from(this.buffer);
  }
  get size(): number {
    return this.buffer.length;
  }
}

export class VideoStudioDiagnostics {
  private readonly logs: RingBuffer<LogLine>;
  private readonly calls: RingBuffer<LlmCallSummary>;
  private readonly now: () => Date;
  private readonly secrets: Set<string>;
  private readonly errorTailLines: number;
  private readonly appInfo: { videoStudioVersion: string; pixelleCommit: string | null };

  private status: SupervisorStatus = { state: "idle" };
  private startCommand: string | null = null;
  private pid: number | null = null;
  private port: number | null = null;
  private lastHealthCheck: HealthCheckObservation | null = null;

  constructor(cfg: DiagnosticsConfig = {}) {
    this.logs = new RingBuffer<LogLine>(cfg.logRingSize ?? DEFAULT_LOG_RING_SIZE);
    this.calls = new RingBuffer<LlmCallSummary>(cfg.llmRingSize ?? DEFAULT_LLM_RING_SIZE);
    this.errorTailLines = cfg.errorTailLines ?? DEFAULT_ERROR_TAIL_LINES;
    this.now = cfg.now ?? (() => new Date());
    this.secrets = new Set(cfg.secrets ?? []);
    this.appInfo = {
      videoStudioVersion: cfg.appInfo?.videoStudioVersion ?? "unknown",
      pixelleCommit: cfg.appInfo?.pixelleCommit ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Mutators — call these from supervisor / client hooks.
  // -------------------------------------------------------------------------

  registerSecret(secret: string): void {
    if (secret && secret.length >= 4) {
      this.secrets.add(secret);
    }
  }

  forgetSecret(secret: string): void {
    this.secrets.delete(secret);
  }

  onStatus(status: SupervisorStatus): void {
    this.status = status;
    if (status.state === "running") {
      this.pid = status.pid;
      this.port = status.port;
      this.startCommand = status.command;
    } else if (status.state === "idle" || status.state === "stopped") {
      this.pid = null;
      this.port = null;
    }
  }

  onLog(line: LogLine): void {
    this.logs.push({
      stream: line.stream,
      line: redact(line.line, Array.from(this.secrets)),
    });
  }

  onHealthCheck(obs: { readonly durationMs: number; readonly ok: boolean }): void {
    this.lastHealthCheck = { ...obs, at: this.now().toISOString() };
  }

  onLlmCall(summary: Omit<LlmCallSummary, "at">): void {
    this.calls.push({ ...summary, at: this.now().toISOString() });
  }

  // -------------------------------------------------------------------------
  // Read-only snapshots.
  // -------------------------------------------------------------------------

  snapshot(): DiagnosticsBundle {
    return {
      capturedAt: this.now().toISOString(),
      status: this.status,
      pid: this.pid,
      port: this.port,
      startCommand: this.startCommand,
      lastHealthCheck: this.lastHealthCheck,
      recentLlmCalls: this.calls.snapshot(),
      recentLogs: this.logs.snapshot(),
      appInfo: { ...this.appInfo },
    };
  }

  /**
   * Tail used by the supervisor's "backend failed to start" error card.
   * Enforces the 200-line cap from requirements §2.4 independently of
   * the ring-buffer size so a verbose crash still fits in the UI.
   */
  getErrorTail(): readonly LogLine[] {
    const all = this.logs.snapshot();
    return all.slice(-this.errorTailLines);
  }
}
