import { describe, expect, test, vi } from "vitest";
import {
  buildDetachedComfyUiStartCommand,
  ensureComfyUi,
  type EnsureComfyUiParams,
} from "./remote-comfyui-ensure.js";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("buildDetachedComfyUiStartCommand", () => {
  test("uses screen when available and falls back to nohup", () => {
    const cmd = buildDetachedComfyUiStartCommand(6006);
    expect(cmd).toContain("if command -v screen >/dev/null 2>&1; then");
    expect(cmd).toContain("screen -dmS yyvideo-comfyui bash -lc");
    expect(cmd).toContain("nohup bash -lc");
    expect(cmd).toContain("/tmp/yyvideo-comfyui.log");
  });

  test("clamps the service port to a sane range", () => {
    const cmd = buildDetachedComfyUiStartCommand(70_000);
    expect(cmd).toContain("--port 65535");
    const fallback = buildDetachedComfyUiStartCommand(Number.NaN);
    expect(fallback).toContain("--port 6006");
  });

  test("escapes the cwd and CORS argument so they cannot break out", () => {
    const cmd = buildDetachedComfyUiStartCommand(6006);
    // shellQuote nests outer single quotes; ensure the cwd literal still
    // appears verbatim and that the CORS '*' is wrapped so it cannot
    // glob-expand or break out of the bash -lc payload.
    expect(cmd).toContain("/root/autodl-tmp/ComfyUI");
    expect(cmd).not.toContain("rm -rf /");
    expect(cmd).toMatch(/--enable-cors-header [^*]*\*/);
  });
});

describe("ensureComfyUi", () => {
  const baseParams = (
    overrides: Partial<EnsureComfyUiParams> & {
      healthCheck: NonNullable<EnsureComfyUiParams["healthCheck"]>;
    },
  ): EnsureComfyUiParams => ({
    localPort: 12345,
    servicePort: 6006,
    writePty: vi.fn(),
    pollIntervalMs: 5,
    startupTimeoutMs: 200,
    commandStartDelayMs: 0,
    ...overrides,
  });

  test("reports already running and skips the launch command when health check passes", async () => {
    const writePty = vi.fn();
    const onStatus = vi.fn();
    const healthCheck = vi.fn().mockResolvedValue(true);
    const result = await ensureComfyUi(baseParams({ writePty, onStatus, healthCheck }));
    expect(result).toEqual({
      ok: true,
      alreadyRunning: true,
      healthUrl: "http://127.0.0.1:12345/system_stats",
    });
    expect(writePty).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith("checking", expect.any(String));
    expect(onStatus).toHaveBeenCalledWith("ready", expect.any(String));
  });

  test("launches ComfyUI when the first probe fails and reports ready when it becomes healthy", async () => {
    const writePty = vi.fn();
    const onStatus = vi.fn();
    let calls = 0;
    const healthCheck = vi.fn().mockImplementation(async () => {
      calls += 1;
      return calls >= 3;
    });
    const result = await ensureComfyUi(baseParams({ writePty, onStatus, healthCheck }));
    expect(result).toMatchObject({ ok: true, alreadyRunning: false });
    expect(writePty).toHaveBeenCalledTimes(1);
    const written = writePty.mock.calls[0][0] as string;
    expect(written).toContain("screen -dmS yyvideo-comfyui");
    expect(written.endsWith("\r")).toBe(true);
    const phases = onStatus.mock.calls.map((call) => call[0]);
    expect(phases).toContain("starting");
    expect(phases).toContain("waiting");
    expect(phases).toContain("ready");
  });

  test("returns a structured failure when ComfyUI never becomes healthy", async () => {
    const writePty = vi.fn();
    const onStatus = vi.fn();
    const healthCheck = vi.fn().mockResolvedValue(false);
    const result = await ensureComfyUi(
      baseParams({
        writePty,
        onStatus,
        healthCheck,
        pollIntervalMs: 5,
        startupTimeoutMs: 30,
      }),
    );
    expect(result).toMatchObject({ ok: false, phase: "waiting" });
    expect(onStatus).toHaveBeenCalledWith("failed", expect.any(String));
  });

  test("aborts the wait loop when the signal fires", async () => {
    const controller = new AbortController();
    const released = createDeferred<boolean>();
    const healthCheck = vi.fn().mockImplementation(async () => {
      released.resolve(true);
      return false;
    });
    const promise = ensureComfyUi(
      baseParams({
        signal: controller.signal,
        healthCheck,
        startupTimeoutMs: 5_000,
        pollIntervalMs: 50,
      }),
    );
    await released.promise;
    controller.abort();
    const result = await promise;
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(["checking", "starting", "waiting"]).toContain(result.phase);
    }
  });
});
