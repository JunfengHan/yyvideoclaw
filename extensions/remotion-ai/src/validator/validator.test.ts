import { describe, expect, it } from "vitest";
import type { AiRenderWorkerInput, AiRenderWorkerMessage } from "./types.js";
import { runValidation } from "./validator.js";

describe("runValidation", () => {
  const baseOptions = {
    workspaceDir: "/tmp/ws",
    allowNetwork: false,
    maxOutputBytes: 10 * 1024 * 1024,
    jobTimeoutMs: 60_000,
    attemptIndex: 0,
    retryMax: 3,
  };

  it("projects validation-success into a structured success report", async () => {
    const seen: AiRenderWorkerInput[] = [];
    const report = await runValidation({
      ...baseOptions,
      spawn: async (input) => {
        seen.push(input);
        return {
          kind: "validation-success",
          compositionId: "Main",
          outputPath: "/tmp/ws/.cache/remotion-ai/validation-still.png",
          sizeBytes: 1234,
          durationMs: 250,
          stages: { bundleMs: 100, selectCompositionMs: 50, renderStillMs: 100 },
        } satisfies AiRenderWorkerMessage;
      },
    });
    expect(report.outcome).toBe("success");
    if (report.outcome !== "success") {
      throw new Error("unreachable");
    }
    expect(report.compositionId).toBe("Main");
    expect(report.sizeBytes).toBe(1234);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.entryPointRelative).toBe("src/index.ts");
    expect(seen[0]?.workspaceDir).toBe("/tmp/ws");
  });

  it("projects validation-failure into a failure report with a Markdown digest", async () => {
    const report = await runValidation({
      ...baseOptions,
      spawn: async () => ({
        kind: "validation-failure",
        stage: "bundle",
        errorName: "ModuleNotFoundError",
        errorMessage: "Cannot find module './Root'",
        errorPreview: 'at Module._resolveFilename "/tmp/ws/src/index.ts:3:1"',
        stages: {},
      }),
    });
    expect(report.outcome).toBe("failure");
    if (report.outcome !== "failure") {
      throw new Error("unreachable");
    }
    expect(report.stage).toBe("bundle");
    expect(report.errorName).toBe("ModuleNotFoundError");
    expect(report.digest).toContain("Validation failed at **Bundle**");
    expect(report.digest).toContain("ModuleNotFoundError");
    // The digest must NOT leak the workspace prefix.
    expect(report.digest).not.toContain("/tmp/ws");
  });

  it("treats worker-error as a synthetic bundle-stage failure", async () => {
    const report = await runValidation({
      ...baseOptions,
      spawn: async () => ({
        kind: "worker-error",
        message: "child process killed by SIGSEGV",
      }),
    });
    expect(report.outcome).toBe("failure");
    if (report.outcome !== "failure") {
      throw new Error("unreachable");
    }
    expect(report.stage).toBe("bundle");
    expect(report.errorMessage).toContain("SIGSEGV");
  });

  it("respects custom entryPointRelative / cacheDir / outputPath overrides", async () => {
    let observed: AiRenderWorkerInput | undefined;
    await runValidation({
      ...baseOptions,
      entryPointRelative: "remotion/index.ts",
      cacheDir: "/tmp/ws/.cache/custom",
      outputPath: "/tmp/ws/build/still.png",
      spawn: async (input) => {
        observed = input;
        return {
          kind: "validation-success",
          compositionId: "X",
          outputPath: input.outputPath,
          sizeBytes: 1,
          durationMs: 1,
          stages: { bundleMs: 1, selectCompositionMs: 1, renderStillMs: 1 },
        } satisfies AiRenderWorkerMessage;
      },
    });
    expect(observed?.entryPointRelative).toBe("remotion/index.ts");
    expect(observed?.cacheDir).toBe("/tmp/ws/.cache/custom");
    expect(observed?.outputPath).toBe("/tmp/ws/build/still.png");
  });
});
