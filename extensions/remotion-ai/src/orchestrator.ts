// extensions/remotion-ai/src/orchestrator.ts
//
// Drives a Remotion AI Create job from `queued` to a terminal phase.
//
// Pipeline:
//
//     queued
//        │  prepareWorkspace
//        ▼
//     workspace
//        │  injectRemotionSkills (best effort)
//        ▼
//     skills
//        │  engine.runAttempt
//        ▼
//     agent  ───────────┐
//        │              │ ← retry loop with engine.retry(digest)
//        │  validator   │
//        ▼              │
//     bundle/select/still
//        │              │
//        │  retry?  ────┘
//        ▼
//     done | failed | cancelled
//
// All non-fatal failures (validation failures within `retryMax`) keep the
// underlying agent session alive via `engine.retry`. Final cleanup
// (engine.dispose, optional workspace cleanup) runs in a `finally` so
// cancellations and crashes still release the resources.

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { AuthBackend } from "./auth-backend.js";
import { readAuthConfig, type AuthConfig } from "./auth-config.js";
import { readOpenRouterKey } from "./byok-store.js";
import type { ResolvedRemotionAiConfig } from "./config.js";
import type { EngineRegistry } from "./engine/engine-registry.js";
import type { JobsStore } from "./jobs-store.js";
import {
  logJobFinish,
  logJobPhase,
  logJobRetry,
  logJobStart,
  logJobValidation,
} from "./logging.js";
import { injectRemotionSkills } from "./skills-vendor.js";
import type { EngineId, JobSnapshot, JobSpec, Phase } from "./types.js";
import { runValidation, type ValidationReport } from "./validator/validator.js";
import {
  disposeWorkspace,
  hashFileQuiet,
  prepareWorkspace,
  writeVideoPathToSidecar,
} from "./workspace.js";

export interface OrchestratorDeps {
  readonly config: ResolvedRemotionAiConfig;
  readonly logger: PluginLogger;
  readonly jobs: JobsStore;
  readonly engines: EngineRegistry;
  /** Test seam: bypass the real validator. */
  readonly runValidation?: typeof runValidation;
  /** Test seam: bypass workspace prepare/dispose. */
  readonly prepareWorkspace?: typeof prepareWorkspace;
  readonly disposeWorkspace?: typeof disposeWorkspace;
  readonly injectRemotionSkills?: typeof injectRemotionSkills;
  /** Test seam: deterministic jobId generator. */
  readonly newJobId?: () => string;
  /** Test seam: deterministic timing. */
  readonly now?: () => number;
  /** Test seam: skip the exponential retry backoff. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * Test seam: resolve the user's AI auth config (hosted vs byok). Tests
   * pass a stubbed function that returns a fixed mode; production reads
   * `~/.openclaw/remotion-ai/auth.json`. When omitted the default reader
   * is used.
   */
  readonly readAuthConfig?: () => Promise<AuthConfig>;
  /**
   * Test seam: best-effort cleanup of stale `[model_providers.openrouter]`
   * blocks in `~/.codex/config.toml`. Production binds the real
   * `removeOpenRouterConfig`. Tests default to a noop so they don't
   * touch the developer's real codex config and so the await-sequence
   * isn't shifted around.
   */
  readonly removeOpenRouterConfig?: () => Promise<void>;
  /**
   * Test seam: resolve the OPENAI_BASE_URL the codex CLI should hit when
   * the user is in `hosted` mode. Production injects the yyvideoclaw
   * backend URL; tests use `https://example.test/api/v1/codex`.
   */
  readonly resolveHostedOpenAiBaseUrl?: () => string;
}

export interface SubmitJobOptions {
  readonly prompt: string;
  /**
   * Absolute output directory for the new workspace. Optional — when
   * omitted, the orchestrator falls back to `config.defaultOutputRoot`
   * (the managed library root). UIs are expected to omit this in the
   * common case so users don't need to pick a path.
   */
  readonly outputRoot?: string;
  readonly engine?: EngineId;
  readonly retryMax?: number;
  readonly jobTimeoutMs?: number;
  readonly allowNetwork?: boolean;
}

export interface SubmittedJob {
  readonly snapshot: JobSnapshot;
  readonly waitForCompletion: () => Promise<JobSnapshot>;
}

export class Orchestrator {
  private readonly runs = new Map<string, OrchestratorRun>();
  private readonly newJobId: () => string;

  constructor(private readonly deps: OrchestratorDeps) {
    this.newJobId = deps.newJobId ?? (() => randomUUID());
  }

  /**
   * Validate + register a new job and start the pipeline. Returns the
   * initial snapshot synchronously plus a `waitForCompletion` promise that
   * the HTTP route can ignore — the route returns `202` immediately and
   * SSE/polling carries the rest.
   */
  submit(options: SubmitJobOptions): SubmittedJob {
    const cfg = this.deps.config;
    const spec: JobSpec = {
      jobId: this.newJobId(),
      prompt: options.prompt,
      outputRoot: options.outputRoot ?? cfg.defaultOutputRoot,
      engine: options.engine ?? cfg.engine,
      retryMax: options.retryMax ?? cfg.retryMax,
      jobTimeoutMs: options.jobTimeoutMs ?? cfg.jobTimeoutMs,
      allowNetwork: options.allowNetwork ?? cfg.allowNetwork,
    };

    const promptPreview = buildPromptPreview(spec.prompt);
    const initialSnapshot = this.deps.jobs.enqueue({
      jobId: spec.jobId,
      engine: spec.engine,
      workspaceDir: "",
      promptPreview,
    });
    logJobStart(this.deps.logger, {
      jobId: spec.jobId,
      engine: spec.engine,
      workspaceDir: "",
    });

    const run = new OrchestratorRun(spec, this.deps);
    this.runs.set(spec.jobId, run);
    const completion = run
      .runPipeline()
      .catch((error) => {
        // The run already projected this into the jobs store / SSE; we
        // swallow here so an unhandled rejection doesn't surface.
        const detail = error instanceof Error ? error.message : String(error);
        this.deps.logger.warn(
          `remotion-ai pipeline crash jobId=${spec.jobId} error=${JSON.stringify(detail)}`,
        );
      })
      .finally(() => {
        this.runs.delete(spec.jobId);
      });
    return {
      snapshot: initialSnapshot,
      waitForCompletion: async () => {
        await completion;
        return this.deps.jobs.get(spec.jobId) ?? initialSnapshot;
      },
    };
  }

  /** Cancel an in-flight job. Idempotent. */
  cancel(jobId: string, reason = "cancelled by user"): boolean {
    const run = this.runs.get(jobId);
    if (!run) {
      return false;
    }
    run.cancel(reason);
    return true;
  }
}

/**
 * Trim + truncate the user's prompt to at most 160 chars so it's safe to
 * stash in the snapshot without bloating SSE / HTTP responses. The full
 * prompt lives in `<workspaceDir>/.remotion-ai/job.json` on disk.
 */
function buildPromptPreview(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/gu, " ");
  if (trimmed.length <= 160) {
    return trimmed;
  }
  return `${trimmed.slice(0, 157)}…`;
}

class OrchestratorRun {
  private readonly abortController = new AbortController();
  private cancelled = false;
  private workspaceDir: string | undefined;
  private sessionRef: string | undefined;
  private retryCount = 0;
  private readonly startedAt: number;
  private readonly now: () => number;

  constructor(
    private readonly spec: JobSpec,
    private readonly deps: OrchestratorDeps,
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  cancel(reason: string): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    this.abortController.abort(reason);
  }

  async runPipeline(): Promise<void> {
    try {
      // Resolve the user's AI auth choice BEFORE we spend anything on
      // workspace / skills / agent. This lets us reject "no mode chosen"
      // jobs immediately with a structured error the UI knows how to
      // turn into the "Choose your AI" modal.
      const authConfig = await (this.deps.readAuthConfig ?? readAuthConfig)();
      if (authConfig.mode === "unset") {
        await this.terminate(
          "failed",
          "auth_required: choose how this job should reach the AI model. Open the Remotion Studio AI Create panel and pick either the hosted yyvideoclaw service or your own OpenAI key.",
        );
        return;
      }
      if (authConfig.mode === "hosted" && !authConfig.hostedToken) {
        await this.terminate(
          "failed",
          "auth_required: hosted mode is selected but no session token is stored. Sign in again from the AI Create panel.",
        );
        return;
      }

      // Self-heal: older yyvideoclaw builds (≤ this commit) wrote
      // `[model_providers.openrouter] wire_api = "chat"` into
      // ~/.codex/config.toml. Recent codex CLI builds reject that with
      // "wire_api = \"chat\" is no longer supported", which kills every
      // job before turn 1. If the active mode isn't OpenRouter BYOK, we
      // know that block is stale and can drop it. (OpenRouter BYOK is
      // currently disabled in the UI, so this branch effectively always
      // runs in production.) See openai/codex discussions/7782.
      //
      // Note: this hook is a `deps`-injected seam — production wires it
      // to the real `removeOpenRouterConfig`; tests default to `undefined`
      // (= noop) so they don't touch the developer's real ~/.codex.
      if (
        this.deps.removeOpenRouterConfig &&
        !(authConfig.mode === "byok" && authConfig.byokProvider === "openrouter")
      ) {
        try {
          await this.deps.removeOpenRouterConfig();
        } catch (err) {
          // Non-fatal: the codex CLI surfaces the underlying parse
          // error if the cleanup fails. Log so we can spot a perms /
          // path issue without hiding the symptom.
          this.deps.logger.warn(
            `remotion-ai removeOpenRouterConfig failed jobId=${this.spec.jobId} err=${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      await this.advancePhase("workspace");
      const workspace = await (this.deps.prepareWorkspace ?? prepareWorkspace)({
        jobId: this.spec.jobId,
        outputRoot: this.spec.outputRoot,
        outputRootAllowlist: this.deps.config.outputRootAllowlist,
        defaultOutputRoot: this.deps.config.defaultOutputRoot,
        starterDir: this.resolveStarterDir(),
        prompt: this.spec.prompt,
        engine: this.spec.engine,
        createdAt: this.startedAt,
      });
      this.workspaceDir = workspace.workspaceDir;
      this.deps.jobs.update(this.spec.jobId, { workspaceDir: workspace.workspaceDir });
      this.checkCancelled();

      await this.advancePhase("skills");
      if (this.deps.config.skillsBundled) {
        const result = await (this.deps.injectRemotionSkills ?? injectRemotionSkills)({
          starterDir: this.resolveStarterDir(),
          workspaceDir: workspace.workspaceDir,
        });
        if (!result.injected) {
          this.deps.logger.info(
            `remotion-ai skills not injected jobId=${this.spec.jobId} reason=${JSON.stringify(result.reason)}`,
          );
        }
      }
      this.checkCancelled();

      await this.advancePhase("agent");
      const engine = this.deps.engines.resolve(this.spec.engine);
      // Build env injection for the codex child:
      //   - hosted: route the OpenAI SDK through our proxy URL with the
      //     user's session token as the bearer. clearEnv strips a stray
      //     OPENAI_API_KEY from the operator's shell so our hosted
      //     token wins regardless of the gateway's own environment.
      //   - byok + openai: don't inject anything; the codex CLI reads
      //     ~/.codex/auth.json which we already wrote.
      //   - byok + openrouter: inject OPENROUTER_API_KEY from the sidecar
      //     so codex's `[model_providers.openrouter] env_key = ...`
      //     resolves at spawn time. We never put the key in
      //     ~/.codex/auth.json (codex would mistake it for an OpenAI key
      //     and try to call /v1/responses on OpenRouter's server, which
      //     would 404).
      const envInjection = await this.buildEnvInjection(authConfig);
      const attempt = await engine.runAttempt({
        jobId: this.spec.jobId,
        workspaceDir: workspace.workspaceDir,
        prompt: this.spec.prompt,
        allowNetwork: this.spec.allowNetwork,
        jobTimeoutMs: this.spec.jobTimeoutMs,
        abortSignal: this.abortController.signal,
        onEvent: (event) => this.deps.jobs.emit(event),
        ...(envInjection ? { envInjection } : {}),
      });
      this.sessionRef = attempt.sessionRef;
      this.checkCancelled();

      // Tripwire: did the agent ACTUALLY modify the starter? If the codex
      // turn finished `completed` but the model didn't call any write
      // tool, the workspace is byte-identical to the starter — bundling
      // and rendering will "succeed" but the user gets the placeholder
      // "Replace me with your video" card instead of their content.
      // Detect this BEFORE we waste minutes on render passes.
      if (workspace.starterRootHash) {
        const postAttemptHash = await hashFileQuiet(
          path.join(workspace.workspaceDir, "src", "Root.tsx"),
        );
        if (postAttemptHash && postAttemptHash === workspace.starterRootHash) {
          await this.terminate(
            "failed",
            "agent attempt completed but did not modify src/Root.tsx; the starter template is unchanged. This usually means the codex model returned text without calling apply_patch — check that the codex auth profile and model are configured correctly.",
          );
          return;
        }
      }

      let finalReport: ValidationReport | undefined;
      for (let attemptIndex = 0; attemptIndex <= this.spec.retryMax; attemptIndex += 1) {
        await this.advancePhase("bundle");
        const report = await (this.deps.runValidation ?? runValidation)({
          workspaceDir: workspace.workspaceDir,
          allowNetwork: this.spec.allowNetwork,
          ...(this.deps.config.chromiumExecutablePath
            ? { chromiumExecutablePath: this.deps.config.chromiumExecutablePath }
            : {}),
          maxOutputBytes: this.deps.config.maxOutputBytes,
          jobTimeoutMs: this.spec.jobTimeoutMs,
          attemptIndex,
          retryMax: this.spec.retryMax,
          abortSignal: this.abortController.signal,
        });
        finalReport = report;
        if (report.outcome === "success") {
          await this.advancePhase("still");
          logJobValidation(this.deps.logger, {
            jobId: this.spec.jobId,
            stage: "render_still",
            success: true,
            stages: report.stages,
          });
          this.deps.jobs.emit({
            type: "validation_success",
            jobId: this.spec.jobId,
            compositionId: report.compositionId,
            stillPath: report.outputPath,
            stages: report.stages,
            at: this.now(),
          });
          this.deps.jobs.update(this.spec.jobId, {
            compositionId: report.compositionId,
            stillPath: report.outputPath,
          });
          break;
        }
        // Map the failing stage to a UI-visible phase for the ProgressBar.
        const failedPhase: Phase =
          report.stage === "bundle"
            ? "bundle"
            : report.stage === "select_composition"
              ? "select"
              : "still";
        await this.advancePhase(failedPhase);
        logJobValidation(this.deps.logger, {
          jobId: this.spec.jobId,
          stage: report.stage,
          success: false,
          stages: report.stages,
        });
        const retriesLeft = this.spec.retryMax - attemptIndex;
        this.deps.jobs.emit({
          type: "validation_failure",
          jobId: this.spec.jobId,
          stage: report.stage,
          errorName: report.errorName,
          errorMessage: report.errorMessage,
          retriesLeft,
          at: this.now(),
        });
        if (retriesLeft <= 0) {
          break;
        }

        // Retry: re-prompt the agent with the digest. Keep the same
        // sessionRef so the model preserves its conversation state.
        await this.advancePhase("retry");
        this.retryCount += 1;
        this.deps.jobs.update(this.spec.jobId, { retryCount: this.retryCount });
        logJobRetry(this.deps.logger, {
          jobId: this.spec.jobId,
          attempt: attemptIndex + 1,
          retriesLeft,
          stage: report.stage,
        });
        await this.applyBackoff(attemptIndex);
        this.checkCancelled();
        await this.advancePhase("agent");
        if (!this.sessionRef) {
          throw new Error("orchestrator: lost sessionRef before retry");
        }
        await engine.retry({
          jobId: this.spec.jobId,
          sessionRef: this.sessionRef,
          digest: report.digest,
          abortSignal: this.abortController.signal,
          onEvent: (event) => this.deps.jobs.emit(event),
        });
        this.checkCancelled();
      }

      if (!finalReport || finalReport.outcome !== "success") {
        const summary = finalReport
          ? `${finalReport.errorName}: ${finalReport.errorMessage}`
          : "validation never produced a report";
        await this.terminate("failed", summary);
        return;
      }
      // Still validation passed → produce the user-facing mp4. We stay
      // in the `still` phase visually because (a) we don't want to grow
      // the public Phase enum mid-M1, (b) `renderMedia` reuses the
      // bundler cache so it's typically seconds, and (c) failure here
      // shouldn't claim "the AI created broken code" — the still already
      // proved that wrong. We tag any failure here with stage="render_video"
      // so the failure message is unambiguous.
      try {
        const videoReport = await (this.deps.runValidation ?? runValidation)({
          workspaceDir: workspace.workspaceDir,
          allowNetwork: this.spec.allowNetwork,
          ...(this.deps.config.chromiumExecutablePath
            ? { chromiumExecutablePath: this.deps.config.chromiumExecutablePath }
            : {}),
          // The mp4 is the deliverable, not a sandbox check — give it a
          // bigger byte budget than the still PNG. We cap at 512 MiB to
          // bound disk usage; longer videos should still fit in this
          // for typical 1080p / 30fps / sub-minute remotion outputs.
          maxOutputBytes: Math.max(this.deps.config.maxOutputBytes, 512 * 1024 * 1024),
          jobTimeoutMs: this.spec.jobTimeoutMs,
          attemptIndex: 0,
          retryMax: 0,
          abortSignal: this.abortController.signal,
          mode: "video",
          ...(finalReport.compositionId ? { compositionId: finalReport.compositionId } : {}),
        });
        if (videoReport.outcome !== "success") {
          await this.terminate(
            "failed",
            `video render failed at ${videoReport.stage}: ${videoReport.errorName}: ${videoReport.errorMessage}`,
          );
          return;
        }
        // Sanity: in `mode: "video"` the worker must return an mp4 path.
        // If we get a non-mp4 back something silently fell through to the
        // still path (historically: validator.ts forgot to forward mode),
        // and we'd write a PNG into sidecar.videoOutputPath — which would
        // then 404 from /library/:id/output.mp4. Fail loud instead.
        if (!/\.mp4$/iu.test(videoReport.outputPath)) {
          await this.terminate(
            "failed",
            `video render produced an unexpected output path "${videoReport.outputPath}" (expected .mp4); the validator likely did not run in video mode`,
          );
          return;
        }
        // Persist the mp4 path on the snapshot so the UI / library route
        // can find it later. We deliberately store the absolute path; the
        // route handler will turn it into a streaming URL.
        this.deps.jobs.update(this.spec.jobId, {
          videoOutputPath: videoReport.outputPath,
        });
        // Also write it back into the sidecar so the Library scan picks
        // it up across gateway restarts.
        try {
          await writeVideoPathToSidecar(workspace.workspaceDir, videoReport.outputPath);
        } catch (err) {
          this.deps.logger.warn(
            `remotion-ai: failed to persist videoOutputPath in sidecar jobId=${this.spec.jobId} error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
          );
        }
      } catch (error) {
        await this.terminate("failed", `video render crashed: ${this.summarizeError(error)}`);
        return;
      }
      await this.terminate("done");
    } catch (error) {
      if (this.cancelled) {
        await this.terminate("cancelled", this.summarizeError(error));
        return;
      }
      await this.terminate("failed", this.summarizeError(error));
    } finally {
      // Engine cleanup is best-effort; the engine internally tolerates
      // double-close.
      if (this.sessionRef) {
        try {
          const engine = this.deps.engines.resolve(this.spec.engine);
          await engine.dispose(this.sessionRef);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.deps.logger.warn(
            `remotion-ai engine.dispose failed jobId=${this.spec.jobId} error=${JSON.stringify(detail)}`,
          );
        }
      }
      // Workspace is intentionally NOT auto-cleaned on success — the user
      // was promised "a directory you can add to templateRoots". Only
      // transient cancel/failure cases dispose it.
    }
  }

  /**
   * Translate the user's auth choice into the env-vars the codex CLI
   * needs to find the correct OpenAI-compatible endpoint.
   *
   *   - hosted:        OPENAI_BASE_URL + OPENAI_API_KEY → yyvideoclaw proxy
   *   - byok openai:   no injection (codex reads ~/.codex/auth.json)
   *   - byok openrouter: OPENROUTER_API_KEY (matches `env_key` in
   *                      ~/.codex/config.toml [model_providers.openrouter]).
   *                      We do NOT set OPENAI_BASE_URL here — the toml
   *                      block already routes the openrouter provider to
   *                      https://openrouter.ai/api/v1.
   */
  private async buildEnvInjection(authConfig: AuthConfig): Promise<
    | {
        readonly env: Record<string, string>;
        readonly clearEnv?: string[];
      }
    | undefined
  > {
    if (authConfig.mode === "hosted" && authConfig.hostedToken) {
      const baseUrl =
        this.deps.resolveHostedOpenAiBaseUrl?.() ?? new AuthBackend().hostedOpenAiBaseUrl;
      return {
        env: {
          OPENAI_BASE_URL: baseUrl,
          OPENAI_API_KEY: authConfig.hostedToken,
        },
        // Strip any pre-existing OPENAI_API_KEY in the gateway's shell
        // so our hosted token wins deterministically. We also strip
        // OPENAI_BASE_URL so a stray staging override doesn't redirect
        // the codex child somewhere unexpected.
        clearEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
      };
    }
    if (authConfig.mode === "byok" && authConfig.byokProvider === "openrouter") {
      const key = await readOpenRouterKey();
      if (!key) {
        // Sidecar got deleted out from under us. Fall through to no
        // injection; codex will fail to find OPENROUTER_API_KEY and
        // return a clear 401 that surfaces in turn_complete.errorMessage.
        return undefined;
      }
      return {
        env: { OPENROUTER_API_KEY: key },
        // Strip any pre-existing OPENAI_API_KEY/BASE_URL so codex's
        // openrouter provider lookup is the only routing in effect.
        clearEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
      };
    }
    return undefined;
  }

  private resolveStarterDir(): string {
    if (this.deps.config.starterDir) {
      return this.deps.config.starterDir;
    }
    // Default: repo's `remotion-templates/ai-starter`. The path is computed
    // relative to the plugin's own location so packaged builds (which
    // bundle the starter alongside the plugin) still find it.
    return path.resolve(import.meta.dirname, "..", "..", "..", "remotion-templates", "ai-starter");
  }

  private async advancePhase(phase: Phase): Promise<void> {
    if (this.cancelled) {
      return;
    }
    this.deps.jobs.update(this.spec.jobId, { phase });
    logJobPhase(this.deps.logger, { jobId: this.spec.jobId, phase });
  }

  private async terminate(
    phase: "done" | "failed" | "cancelled",
    errorSummary?: string,
  ): Promise<void> {
    const durationMs = this.now() - this.startedAt;
    this.deps.jobs.update(this.spec.jobId, {
      phase,
      ...(errorSummary ? { errorSummary } : {}),
    });
    if (phase !== "done") {
      this.deps.jobs.emit({
        type: "error",
        jobId: this.spec.jobId,
        message: errorSummary ?? "job ended without success",
        at: this.now(),
      });
      // Best-effort cleanup of partial workspace on terminal failure /
      // cancellation; success keeps it because the user wants to add it
      // to `templateRoots`.
      if (this.workspaceDir) {
        await (this.deps.disposeWorkspace ?? disposeWorkspace)(this.workspaceDir);
      }
    }
    logJobFinish(this.deps.logger, {
      jobId: this.spec.jobId,
      outcome: phase,
      retryCount: this.retryCount,
      durationMs,
    });
  }

  private async applyBackoff(attemptIndex: number): Promise<void> {
    const ms = 500 * 4 ** attemptIndex;
    const cappedMs = Math.min(Math.max(0, ms), 30_000);
    if (cappedMs <= 0) {
      return;
    }
    const sleep =
      this.deps.sleep ??
      ((duration: number, signal: AbortSignal): Promise<void> => {
        return new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, duration);
          timer.unref?.();
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      });
    await sleep(cappedMs, this.abortController.signal);
  }

  private checkCancelled(): void {
    if (this.cancelled) {
      throw new Error("job cancelled by user");
    }
  }

  private summarizeError(error: unknown): string {
    if (error instanceof Error) {
      const raw = `${error.name}: ${error.message}`;
      // Recognize the common "missing CLI" failure surfaced by Node's
      // child_process.spawn when the codex (or any engine) executable
      // isn't available. The bare message ("Error: spawn codex ENOENT")
      // is meaningless to most users; add an actionable hint that points
      // at the actual root cause + fix path. We keep the raw error text
      // appended so debug-savvy users still see exactly what Node tried.
      const enoentMatch = /spawn\s+(\S+)\s+ENOENT/u.exec(error.message);
      if (enoentMatch) {
        const cmd = enoentMatch[1];
        if (cmd === "codex") {
          // The bundled @openai/codex resolver in codex-engine.ts should
          // have prevented this — if we got here, the plugin's
          // node_modules layout is broken (e.g. dist staging hasn't
          // copied @openai/codex into the plugin's local node_modules).
          return (
            `Codex CLI failed to launch: the bundled @openai/codex executable ` +
            `couldn't be located in the plugin's node_modules. Try running ` +
            `\`pnpm install --filter @openclaw/remotion-ai\` and then restart ` +
            `the OpenClaw gateway. (Original error: ${raw})`
          );
        }
        return (
          `Engine executable "${cmd}" not found. Set ` +
          `plugins.entries.codex.config.appServer.command to an absolute path ` +
          `in your openclaw.json, then restart the gateway. (Original error: ${raw})`
        );
      }
      return raw;
    }
    return String(error);
  }
}
