import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendResolution } from "./installer.js";
import {
  BackendNotInstalledError,
  HealthTimeoutError,
  PixelleBackendSupervisor,
  type HealthFetchFn,
  type LogLine,
  type SpawnFn,
  type SupervisorChildProcess,
  type SupervisorDeps,
  type SupervisorRuntimeConfig,
  type SupervisorTimers,
} from "./process-manager.js";

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter implements SupervisorChildProcess {
  readonly pid: number;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { end: () => {} };
  killSignals: NodeJS.Signals[] = [];
  killed = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (typeof signal === "string") {
      this.killSignals.push(signal);
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        this.killed = true;
      }
    }
    return true;
  }

  simulateExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }

  writeStdout(text: string): void {
    this.stdout.emit("data", text);
  }

  writeStderr(text: string): void {
    this.stderr.emit("data", text);
  }
}

type FakeTimer = {
  readonly cb: () => void;
  readonly scheduledAt: number;
  readonly fireAt: number;
  cancelled: boolean;
};

class FakeTimers implements SupervisorTimers {
  private current = 0;
  readonly pending: FakeTimer[] = [];

  now = (): number => this.current;

  setTimeout = (cb: () => void, ms: number) => {
    const timer: FakeTimer = {
      cb,
      scheduledAt: this.current,
      fireAt: this.current + ms,
      cancelled: false,
    };
    this.pending.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  };

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    // Drain timers in monotonic order, advancing the clock as we go.
    // Between each fired callback we flush a generous batch of microtasks
    // so every awaited promise chain inside supervisor.waitForHealth /
    // sleep / fetch settles before we decide whether another timer is due.
    for (let i = 0; i < 10_000; i++) {
      // Flush pending microtasks before inspecting the queue, so any timers
      // scheduled from an earlier callback's .then() become visible.
      for (let j = 0; j < 16; j++) {
        await Promise.resolve();
      }
      const next = this.pending
        .filter((t) => !t.cancelled && t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (!next) break;
      this.current = Math.max(this.current, next.fireAt);
      next.cancelled = true;
      next.cb();
      for (let j = 0; j < 16; j++) {
        await Promise.resolve();
      }
    }
    this.current = target;
    // Final microtask drain so the awaiting test code sees the last resolve.
    for (let j = 0; j < 16; j++) {
      await Promise.resolve();
    }
  }
}

type FakeDeps = SupervisorDeps & {
  readonly timers: FakeTimers;
  readonly spawn: ReturnType<typeof vi.fn>;
  readonly fetch: ReturnType<typeof vi.fn>;
  readonly allocatePort: ReturnType<typeof vi.fn>;
};

function makeDeps(overrides: Partial<{ fetch: HealthFetchFn; spawn: SpawnFn }> = {}): FakeDeps {
  const timers = new FakeTimers();
  const spawn = vi.fn<SpawnFn>();
  const fetchFn = vi.fn<HealthFetchFn>();
  const allocatePort = vi.fn(async () => 34_567);
  return {
    timers,
    spawn: overrides.spawn ? (spawn.mockImplementation(overrides.spawn) as typeof spawn) : spawn,
    fetch: overrides.fetch
      ? (fetchFn.mockImplementation(overrides.fetch) as typeof fetchFn)
      : fetchFn,
    allocatePort,
  } as FakeDeps;
}

const BINARY_RESOLUTION: BackendResolution = {
  kind: "binary",
  executable: "/rt/pixelle-backend",
  manifestPath: "/rt/manifest.json",
  version: "1.0.0",
};

const MISSING_RESOLUTION: BackendResolution = {
  kind: "missing",
  reason: "No Pixelle backend found",
};

function baseCfg(overrides: Partial<SupervisorRuntimeConfig> = {}): SupervisorRuntimeConfig {
  return {
    gatewayBaseUrl: "http://127.0.0.1:18789/v1",
    internalToken: "proc-abc",
    agentId: "openclaw/llm-passthrough",
    defaultModel: "qwen/qwen-max",
    dataRoot: "/home/u/video-studio",
    healthTimeoutMs: 2_000,
    retryScheduleMs: [100, 200, 400],
    autoStopIdleMinutes: 0,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("PixelleBackendSupervisor.startIfNeeded — happy path", () => {
  it("spawns the resolved binary with the documented env vars and waits for /health", async () => {
    const child = new FakeChild(4321);
    const deps = makeDeps({
      spawn: () => child,
      fetch: vi.fn().mockResolvedValue({ ok: true }) as unknown as HealthFetchFn,
    });
    const logs: LogLine[] = [];
    const supervisor = new PixelleBackendSupervisor(
      BINARY_RESOLUTION,
      baseCfg({ onLogLine: (l) => logs.push(l) }),
      deps,
    );

    const start = supervisor.startIfNeeded();
    await deps.timers.advance(500);
    const result = await start;

    expect(deps.allocatePort).toHaveBeenCalled();
    expect(deps.spawn).toHaveBeenCalledWith(
      "/rt/pixelle-backend",
      [],
      expect.objectContaining({ env: expect.any(Object) }),
    );
    const env = deps.spawn.mock.calls[0]![2].env as NodeJS.ProcessEnv;
    expect(env.PIXELLE_EMBEDDED_MODE).toBe("1");
    expect(env.PIXELLE_HOST).toBe("127.0.0.1");
    expect(env.PIXELLE_PORT).toBe("34567");
    expect(env.PIXELLE_LLM_PROVIDER).toBe("openclaw");
    expect(env.PIXELLE_OPENCLAW_TOKEN).toBe("proc-abc");
    expect(env.PIXELLE_OPENCLAW_AGENT).toBe("openclaw/llm-passthrough");
    expect(env.PIXELLE_OPENCLAW_MODEL).toBe("qwen/qwen-max");

    expect(result.port).toBe(34_567);
    expect(result.endpoint).toBe("http://127.0.0.1:34567");

    const status = supervisor.getStatus();
    expect(status.state).toBe("running");

    child.writeStdout("hello from pixelle\n");
    child.writeStderr("warn: foo\nwarn: bar\n");
    expect(logs.map((l) => `${l.stream}:${l.line}`)).toEqual([
      "stdout:hello from pixelle",
      "stderr:warn: foo",
      "stderr:warn: bar",
    ]);
  });
});

describe("PixelleBackendSupervisor.startIfNeeded — health timeout", () => {
  it("throws HealthTimeoutError once the 30s budget elapses without a 200", async () => {
    const child = new FakeChild(1);
    const deps = makeDeps({
      spawn: () => child,
      fetch: vi.fn().mockResolvedValue({ ok: false }) as unknown as HealthFetchFn,
    });
    const supervisor = new PixelleBackendSupervisor(
      BINARY_RESOLUTION,
      baseCfg({ healthTimeoutMs: 400 }),
      deps,
    );

    const p = supervisor.startIfNeeded();
    // Attach a rejection handler synchronously so there is no "unhandled
    // rejection" window while we advance fake time.
    const assertion = expect(p).rejects.toBeInstanceOf(HealthTimeoutError);
    // Advance in small slices so every microtask boundary in the
    // health-poll loop gets a chance to observe the new clock.
    for (let i = 0; i < 20; i++) {
      await deps.timers.advance(500);
    }
    await assertion;

    const status = supervisor.getStatus();
    expect(status.state === "retrying" || status.state === "stopped").toBe(true);
    expect(child.killSignals).toContain("SIGTERM");
  }, 15_000);
});

describe("PixelleBackendSupervisor crash recovery", () => {
  it("retries on exponential backoff and finally lands in `stopped` after exhausting the schedule", async () => {
    const spawned: FakeChild[] = [];
    const deps = makeDeps({
      spawn: () => {
        const c = new FakeChild(100 + spawned.length);
        spawned.push(c);
        // Cause each freshly spawned child to exit on the next tick before
        // the health check ever succeeds.
        queueMicrotask(() => c.simulateExit(1, null));
        return c;
      },
      fetch: vi.fn().mockResolvedValue({ ok: false }) as unknown as HealthFetchFn,
    });
    const events: string[] = [];
    const supervisor = new PixelleBackendSupervisor(
      BINARY_RESOLUTION,
      baseCfg({ retryScheduleMs: [10, 20, 40], healthTimeoutMs: 5 }),
      deps,
    );
    supervisor.on("backend-crashed", () => events.push("crashed"));

    await supervisor.startIfNeeded().catch(() => {
      /* expected */
    });
    // Drain enough fake time to exhaust the entire retry schedule, sliced
    // so the per-attempt microtask chains all have room to settle.
    for (let i = 0; i < 20; i++) {
      await deps.timers.advance(500);
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(supervisor.getStatus().state).toBe("stopped");
  }, 15_000);

  it("throws BackendNotInstalledError when the resolution is `missing`", async () => {
    const deps = makeDeps();
    const supervisor = new PixelleBackendSupervisor(MISSING_RESOLUTION, baseCfg(), deps);
    await expect(supervisor.startIfNeeded()).rejects.toBeInstanceOf(BackendNotInstalledError);
  });
});

describe("PixelleBackendSupervisor.stop — graceful shutdown", () => {
  it("sends SIGTERM first and escalates to SIGKILL after the grace period", async () => {
    const child = new FakeChild(7);
    const deps = makeDeps({
      spawn: () => child,
      fetch: vi.fn().mockResolvedValue({ ok: true }) as unknown as HealthFetchFn,
    });
    const supervisor = new PixelleBackendSupervisor(BINARY_RESOLUTION, baseCfg(), deps);

    const startPromise = supervisor.startIfNeeded();
    await deps.timers.advance(500);
    await startPromise;

    const stopPromise = supervisor.stop("test shutdown");
    // Do not simulate an exit — force the escalation branch.
    await deps.timers.advance(15_000);
    await stopPromise;

    expect(child.killSignals[0]).toBe("SIGTERM");
    expect(child.killSignals).toContain("SIGKILL");
    expect(supervisor.getStatus()).toEqual({ state: "stopped", reason: "test shutdown" });
  });
});
