// extensions/remotion-ai/src/engine/codex-engine.ts
//
// M1 implementation of `RemotionAgentEngine`. Wraps `spawnCodexAppServerJob`
// from the codex plugin's narrow public surface (`@openclaw/codex/api.js`).
// Forbidden imports: `extensions/codex/src/**` (cross-extension deep import
// is a hard architectural rule — see `extensions/AGENTS.md`).
//
// IMPORTANT: the cross-extension import is `type`-only at the module top
// (vitest's ESM resolver does not honor the tsconfig `@openclaw/*` paths
// alias). The runtime function `spawnCodexAppServerJob` is loaded via
// dynamic import the first time it's needed, AFTER tests have had a chance
// to inject a fake via `deps.spawnJob`. This keeps the unit-test seam free
// of any production dependency on the codex package.
//
// The codex CLI binary itself ships as the `@openai/codex` npm dependency
// (declared in remotion-ai's package.json). We resolve it from the local
// `node_modules` and pass an absolute path into the codex plugin's
// `appServer.command` config so the spawn never falls back to a `$PATH`
// lookup. This is the entire reason "no codex on PATH" was a real bug:
// shipping the binary as an npm dep and explicitly pointing at it removes
// the user-facing install step.
//
// Auth env injection (M1 hosted/byok):
//   We need to set `OPENAI_BASE_URL` + `OPENAI_API_KEY` on the codex child
//   process WITHOUT touching `process.env` (that would leak the bearer
//   token to the rest of the gateway). The codex plugin's
//   `appServer.env` schema field exists but isn't currently honored by
//   `resolveCodexAppServerRuntimeOptions`, so we route the spawn through
//   `codex-launcher.cjs` — a tiny CommonJS shim that reads the env
//   from a one-shot sidecar JSON file and exec()s codex with the
//   merged environment. The sidecar file lives in `os.tmpdir()` and is
//   deleted by the launcher before codex starts.

import { promises as fsp } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CodexAppServerJobEvent,
  CodexAppServerJobHandle,
  SpawnCodexAppServerJobOptions,
  spawnCodexAppServerJob as SpawnCodexAppServerJobFn,
} from "@openclaw/codex/api.js";
import type {
  AgentEngineAttemptResult,
  AgentEngineCapabilities,
  EngineId,
  JobEvent,
} from "../types.js";
import { projectCodexJobEvent } from "./engine-events.js";
import type { EngineRetryParams, EngineRunParams, RemotionAgentEngine } from "./engine.js";

type SpawnCodexJob = typeof SpawnCodexAppServerJobFn;

const ENGINE_ID: EngineId = "codex";

const CAPABILITIES: AgentEngineCapabilities = {
  id: ENGINE_ID,
  label: "Codex (app-server)",
  supportsRetry: true,
};

const DEFAULT_DEVELOPER_INSTRUCTIONS = [
  "You are running inside an OpenClaw Remotion AI Create job.",
  "The workspace at `cwd` contains a Remotion starter project. Your task is",
  "to author the project (typically `src/Root.tsx` plus sibling components)",
  "so that bundle + selectComposition + render-still all succeed for at",
  "least one registered <Composition>.",
  "Do NOT install new npm packages. Do NOT touch `.skills/`. Use",
  "extension-less relative imports inside the Remotion project.",
  "Captions/subtitles are visual only; a rendered video has sound only when",
  "the composition includes explicit Remotion audio such as <Audio>. If",
  "src/generated/voiceover.ts exists, import voiceoverCues and use each cue's",
  "same start/end frames for <Audio>, subtitle text, and visual scene timing.",
].join(" ");

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- ESLint's TS resolver does not honour the repo-root tsconfig `@openclaw/*` paths, so `SpawnCodexJob` resolves to `any` here even though tsgo (the source-of-truth typecheck) sees the real `typeof spawnCodexAppServerJob` signature. The `| null` half is the meaningful one for the cache.
let cachedSpawnJob: SpawnCodexJob | null = null;
async function loadDefaultSpawnJob(): Promise<SpawnCodexJob> {
  if (cachedSpawnJob !== null) {
    return cachedSpawnJob;
  }
  // Dynamic import keeps `@openclaw/codex/api.js` out of the static module
  // graph for tests / environments that inject `deps.spawnJob` directly.
  const mod = (await import("@openclaw/codex/api.js")) as {
    spawnCodexAppServerJob: SpawnCodexJob;
  };
  cachedSpawnJob = mod.spawnCodexAppServerJob;
  return cachedSpawnJob;
}

/**
 * Resolve the absolute path to the bundled `@openai/codex` CLI entry. We
 * use `createRequire(import.meta.url)` so the lookup happens relative to
 * THIS plugin's `node_modules` (works for both pnpm's symlink layout and
 * a flattened bundled-plugins install).
 *
 * Failure to resolve is NOT cached so that staged-bundling races (the bin
 * is materialized milliseconds AFTER the plugin module first loads) don't
 * permanently disable bundling for the lifetime of the gateway.
 *
 * Returns `null` if the dep isn't present after a real resolution attempt.
 * In that case the codex plugin's existing PATH fallback runs and surfaces
 * the familiar "spawn codex ENOENT" error, which the orchestrator turns
 * into a user-friendly hint.
 */
let cachedBundledCodexBin: string | null = null;
function resolveBundledCodexBin(): string | null {
  if (cachedBundledCodexBin) {
    return cachedBundledCodexBin;
  }
  try {
    const require = createRequire(import.meta.url);
    cachedBundledCodexBin = require.resolve("@openai/codex/bin/codex.js");
    return cachedBundledCodexBin;
  } catch {
    // Don't cache the negative result — let the next call try again so a
    // late-arriving bin (e.g. from postinstall staging) becomes usable
    // without restarting the gateway.
    return null;
  }
}

/**
 * Resolve the absolute path to our `codex-launcher.cjs`. We bundle the
 * launcher next to this file (build copies it as-is). When called from
 * tests / the dev tree, `import.meta.url` points at the .ts file; the
 * .cjs sibling is in the same directory regardless.
 */
let cachedLauncherPath: string | null = null;
function resolveLauncherPath(): string {
  if (cachedLauncherPath) {
    return cachedLauncherPath;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  cachedLauncherPath = path.join(here, "codex-launcher.cjs");
  return cachedLauncherPath;
}

/**
 * Per-spawn env injection request: a JSON object the launcher reads from
 * a one-shot tmp file and merges into the codex child's environment.
 *
 * `env` keys are added on top of `process.env` (in the child only).
 * `clearEnv` keys are removed before `env` is applied. This matches the
 * `codex` plugin's already-supported `appServer.env` / `appServer.clearEnv`
 * shape, so the day the codex plugin starts honoring those fields we can
 * delete the launcher and migrate transparently.
 */
export interface CodexEnvInjection {
  readonly env: Record<string, string>;
  readonly clearEnv: string[];
}

/**
 * Materialize `injection` to a tmp file under `os.tmpdir()` with 0600
 * perms and return the absolute path. The launcher deletes the file
 * before exec()ing codex, so the bearer token's lifetime on disk is
 * bounded by "milliseconds between this write and the launcher's
 * unlink". Caller is responsible for handling spawn failures (in which
 * case the file may linger; the launcher runs on EVERY codex spawn, so
 * a stale file is a self-healing condition next time).
 */
async function writeEnvSidecarFile(injection: CodexEnvInjection): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "remotion-ai-codex-env-"));
  const file = path.join(dir, "env.json");
  await fsp.writeFile(file, JSON.stringify(injection), { mode: 0o600 });
  return file;
}

/**
 * Merge the bundled-codex command into a (possibly user-supplied)
 * `pluginConfig` so the codex plugin spawns our `node_modules` copy by
 * absolute path instead of hitting `$PATH`. User-provided
 * `appServer.command` always wins — that's the documented escape hatch
 * for advanced setups (homebrew install, custom build, etc.).
 *
 * When `envSidecarFile` is supplied, the spawn is routed through
 * `codex-launcher.cjs` so the child process picks up our injected env
 * (e.g. `OPENAI_BASE_URL` + `OPENAI_API_KEY` for hosted mode) without
 * polluting `process.env` of the gateway.
 */
function withBundledCodexCommand(pluginConfig: unknown, envSidecarFile?: string): unknown {
  const bin = resolveBundledCodexBin();
  if (!bin) {
    return pluginConfig;
  }
  const base =
    pluginConfig && typeof pluginConfig === "object"
      ? (pluginConfig as Record<string, unknown>)
      : {};
  const appServerRaw =
    base.appServer && typeof base.appServer === "object"
      ? (base.appServer as Record<string, unknown>)
      : {};
  // Honour an explicit user override.
  if (typeof appServerRaw.command === "string" && appServerRaw.command.trim().length > 0) {
    return base;
  }
  // Honour the env var the codex plugin already supports.
  if (
    typeof process.env.OPENCLAW_CODEX_APP_SERVER_BIN === "string" &&
    process.env.OPENCLAW_CODEX_APP_SERVER_BIN.length > 0
  ) {
    return base;
  }
  // No env injection requested → spawn codex directly via Node, same as
  // before this PR. Keeps the cold path latency identical.
  if (!envSidecarFile) {
    return {
      ...base,
      appServer: {
        ...appServerRaw,
        command: process.execPath,
        args: [bin, "app-server", "--listen", "stdio://"],
      },
    };
  }
  // Env injection requested → route through the launcher.
  return {
    ...base,
    appServer: {
      ...appServerRaw,
      command: process.execPath,
      args: [resolveLauncherPath(), envSidecarFile, bin, "app-server", "--listen", "stdio://"],
    },
  };
}

/**
 * Test seam: lets unit tests inject a fake `spawnCodexAppServerJob`
 * implementation without touching the real Codex transport.
 */
export interface CodexEngineDeps {
  readonly spawnJob?: SpawnCodexJob;
  readonly pluginConfig?: unknown;
}

export function createCodexEngine(deps: CodexEngineDeps = {}): RemotionAgentEngine {
  const sessions = new Map<string, CodexAppServerJobHandle>();
  const resolveSpawnJob = async (): Promise<SpawnCodexJob> =>
    deps.spawnJob ?? (await loadDefaultSpawnJob());

  /**
   * Wrap the caller's onEvent forwarder so we can also OBSERVE the
   * `turn_complete` event for the FIRST turn. The codex spawn helper
   * already awaits the first turn before resolving the handle, but
   * historically `runAttempt` discarded the outcome — meaning a turn that
   * came back `failed` or `interrupted` (e.g. no auth profile, model
   * refused, sandbox tripwire) would silently be treated as a successful
   * agent attempt. The orchestrator would then validate the untouched
   * starter template, "succeed", and ship a placeholder video back to the
   * user. Capturing the outcome here lets us fail loud at the agent step
   * with a real error instead.
   */
  function bindForwarderWithOutcome(
    jobId: string,
    onEvent: (event: JobEvent) => void,
  ): {
    forward: (event: CodexAppServerJobEvent) => void;
    getOutcome: () =>
      | {
          readonly status: "completed" | "failed" | "interrupted";
          readonly errorMessage?: string;
        }
      | undefined;
  } {
    let outcome:
      | { readonly status: "completed" | "failed" | "interrupted"; readonly errorMessage?: string }
      | undefined;
    const forward = (event: CodexAppServerJobEvent): void => {
      if (event.type === "turn_complete" && !outcome) {
        outcome = event.errorMessage
          ? { status: event.status, errorMessage: event.errorMessage }
          : { status: event.status };
      }
      for (const projected of projectCodexJobEvent(jobId, event)) {
        onEvent(projected);
      }
    };
    return { forward, getOutcome: () => outcome };
  }

  function bindForwarder(
    jobId: string,
    onEvent: (event: JobEvent) => void,
  ): (event: CodexAppServerJobEvent) => void {
    return (event) => {
      for (const projected of projectCodexJobEvent(jobId, event)) {
        onEvent(projected);
      }
    };
  }

  function buildSpawnOptions(
    params: EngineRunParams,
    forward: (event: CodexAppServerJobEvent) => void,
    envSidecarFile: string | undefined,
  ): SpawnCodexAppServerJobOptions {
    const developerInstructions = [params.developerInstructions, DEFAULT_DEVELOPER_INSTRUCTIONS]
      .filter((entry): entry is string => Boolean(entry && entry.trim().length))
      .join("\n\n");
    const pluginConfig = withBundledCodexCommand(deps.pluginConfig, envSidecarFile);
    return {
      workspaceDir: params.workspaceDir,
      initialPrompt: params.prompt,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      requestTimeoutMs: Math.max(5_000, Math.min(params.jobTimeoutMs, 600_000)),
      pluginConfig,
      developerInstructions,
      abortSignal: params.abortSignal,
      onEvent: forward,
    };
  }

  return {
    id: ENGINE_ID,
    capabilities: CAPABILITIES,

    async runAttempt(params) {
      const spawnJob = await resolveSpawnJob();
      const { forward, getOutcome } = bindForwarderWithOutcome(params.jobId, params.onEvent);
      // Materialize the env sidecar (hosted-mode bearer token, etc.)
      // BEFORE spawning codex so the launcher can read+unlink it
      // immediately. We deliberately don't catch fs errors here: if the
      // user's tmpdir is unwritable, codex would fail anyway, and a loud
      // throw is the right signal. Note that `deps.spawnJob` (test seam)
      // gets the same sidecar path passed through, but tests typically
      // ignore the field — they just assert pluginConfig has it.
      let envSidecarFile: string | undefined;
      if (params.envInjection) {
        envSidecarFile = await writeEnvSidecarFile({
          env: params.envInjection.env,
          clearEnv: params.envInjection.clearEnv ?? [],
        });
      }
      const handle = await spawnJob(buildSpawnOptions(params, forward, envSidecarFile));
      sessions.set(handle.threadId, handle);
      // The codex spawn helper resolves only after the first turn settles,
      // so by the time we reach this line the outcome MUST be observable.
      // If it isn't (no turn_complete arrived), treat that as a failed
      // attempt — silent "no events" is the worst possible mode.
      const outcome = getOutcome();
      if (!outcome) {
        throw new Error(
          "codex agent attempt produced no turn_complete event; the first turn never settled",
        );
      }
      if (outcome.status !== "completed") {
        const detail = outcome.errorMessage ?? "no error message provided";
        throw new Error(`codex agent attempt ${outcome.status}: ${detail}`);
      }
      return {
        sessionRef: handle.threadId,
        assistantText: "",
      } satisfies AgentEngineAttemptResult;
    },

    async retry(params: EngineRetryParams) {
      const handle = sessions.get(params.sessionRef);
      if (!handle) {
        throw new Error(`codex-engine: unknown sessionRef ${params.sessionRef}`);
      }
      const forwarder = bindForwarder(params.jobId, params.onEvent);
      // The handle's onEvent forwarder was bound in runAttempt and remains
      // active for retries. `forwarder` is constructed for symmetry / the
      // future case where retries must route events to a different sink.
      void forwarder;
      const outcome = await handle.sendUserTurn(params.digest, {
        signal: params.abortSignal,
      });
      if (outcome.status !== "completed") {
        throw new Error(
          `codex agent retry ${outcome.status}` +
            (outcome.status === "failed" ? "; see prior turn_complete event for details" : ""),
        );
      }
      return {
        sessionRef: params.sessionRef,
        assistantText: "",
      } satisfies AgentEngineAttemptResult;
    },

    async dispose(sessionRef: string) {
      const handle = sessions.get(sessionRef);
      if (!handle) {
        return;
      }
      sessions.delete(sessionRef);
      await handle.close();
    },
  };
}

// Re-exported for tests so they can assert the bundling behaviour without
// touching real `node_modules`. `__resetCacheForTests` lets env-sensitive
// tests clear the bin-path cache between cases.
export const __test__ = {
  withBundledCodexCommand,
  resolveBundledCodexBin,
  __resetCacheForTests: () => {
    cachedBundledCodexBin = null;
  },
};
