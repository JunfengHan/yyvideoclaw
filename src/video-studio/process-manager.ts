// Pixelle backend supervisor — owns the Python FastAPI subprocess lifecycle
// on behalf of the embedded Video Studio tab.
//
// Responsibilities (per requirements §2, §4.5, §9, §10):
//
//   - Lazy start: never spawn Pixelle at app boot; only on the first caller
//     to `startIfNeeded()` (triggered by the tab entering view / explicit
//     "Start Backend" button in Settings).
//   - Port selection: allocate an ephemeral loopback port so we never clash
//     with user-bound services.
//   - Env injection: build `PIXELLE_*` env vars from the caller's config so
//     Pixelle's LLM provider points back at yyvideoclaw's Gateway with the
//     one-shot `internal` bearer token issued by `internal-token.ts`.
//   - Health check: poll `GET /health` until it returns 200 or the 30s
//     timeout elapses, at which point we surface an `InstallError` /
//     `HealthTimeoutError` to the UI.
//   - Log forwarding: stream stdout+stderr line-by-line to a pluggable
//     `onLogLine` handler so the Logs tab can present them with
//     `source=video-studio`.
//   - Graceful shutdown: SIGTERM, then SIGKILL after 10s if the child has
//     not exited. Always invoked on explicit `stop()`, on `restart()`, and
//     from the app-exit hook the caller is expected to wire up.
//   - Crash recovery: if the child exits unexpectedly, retry at 2s / 5s /
//     15s and then fall into a terminal `stopped` state with an event so
//     the UI can show `backend crashed (retrying...)` or the error card.
//   - Idle auto-stop: after `autoStopIdleMinutes` of no activity, stop the
//     child to release memory (tunable; `0` disables the behaviour).
//
// Everything with external side effects is injected so the class is trivial
// to unit-test with in-memory fakes (see `process-manager.test.ts`).

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { BackendResolution } from "./installer.js";

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export type SupervisorStatus =
  | { readonly state: "idle" }
  | { readonly state: "starting"; readonly attempt: number }
  | {
      readonly state: "running";
      readonly pid: number;
      readonly port: number;
      readonly startedAt: Date;
      readonly command: string;
    }
  | {
      readonly state: "retrying";
      readonly attempt: number;
      readonly retryInMs: number;
      readonly reason: string;
    }
  | { readonly state: "stopped"; readonly reason: string };

export type LogLine = { readonly stream: "stdout" | "stderr"; readonly line: string };

/** Minimal shape of `node:child_process.spawn`'s return value we need. */
export type SupervisorChildProcess = Pick<ChildProcess, "pid" | "kill"> & {
  readonly stdout?: Pick<NodeJS.ReadableStream, "on"> | null;
  readonly stderr?: Pick<NodeJS.ReadableStream, "on"> | null;
  readonly stdin?: { readonly end?: () => void } | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
};

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly cwd?: string },
) => SupervisorChildProcess;

export type HealthFetchFn = (
  url: string,
  opts: { readonly signal: AbortSignal },
) => Promise<{ readonly ok: boolean }>;

export type EphemeralPortFn = () => Promise<number>;

/** Inject-able timer surface for deterministic tests. */
export type SupervisorTimers = {
  readonly setTimeout: (cb: () => void, ms: number) => { readonly cancel: () => void };
  readonly now: () => number;
};

export type SupervisorDeps = {
  readonly spawn: SpawnFn;
  readonly fetch: HealthFetchFn;
  readonly allocatePort: EphemeralPortFn;
  readonly timers: SupervisorTimers;
};

export type SupervisorRuntimeConfig = {
  /** Gateway base URL Pixelle should hit for `/v1/chat/completions`. */
  readonly gatewayBaseUrl: string;
  /** One-shot internal bearer token registered via `internal-token.ts`. */
  readonly internalToken: string;
  /** llm-passthrough agent id (e.g. `openclaw/llm-passthrough`). */
  readonly agentId: string;
  /** Current user-selected default model (e.g. `qwen/qwen-max`). */
  readonly defaultModel: string;
  /** Absolute path to the Pixelle data root (media outputs, cache). */
  readonly dataRoot: string;
  /** Idle auto-stop threshold in minutes; `0` disables. Defaults to 30. */
  readonly autoStopIdleMinutes?: number;
  /** Health-check timeout override (defaults to 30_000 ms). */
  readonly healthTimeoutMs?: number;
  /** Retry schedule override (defaults to [2000, 5000, 15000]). */
  readonly retryScheduleMs?: readonly number[];
  /** Line-oriented log sink; defaults to a no-op. */
  readonly onLogLine?: (line: LogLine) => void;
};

export type SupervisorStartResult = {
  readonly port: number;
  readonly endpoint: string;
  readonly pid: number;
};

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

export class BackendNotInstalledError extends Error {
  constructor(reason: string) {
    super(`Pixelle backend is not installed: ${reason}`);
    this.name = "BackendNotInstalledError";
  }
}

export class HealthTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Pixelle backend failed its health check within ${timeoutMs}ms.`);
    this.name = "HealthTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Supervisor.
// ---------------------------------------------------------------------------

type EmitterEvents = {
  status: SupervisorStatus;
  log: LogLine;
  "backend-crashed": { readonly attempt: number; readonly reason: string };
};

const DEFAULT_RETRY_SCHEDULE_MS: readonly number[] = [2_000, 5_000, 15_000];
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const GRACEFUL_SHUTDOWN_MS = 10_000;
const DEFAULT_IDLE_STOP_MINUTES = 30;

export class PixelleBackendSupervisor {
  private readonly emitter = new EventEmitter();
  private readonly deps: SupervisorDeps;
  private readonly resolution: BackendResolution;
  private readonly cfg: Required<
    Pick<SupervisorRuntimeConfig, "healthTimeoutMs" | "retryScheduleMs" | "autoStopIdleMinutes">
  > &
    SupervisorRuntimeConfig;

  private child: SupervisorChildProcess | null = null;
  private status: SupervisorStatus = { state: "idle" };
  private retryTimer: { readonly cancel: () => void } | null = null;
  private idleTimer: { readonly cancel: () => void } | null = null;
  private lastActivityAt = 0;

  constructor(resolution: BackendResolution, cfg: SupervisorRuntimeConfig, deps: SupervisorDeps) {
    this.resolution = resolution;
    this.deps = deps;
    this.cfg = {
      ...cfg,
      healthTimeoutMs: cfg.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
      retryScheduleMs: cfg.retryScheduleMs ?? DEFAULT_RETRY_SCHEDULE_MS,
      autoStopIdleMinutes: cfg.autoStopIdleMinutes ?? DEFAULT_IDLE_STOP_MINUTES,
    };
  }

  // -------------------------------------------------------------------------
  // Public API.
  // -------------------------------------------------------------------------

  getStatus(): SupervisorStatus {
    return this.status;
  }

  on<K extends keyof EmitterEvents>(
    event: K,
    listener: (payload: EmitterEvents[K]) => void,
  ): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  /** Mark the supervisor as "still in use" — resets the idle auto-stop timer. */
  noteActivity(): void {
    this.lastActivityAt = this.deps.timers.now();
    this.armIdleTimer();
  }

  async startIfNeeded(): Promise<SupervisorStartResult> {
    if (this.status.state === "running") {
      this.noteActivity();
      return {
        port: this.status.port,
        endpoint: `http://127.0.0.1:${this.status.port}`,
        pid: this.status.pid,
      };
    }
    return this.startOnce(1);
  }

  async restart(): Promise<SupervisorStartResult> {
    await this.stop("restart requested");
    return this.startOnce(1);
  }

  async stop(reason = "explicit stop"): Promise<void> {
    this.cancelTimers();
    const child = this.child;
    if (!child) {
      this.setStatus({ state: "stopped", reason });
      return;
    }
    this.child = null;
    await this.gracefullyKill(child);
    this.setStatus({ state: "stopped", reason });
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

  private async startOnce(attempt: number): Promise<SupervisorStartResult> {
    if (this.resolution.kind === "missing") {
      this.setStatus({ state: "stopped", reason: this.resolution.reason });
      throw new BackendNotInstalledError(this.resolution.reason);
    }
    this.setStatus({ state: "starting", attempt });

    const port = await this.deps.allocatePort();
    const { command, args } = this.buildLaunchSpec();
    const env = this.buildEnv(port);
    const child = this.deps.spawn(command, args, { env });
    this.child = child;
    this.attachStdio(child);
    this.attachExitHandler(child, attempt);

    try {
      await this.waitForHealth(port);
    } catch (err) {
      // Health failure counts as a crash for retry accounting; propagate the
      // original error to the caller so UI can distinguish "install looks OK
      // but it just won't start" from "not installed at all".
      this.child = null;
      await this.gracefullyKill(child);
      this.scheduleRetryIfRoom(attempt, err instanceof Error ? err.message : String(err));
      throw err;
    }

    const pid = child.pid ?? -1;
    this.setStatus({
      state: "running",
      pid,
      port,
      startedAt: new Date(this.deps.timers.now()),
      command: `${command} ${args.join(" ")}`.trim(),
    });
    this.noteActivity();
    return { port, endpoint: `http://127.0.0.1:${port}`, pid };
  }

  private buildLaunchSpec(): { readonly command: string; readonly args: readonly string[] } {
    if (this.resolution.kind === "binary") {
      return { command: this.resolution.executable, args: [] };
    }
    if (this.resolution.kind === "venv") {
      // The packaging shim (see scripts/video-studio/build-backend.mjs)
      // exposes a tiny uvicorn launcher; for the venv fallback we call
      // `python -m uvicorn api.app:app --host ... --port ...` which is
      // wired through env vars below to avoid string-interpolation risk.
      return {
        command: this.resolution.python,
        args: [
          "-m",
          "uvicorn",
          this.resolution.entryModule,
          "--host",
          "127.0.0.1",
          "--port",
          "$PIXELLE_PORT",
        ],
      };
    }
    throw new BackendNotInstalledError("no resolvable backend");
  }

  private buildEnv(port: number): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PIXELLE_EMBEDDED_MODE: "1",
      PIXELLE_HOST: "127.0.0.1",
      PIXELLE_PORT: String(port),
      PIXELLE_DATA_ROOT: this.cfg.dataRoot,
      PIXELLE_LLM_PROVIDER: "openclaw",
      PIXELLE_OPENCLAW_BASE_URL: this.cfg.gatewayBaseUrl,
      PIXELLE_OPENCLAW_TOKEN: this.cfg.internalToken,
      PIXELLE_OPENCLAW_AGENT: this.cfg.agentId,
      PIXELLE_OPENCLAW_MODEL: this.cfg.defaultModel,
    };
  }

  private attachStdio(child: SupervisorChildProcess): void {
    const sink = this.cfg.onLogLine ?? (() => {});
    const emit = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (line.length === 0) continue;
        const payload: LogLine = { stream, line };
        sink(payload);
        this.emitter.emit("log", payload);
      }
    };
    child.stdout?.on("data", (chunk: Buffer | string) => emit("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => emit("stderr", chunk));
  }

  private attachExitHandler(child: SupervisorChildProcess, attempt: number): void {
    child.on("exit", (code, signal) => {
      if (this.child !== child) {
        // Superseded by `stop()` / `restart()`; ignore.
        return;
      }
      this.child = null;
      const reason = `Pixelle exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      this.scheduleRetryIfRoom(attempt, reason);
    });
    child.on("error", (err) => {
      if (this.child !== child) return;
      this.child = null;
      this.scheduleRetryIfRoom(attempt, err.message);
    });
  }

  private scheduleRetryIfRoom(previousAttempt: number, reason: string): void {
    const schedule = this.cfg.retryScheduleMs;
    if (previousAttempt > schedule.length) {
      this.setStatus({ state: "stopped", reason });
      this.emitter.emit("backend-crashed", { attempt: previousAttempt, reason });
      return;
    }
    const retryInMs = schedule[previousAttempt - 1] ?? schedule[schedule.length - 1] ?? 0;
    this.setStatus({ state: "retrying", attempt: previousAttempt + 1, retryInMs, reason });
    this.emitter.emit("backend-crashed", { attempt: previousAttempt, reason });
    this.retryTimer = this.deps.timers.setTimeout(() => {
      this.retryTimer = null;
      void this.startOnce(previousAttempt + 1).catch(() => {
        // Errors have already been surfaced through status + events; swallow
        // here so the timer callback never rejects asynchronously.
      });
    }, retryInMs);
  }

  private async waitForHealth(port: number): Promise<void> {
    const deadline = this.deps.timers.now() + this.cfg.healthTimeoutMs;
    while (this.deps.timers.now() < deadline) {
      const ac = new AbortController();
      const slice = this.deps.timers.setTimeout(() => ac.abort(), HEALTH_POLL_INTERVAL_MS * 2);
      try {
        const res = await this.deps.fetch(`http://127.0.0.1:${port}/health`, { signal: ac.signal });
        if (res.ok) return;
      } catch {
        // swallow — we keep polling until the deadline passes.
      } finally {
        slice.cancel();
      }
      await this.sleep(HEALTH_POLL_INTERVAL_MS);
    }
    throw new HealthTimeoutError(this.cfg.healthTimeoutMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.deps.timers.setTimeout(resolve, ms);
    });
  }

  private async gracefullyKill(child: SupervisorChildProcess): Promise<void> {
    let exited = false;
    child.on("exit", () => {
      exited = true;
    });
    try {
      child.kill("SIGTERM");
    } catch {
      // best-effort
    }
    const start = this.deps.timers.now();
    while (!exited && this.deps.timers.now() - start < GRACEFUL_SHUTDOWN_MS) {
      await this.sleep(HEALTH_POLL_INTERVAL_MS);
    }
    if (!exited) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore — process may already be gone.
      }
    }
  }

  private armIdleTimer(): void {
    this.idleTimer?.cancel();
    this.idleTimer = null;
    if (this.cfg.autoStopIdleMinutes <= 0) return;
    const ms = this.cfg.autoStopIdleMinutes * 60 * 1_000;
    this.idleTimer = this.deps.timers.setTimeout(() => {
      this.idleTimer = null;
      const last = this.lastActivityAt;
      const elapsed = this.deps.timers.now() - last;
      if (elapsed + 1 >= ms && this.status.state === "running") {
        void this.stop("idle auto-stop").catch(() => {
          // Already captured in status; nothing else to do here.
        });
      } else {
        // New activity arrived while we were armed; re-arm with the residual.
        this.armIdleTimer();
      }
    }, ms);
  }

  private cancelTimers(): void {
    this.retryTimer?.cancel();
    this.retryTimer = null;
    this.idleTimer?.cancel();
    this.idleTimer = null;
  }

  private setStatus(next: SupervisorStatus): void {
    this.status = next;
    this.emitter.emit("status", next);
  }
}
