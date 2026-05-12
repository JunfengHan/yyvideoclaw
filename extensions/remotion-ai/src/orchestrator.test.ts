import { describe, expect, it, vi } from "vitest";
import type { ResolvedRemotionAiConfig } from "./config.js";
import { EngineRegistry } from "./engine/engine-registry.js";
import { JobsStore } from "./jobs-store.js";
import { Orchestrator } from "./orchestrator.js";
import type { JobEvent, Phase } from "./types.js";
import type { ValidationReport } from "./validator/validator.js";

interface FakeEngineCalls {
  runAttempt: Array<{ jobId: string; prompt: string }>;
  retry: Array<{ jobId: string; sessionRef: string; digest: string }>;
  dispose: Array<{ sessionRef: string }>;
}

function makeFakeEngineRegistry(): { registry: EngineRegistry; calls: FakeEngineCalls } {
  const calls: FakeEngineCalls = { runAttempt: [], retry: [], dispose: [] };
  const fakeEngine = {
    id: "codex" as const,
    capabilities: { id: "codex" as const, label: "Fake", supportsRetry: true },
    runAttempt: vi.fn(async (params: { jobId: string; prompt: string }) => {
      calls.runAttempt.push({ jobId: params.jobId, prompt: params.prompt });
      return { sessionRef: "session-fake", assistantText: "" };
    }),
    retry: vi.fn(async (params: { jobId: string; sessionRef: string; digest: string }) => {
      calls.retry.push({
        jobId: params.jobId,
        sessionRef: params.sessionRef,
        digest: params.digest,
      });
      return { sessionRef: params.sessionRef, assistantText: "" };
    }),
    dispose: vi.fn(async (sessionRef: string) => {
      calls.dispose.push({ sessionRef });
    }),
  };
  const registry = {
    resolve: () => fakeEngine,
    clear: () => undefined,
  } as unknown as EngineRegistry;
  return { registry, calls };
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeConfig(): ResolvedRemotionAiConfig {
  return {
    engine: "codex",
    outputRootAllowlist: undefined,
    retryMax: 3,
    jobTimeoutMs: 60_000,
    skillsBundled: false,
    starterDir: "/fake/starter",
    allowNetwork: false,
    chromiumExecutablePath: undefined,
    maxOutputBytes: 10 * 1024 * 1024,
  };
}

function makePrepareWorkspaceStub(workspaceDir: string) {
  return vi.fn(async () => ({
    workspaceDir,
    entryPointRelative: "src/index.ts",
    cacheDir: `${workspaceDir}/.cache`,
    // Empty hash → orchestrator's "agent didn't modify Root.tsx" tripwire
    // is skipped (the check guards against false positives by treating an
    // empty pre-hash as "can't tell"). Tests that specifically want to
    // exercise the tripwire override this with a non-empty value.
    starterRootHash: "",
  }));
}

function makeDisposeWorkspaceStub() {
  return vi.fn(async () => undefined);
}

const noopSleep = async (): Promise<void> => undefined;

/**
 * Default `readAuthConfig` stub for orchestrator tests. Returns a
 * fully-configured `hosted` mode so the auth gate at the top of
 * `runPipeline` doesn't terminate every test with `auth_required`.
 *
 * Tests that specifically want to exercise the auth gate override this
 * by passing their own `readAuthConfig: () => Promise.resolve({...})`.
 */
const makeReadAuthConfigStub = () =>
  vi.fn(async () => ({
    mode: "hosted" as const,
    hostedToken: "fake-token",
    hostedUserEmail: "test@example.com",
    schemaVersion: 1 as const,
  }));

/**
 * Build a `runValidation` mock that returns the given successful report for
 * the still pass and an mp4-shaped success for the subsequent video pass.
 * The orchestrator now requires `outputPath` to end in `.mp4` for the
 * video pass; otherwise it terminates with `failed` to surface the
 * silent-fallback class of bugs (validator forgetting to forward `mode`).
 */
function modeAwareValidation(
  stillReport: ValidationReport,
): typeof import("./validator/validator.js").runValidation {
  return vi.fn(async (options) => {
    if (options.mode === "video" && stillReport.outcome === "success") {
      const mp4 = stillReport.outputPath.replace(/\.[^./]+$/u, "") + ".mp4";
      return {
        ...stillReport,
        outputPath: mp4,
      };
    }
    return stillReport;
  }) as unknown as typeof import("./validator/validator.js").runValidation;
}

describe("Orchestrator", () => {
  it("runs the happy path and ends in phase=done with a still + compositionId snapshot", async () => {
    const { registry, calls } = makeFakeEngineRegistry();
    const jobs = new JobsStore();
    const successfulReport: ValidationReport = {
      outcome: "success",
      compositionId: "Main",
      outputPath: "/ws/jobX/.cache/remotion-ai/validation-still.png",
      sizeBytes: 1024,
      durationMs: 200,
      stages: { bundleMs: 50, selectCompositionMs: 50, renderStillMs: 100 },
    };
    const orchestrator = new Orchestrator({
      config: makeConfig(),
      logger: makeLogger(),
      jobs,
      engines: registry,
      newJobId: () => "job-happy",
      prepareWorkspace: makePrepareWorkspaceStub("/ws/job-happy"),
      disposeWorkspace: makeDisposeWorkspaceStub(),
      sleep: noopSleep,
      readAuthConfig: makeReadAuthConfigStub(),
      runValidation: modeAwareValidation(successfulReport),
    });
    const submitted = orchestrator.submit({
      prompt: "make me a 5s title card",
      outputRoot: "/ws",
    });
    expect(submitted.snapshot.phase).toBe("queued");
    const final = await submitted.waitForCompletion();
    expect(final.phase).toBe("done");
    expect(final.compositionId).toBe("Main");
    expect(final.stillPath).toBe(successfulReport.outputPath);
    expect(final.retryCount).toBe(0);
    expect(calls.runAttempt).toHaveLength(1);
    expect(calls.retry).toHaveLength(0);
    expect(calls.dispose).toHaveLength(1);
  });

  it("retries with the digest, incrementing retryCount, and ends in done on success", async () => {
    const { registry, calls } = makeFakeEngineRegistry();
    const jobs = new JobsStore();
    const reports: ValidationReport[] = [
      {
        outcome: "failure",
        stage: "bundle",
        errorName: "ResolveError",
        errorMessage: "cannot find ./Root",
        digest: "Validation failed at **Bundle**",
        stages: {},
      },
      {
        outcome: "success",
        compositionId: "Main",
        outputPath: "/ws/job-retry/.cache/remotion-ai/validation-still.png",
        sizeBytes: 200,
        durationMs: 50,
        stages: { bundleMs: 10, selectCompositionMs: 10, renderStillMs: 30 },
      },
    ];
    let cursor = 0;
    const orchestrator = new Orchestrator({
      config: makeConfig(),
      logger: makeLogger(),
      jobs,
      engines: registry,
      newJobId: () => "job-retry",
      prepareWorkspace: makePrepareWorkspaceStub("/ws/job-retry"),
      disposeWorkspace: makeDisposeWorkspaceStub(),
      sleep: noopSleep,
      readAuthConfig: makeReadAuthConfigStub(),
      runValidation: vi.fn(async (options) => {
        // The orchestrator now runs an extra `mode: "video"` validation
        // after the still pass succeeds. Tests that only care about retry
        // semantics shouldn't have to enumerate that extra call — reuse
        // the last queued report once the cursor walks off the end, and
        // fix up the extension to .mp4 for video-mode calls so the
        // orchestrator's "must be mp4" guard is satisfied.
        const next = cursor < reports.length ? reports[cursor++] : reports[reports.length - 1];
        if (options.mode === "video" && next && next.outcome === "success") {
          return {
            ...next,
            outputPath: next.outputPath.replace(/\.[^./]+$/u, "") + ".mp4",
          };
        }
        return next;
      }) as unknown as typeof import("./validator/validator.js").runValidation,
    });
    const submitted = orchestrator.submit({
      prompt: "title card",
      outputRoot: "/ws",
    });
    const final = await submitted.waitForCompletion();
    expect(final.phase).toBe("done");
    expect(final.retryCount).toBe(1);
    expect(calls.retry).toHaveLength(1);
    expect(calls.retry[0]?.digest).toContain("Validation failed at **Bundle**");
    expect(calls.dispose).toHaveLength(1);
  });

  it("ends in phase=failed with errorSummary after retryMax retries are exhausted", async () => {
    const { registry, calls } = makeFakeEngineRegistry();
    const jobs = new JobsStore();
    const failure: ValidationReport = {
      outcome: "failure",
      stage: "render_still",
      errorName: "TimeoutError",
      errorMessage: "Chromium hung",
      digest: "Validation failed at **renderStill**",
      stages: { bundleMs: 1, selectCompositionMs: 1 },
    };
    const config = { ...makeConfig(), retryMax: 1 };
    const orchestrator = new Orchestrator({
      config,
      logger: makeLogger(),
      jobs,
      engines: registry,
      newJobId: () => "job-fail",
      prepareWorkspace: makePrepareWorkspaceStub("/ws/job-fail"),
      disposeWorkspace: makeDisposeWorkspaceStub(),
      sleep: noopSleep,
      readAuthConfig: makeReadAuthConfigStub(),
      runValidation: vi.fn(
        async () => failure,
      ) as unknown as typeof import("./validator/validator.js").runValidation,
    });
    const submitted = orchestrator.submit({
      prompt: "title card",
      outputRoot: "/ws",
    });
    const final = await submitted.waitForCompletion();
    expect(final.phase).toBe("failed");
    expect(final.errorSummary).toContain("TimeoutError");
    expect(final.retryCount).toBe(1);
    expect(calls.retry).toHaveLength(1);
    expect(calls.dispose).toHaveLength(1);
  });

  it("emits validation_success and validation_failure events through the JobsStore", async () => {
    const { registry } = makeFakeEngineRegistry();
    const jobs = new JobsStore();
    const events: JobEvent[] = [];
    jobs.subscribeAll((e) => events.push(e));
    const successfulReport: ValidationReport = {
      outcome: "success",
      compositionId: "Main",
      outputPath: "/ws/job/.cache/remotion-ai/validation-still.png",
      sizeBytes: 100,
      durationMs: 100,
      stages: { bundleMs: 50, selectCompositionMs: 25, renderStillMs: 25 },
    };
    const orchestrator = new Orchestrator({
      config: makeConfig(),
      logger: makeLogger(),
      jobs,
      engines: registry,
      newJobId: () => "job-events",
      prepareWorkspace: makePrepareWorkspaceStub("/ws/job-events"),
      disposeWorkspace: makeDisposeWorkspaceStub(),
      sleep: noopSleep,
      readAuthConfig: makeReadAuthConfigStub(),
      runValidation: modeAwareValidation(successfulReport),
    });
    await orchestrator.submit({ prompt: "x", outputRoot: "/ws" }).waitForCompletion();
    const types = events.map((e) => e.type);
    // Phase progression we expect: queued (skipped — no transition emitted for
    // the initial enqueue) → workspace → skills → agent → bundle → still → done.
    expect(types).toContain("validation_success");
    expect(types).toContain("phase");
    const phasesSeen = events
      .filter((e): e is Extract<JobEvent, { type: "phase" }> => e.type === "phase")
      .map((e) => e.phase);
    for (const required of [
      "workspace",
      "skills",
      "agent",
      "bundle",
      "still",
      "done",
    ] satisfies Phase[]) {
      expect(phasesSeen).toContain(required);
    }
  });

  it("cancellation moves the job to phase=cancelled and disposes the engine session", async () => {
    const { registry, calls } = makeFakeEngineRegistry();
    const jobs = new JobsStore();
    let resolveValidation: ((report: ValidationReport) => void) | undefined;
    const validationPromise = new Promise<ValidationReport>((resolve) => {
      resolveValidation = resolve;
    });
    const orchestrator = new Orchestrator({
      config: makeConfig(),
      logger: makeLogger(),
      jobs,
      engines: registry,
      newJobId: () => "job-cancel",
      prepareWorkspace: makePrepareWorkspaceStub("/ws/job-cancel"),
      disposeWorkspace: makeDisposeWorkspaceStub(),
      sleep: noopSleep,
      readAuthConfig: makeReadAuthConfigStub(),
      runValidation: vi.fn(
        async () => validationPromise,
      ) as unknown as typeof import("./validator/validator.js").runValidation,
    });
    const submitted = orchestrator.submit({
      prompt: "x",
      outputRoot: "/ws",
    });
    // Let the pipeline reach the validate step before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cancelled = orchestrator.cancel("job-cancel", "test cancel");
    expect(cancelled).toBe(true);
    // Unblock the validator (it returns now-irrelevant data; orchestrator
    // catches the cancellation in checkCancelled or via the abort signal
    // and terminates with phase=cancelled).
    resolveValidation?.({
      outcome: "failure",
      stage: "bundle",
      errorName: "X",
      errorMessage: "x",
      digest: "x",
      stages: {},
    });
    const final = await submitted.waitForCompletion();
    expect(final.phase).toBe("cancelled");
    expect(calls.dispose).toHaveLength(1);
  });

  it("disposes the workspace on cancel/failure but keeps it on success", async () => {
    const { registry } = makeFakeEngineRegistry();
    const jobs = new JobsStore();
    const dispose = makeDisposeWorkspaceStub();
    const orchestrator = new Orchestrator({
      config: makeConfig(),
      logger: makeLogger(),
      jobs,
      engines: registry,
      newJobId: () => "job-keep",
      prepareWorkspace: makePrepareWorkspaceStub("/ws/job-keep"),
      disposeWorkspace: dispose,
      runValidation: vi.fn(async (options) => ({
        outcome: "success",
        compositionId: "X",
        // Switch extension based on mode so the orchestrator's mp4 guard
        // doesn't trip the success-path assertion.
        outputPath: options.mode === "video" ? "/ws/x.mp4" : "/ws/x.png",
        sizeBytes: 1,
        durationMs: 1,
        stages: { bundleMs: 1, selectCompositionMs: 1, renderStillMs: 1 },
      })) as unknown as typeof import("./validator/validator.js").runValidation,
    });
    await orchestrator.submit({ prompt: "x", outputRoot: "/ws" }).waitForCompletion();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("rejects submit() when auth mode is unset (auth_required)", async () => {
    const { registry } = makeFakeEngineRegistry();
    const jobs = new JobsStore();
    const validatorSpy = vi.fn();
    const orchestrator = new Orchestrator({
      config: makeConfig(),
      logger: makeLogger(),
      jobs,
      engines: registry,
      newJobId: () => "job-no-auth",
      prepareWorkspace: makePrepareWorkspaceStub("/ws/job-no-auth"),
      disposeWorkspace: makeDisposeWorkspaceStub(),
      sleep: noopSleep,
      // Override the auth resolver so the gate trips deterministically
      // regardless of what's on the developer's local disk.
      readAuthConfig: vi.fn(async () => ({ mode: "unset" as const, schemaVersion: 1 as const })),
      runValidation:
        validatorSpy as unknown as typeof import("./validator/validator.js").runValidation,
    });
    const final = await orchestrator
      .submit({ prompt: "anything", outputRoot: "/ws" })
      .waitForCompletion();
    expect(final.phase).toBe("failed");
    expect(final.errorSummary).toMatch(/auth_required/u);
    // Workspace prep / agent / validator must NEVER run when the auth
    // gate trips — those are the expensive steps we are gating.
    expect(validatorSpy).not.toHaveBeenCalled();
  });

  it("forwards OPENAI_BASE_URL + OPENAI_API_KEY to the engine in hosted mode", async () => {
    // Capture the runAttempt call so we can assert the envInjection.
    const runAttemptCalls: Array<Record<string, unknown>> = [];
    const fakeEngine = {
      id: "codex" as const,
      capabilities: { id: "codex" as const, label: "Codex", supportsRetry: true },
      runAttempt: vi.fn(async (params) => {
        runAttemptCalls.push(params);
        return { sessionRef: "sess-1", assistantText: "" };
      }),
      retry: vi.fn(),
      dispose: vi.fn(),
    };
    const registry = {
      resolve: () =>
        fakeEngine as unknown as Parameters<typeof Orchestrator>[0]["engines"]["resolve"],
    };
    const jobs = new JobsStore();
    const successReport: ValidationReport = {
      outcome: "success",
      compositionId: "Main",
      outputPath: "/ws/job-hosted/.cache/remotion-ai/validation-still.png",
      sizeBytes: 1,
      durationMs: 1,
      stages: { bundleMs: 1, selectCompositionMs: 1, renderStillMs: 1 },
    };
    const orchestrator = new Orchestrator({
      config: makeConfig(),
      logger: makeLogger(),
      jobs,
      engines: registry as unknown as Parameters<typeof Orchestrator>[0]["engines"],
      newJobId: () => "job-hosted",
      prepareWorkspace: makePrepareWorkspaceStub("/ws/job-hosted"),
      disposeWorkspace: makeDisposeWorkspaceStub(),
      sleep: noopSleep,
      readAuthConfig: vi.fn(async () => ({
        mode: "hosted" as const,
        hostedToken: "hosted-bearer-xyz",
        hostedUserEmail: "user@test",
        schemaVersion: 1 as const,
      })),
      resolveHostedOpenAiBaseUrl: () => "https://stub.test/api/v1/codex",
      runValidation: modeAwareValidation(successReport),
    });
    await orchestrator.submit({ prompt: "anything", outputRoot: "/ws" }).waitForCompletion();
    expect(fakeEngine.runAttempt).toHaveBeenCalledTimes(1);
    const params = runAttemptCalls[0] as {
      envInjection?: { env: Record<string, string>; clearEnv?: string[] };
    };
    expect(params.envInjection?.env.OPENAI_BASE_URL).toBe("https://stub.test/api/v1/codex");
    expect(params.envInjection?.env.OPENAI_API_KEY).toBe("hosted-bearer-xyz");
    expect(params.envInjection?.clearEnv).toContain("OPENAI_API_KEY");
  });

  it("does NOT inject env in byok mode (codex CLI reads ~/.codex/auth.json itself)", async () => {
    const runAttemptCalls: Array<Record<string, unknown>> = [];
    const fakeEngine = {
      id: "codex" as const,
      capabilities: { id: "codex" as const, label: "Codex", supportsRetry: true },
      runAttempt: vi.fn(async (params) => {
        runAttemptCalls.push(params);
        return { sessionRef: "sess-1", assistantText: "" };
      }),
      retry: vi.fn(),
      dispose: vi.fn(),
    };
    const registry = {
      resolve: () =>
        fakeEngine as unknown as Parameters<typeof Orchestrator>[0]["engines"]["resolve"],
    };
    const successReport: ValidationReport = {
      outcome: "success",
      compositionId: "Main",
      outputPath: "/ws/job-byok/.cache/remotion-ai/validation-still.png",
      sizeBytes: 1,
      durationMs: 1,
      stages: { bundleMs: 1, selectCompositionMs: 1, renderStillMs: 1 },
    };
    const orchestrator = new Orchestrator({
      config: makeConfig(),
      logger: makeLogger(),
      jobs: new JobsStore(),
      engines: registry as unknown as Parameters<typeof Orchestrator>[0]["engines"],
      newJobId: () => "job-byok",
      prepareWorkspace: makePrepareWorkspaceStub("/ws/job-byok"),
      disposeWorkspace: makeDisposeWorkspaceStub(),
      sleep: noopSleep,
      readAuthConfig: vi.fn(async () => ({
        mode: "byok" as const,
        byokConfiguredAt: 1,
        schemaVersion: 1 as const,
      })),
      runValidation: modeAwareValidation(successReport),
    });
    await orchestrator.submit({ prompt: "anything", outputRoot: "/ws" }).waitForCompletion();
    const params = runAttemptCalls[0] as { envInjection?: unknown };
    expect(params.envInjection).toBeUndefined();
  });

  it("does not retry when retryMax is 0", async () => {
    const { registry, calls } = makeFakeEngineRegistry();
    const jobs = new JobsStore();
    const config = { ...makeConfig(), retryMax: 0 };
    const orchestrator = new Orchestrator({
      config,
      logger: makeLogger(),
      jobs,
      engines: registry,
      newJobId: () => "job-no-retry",
      prepareWorkspace: makePrepareWorkspaceStub("/ws/job-no-retry"),
      disposeWorkspace: makeDisposeWorkspaceStub(),
      sleep: noopSleep,
      readAuthConfig: makeReadAuthConfigStub(),
      runValidation: vi.fn(async () => ({
        outcome: "failure",
        stage: "bundle",
        errorName: "X",
        errorMessage: "x",
        digest: "x",
        stages: {},
      })) as unknown as typeof import("./validator/validator.js").runValidation,
    });
    const final = await orchestrator.submit({ prompt: "x", outputRoot: "/ws" }).waitForCompletion();
    expect(final.phase).toBe("failed");
    expect(final.retryCount).toBe(0);
    expect(calls.retry).toHaveLength(0);
  });

  it("fails the job when the agent attempt does not modify src/Root.tsx", async () => {
    // Use a real tmpdir so the orchestrator can hash the file; rig the
    // stub to advertise a non-empty pre-hash that matches the post-hash
    // (because the fake engine doesn't write anything). The validator
    // should NEVER be invoked — the tripwire must short-circuit before.
    const { promises: fsp } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createHash } = await import("node:crypto");
    const tmpRoot = await fsp.mkdtemp(join(tmpdir(), "tripwire-"));
    const wsDir = join(tmpRoot, "job-tripwire");
    await fsp.mkdir(join(wsDir, "src"), { recursive: true });
    const rootSrc = "// the real starter contents";
    await fsp.writeFile(join(wsDir, "src", "Root.tsx"), rootSrc);
    const expectedHash = createHash("sha256").update(rootSrc).digest("hex");

    const { registry } = makeFakeEngineRegistry();
    const jobs = new JobsStore();
    const validatorSpy = vi.fn();
    try {
      const orchestrator = new Orchestrator({
        config: makeConfig(),
        logger: makeLogger(),
        jobs,
        engines: registry,
        newJobId: () => "job-tripwire",
        prepareWorkspace: vi.fn(async () => ({
          workspaceDir: wsDir,
          entryPointRelative: "src/index.ts",
          cacheDir: join(wsDir, ".cache"),
          starterRootHash: expectedHash,
        })),
        disposeWorkspace: makeDisposeWorkspaceStub(),
        sleep: noopSleep,
        readAuthConfig: makeReadAuthConfigStub(),
        runValidation:
          validatorSpy as unknown as typeof import("./validator/validator.js").runValidation,
      });
      const final = await orchestrator
        .submit({ prompt: "build me a video", outputRoot: tmpRoot })
        .waitForCompletion();
      expect(final.phase).toBe("failed");
      expect(final.errorSummary).toMatch(/did not modify src\/Root\.tsx/u);
      // Critical: the validator must not be invoked when the tripwire
      // catches an unchanged starter — we'd otherwise burn 5+ minutes
      // bundling and rendering a placeholder video.
      expect(validatorSpy).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
