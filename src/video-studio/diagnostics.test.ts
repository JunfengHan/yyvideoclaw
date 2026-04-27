import { describe, expect, it } from "vitest";
import { redact, VideoStudioDiagnostics, type DiagnosticsBundle } from "./diagnostics.js";
import type { LogLine } from "./process-manager.js";

// ---------------------------------------------------------------------------
// redact()
// ---------------------------------------------------------------------------

describe("redact", () => {
  it("replaces each registered secret with [REDACTED]", () => {
    expect(redact("token proc-abcdef in trace", ["proc-abcdef"])).toBe("token [REDACTED] in trace");
  });

  it("ignores secrets shorter than 4 chars to prevent noise", () => {
    expect(redact("abc def ghi", ["abc"])).toBe("abc def ghi");
  });

  it("always scrubs Authorization: Bearer headers regardless of secret list", () => {
    expect(redact("Authorization: Bearer eyJ.very.secret", [])).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  it("is case-insensitive for the bearer header scrub", () => {
    expect(redact("authorization: bearer topsecret", [])).toBe("authorization: bearer [REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// VideoStudioDiagnostics
// ---------------------------------------------------------------------------

describe("VideoStudioDiagnostics.onLog", () => {
  it("redacts every registered secret before storing the line", () => {
    const diag = new VideoStudioDiagnostics({
      secrets: ["proc-abcdef"],
      now: () => new Date("2026-04-27T00:00:00.000Z"),
    });
    diag.onLog({ stream: "stderr", line: "received proc-abcdef and replied" });
    const bundle = diag.snapshot();
    expect(bundle.recentLogs[0]?.line).toBe("received [REDACTED] and replied");
  });

  it("respects the log ring size cap (oldest entries drop)", () => {
    const diag = new VideoStudioDiagnostics({ logRingSize: 3 });
    for (let i = 0; i < 5; i++) {
      diag.onLog({ stream: "stdout", line: `line-${i}` });
    }
    const lines = diag.snapshot().recentLogs.map((l) => l.line);
    expect(lines).toEqual(["line-2", "line-3", "line-4"]);
  });

  it("getErrorTail caps to errorTailLines regardless of ring size", () => {
    const diag = new VideoStudioDiagnostics({ logRingSize: 500, errorTailLines: 3 });
    for (let i = 0; i < 10; i++) diag.onLog({ stream: "stderr", line: `err-${i}` });
    const tail = diag.getErrorTail().map((l) => l.line);
    expect(tail).toEqual(["err-7", "err-8", "err-9"]);
  });
});

describe("VideoStudioDiagnostics.onLlmCall", () => {
  it("caps the call ring at 20 by default (requirements §9.3)", () => {
    const diag = new VideoStudioDiagnostics();
    for (let i = 0; i < 25; i++) {
      diag.onLlmCall({
        model: "qwen/qwen-max",
        promptTokens: i,
        completionTokens: i,
        latencyMs: i,
      });
    }
    const calls = diag.snapshot().recentLlmCalls;
    expect(calls).toHaveLength(20);
    expect(calls[0]?.promptTokens).toBe(5);
    expect(calls[19]?.promptTokens).toBe(24);
  });

  it("only stores model/token/latency (no prompt bodies)", () => {
    const diag = new VideoStudioDiagnostics();
    diag.onLlmCall({ model: "m", promptTokens: 1, completionTokens: 2, latencyMs: 3 });
    const call = diag.snapshot().recentLlmCalls[0];
    expect(Object.keys(call ?? {}).sort()).toEqual([
      "at",
      "completionTokens",
      "latencyMs",
      "model",
      "promptTokens",
    ]);
  });
});

describe("VideoStudioDiagnostics.onStatus", () => {
  it("captures pid/port/command from `running` status and clears on stop", () => {
    const diag = new VideoStudioDiagnostics();
    diag.onStatus({
      state: "running",
      pid: 4321,
      port: 34_567,
      startedAt: new Date(),
      command: "/rt/pixelle-backend",
    });
    const running = diag.snapshot();
    expect(running.pid).toBe(4321);
    expect(running.port).toBe(34_567);
    expect(running.startCommand).toBe("/rt/pixelle-backend");

    diag.onStatus({ state: "stopped", reason: "test" });
    const stopped = diag.snapshot();
    expect(stopped.pid).toBeNull();
    expect(stopped.port).toBeNull();
  });
});

describe("VideoStudioDiagnostics.snapshot header", () => {
  it("includes appInfo (videoStudioVersion + pixelleCommit) for bug-report bundles", () => {
    const diag = new VideoStudioDiagnostics({
      appInfo: { videoStudioVersion: "1.0.0", pixelleCommit: "deadbee" },
    });
    const bundle: DiagnosticsBundle = diag.snapshot();
    expect(bundle.appInfo).toEqual({ videoStudioVersion: "1.0.0", pixelleCommit: "deadbee" });
  });
});

describe("VideoStudioDiagnostics secret registry", () => {
  it("registerSecret/forgetSecret change future log redaction", () => {
    const diag = new VideoStudioDiagnostics();
    diag.registerSecret("proc-abcdef");
    diag.onLog({ stream: "stdout", line: "hello proc-abcdef world" } satisfies LogLine);
    expect(diag.snapshot().recentLogs[0]?.line).toBe("hello [REDACTED] world");

    diag.forgetSecret("proc-abcdef");
    diag.onLog({ stream: "stdout", line: "round 2 proc-abcdef" });
    const second = diag.snapshot().recentLogs[1];
    expect(second?.line).toBe("round 2 proc-abcdef");
  });
});
