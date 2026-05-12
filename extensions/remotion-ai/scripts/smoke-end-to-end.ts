// extensions/remotion-ai/scripts/smoke-end-to-end.ts
//
// Local end-to-end smoke runner for the Remotion AI Create pipeline.
// Bypasses the gateway HTTP/SSE shell and drives the orchestrator
// directly so we can see every phase transition / engine message /
// validation outcome on stdout in real time.
//
// Why this exists
// ---------------
// The HTTP path (POST /remotion-ai/jobs + SSE /events) is the production
// surface, but it adds three layers of indirection that make first-time
// debugging expensive: gateway lifecycle, bearer auth, and SSE framing.
// For "did the agent → bundle → render-still → render-video chain ever
// produce an mp4 on this machine?" we just need to construct an
// `Orchestrator` with the same deps the plugin entry uses, submit one
// job, and tail the global event stream.
//
// Usage
// -----
//     pnpm tsx extensions/remotion-ai/scripts/smoke-end-to-end.ts \
//       "make a 3-second video that says hello world in big letters"
//
// Or with no args — uses a sensible default prompt.
//
// Exit codes
// ----------
//     0 → job ended in `done` with a video file on disk
//     1 → job ended in `failed` / `cancelled`, or threw
//     2 → setup error (config invalid, etc.)
//
// This file is intentionally NOT part of the production bundle. It
// imports straight out of `src/` (no `.js` resolution issue because tsx
// rewrites to TypeScript on the fly) and uses `console.*` for output.

import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { removeOpenRouterConfig } from "../src/codex-config-toml.js";
import { resolveRemotionAiConfig } from "../src/config.js";
import { EngineRegistry } from "../src/engine/engine-registry.js";
import { JobsStore } from "../src/jobs-store.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { JobEvent, JobSnapshot, Phase } from "../src/types.js";

const DEFAULT_PROMPT =
  "Create a Remotion composition named HelloWorld. It should be 90 frames " +
  "at 30fps (3 seconds), 1280x720, with a centered text 'Hello, world!' " +
  "fading in from opacity 0 to 1 over the first 30 frames using " +
  "interpolate(). Register it in src/Root.tsx via <Composition>.";

const REPO_ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const OPENCLAW_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH ?? path.join(REPO_ROOT, "openclaw.json");

interface OpenClawJsonShape {
  readonly plugins?: {
    readonly entries?: Record<string, { readonly enabled?: boolean; readonly config?: unknown }>;
  };
}

async function loadPluginConfig(): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(OPENCLAW_CONFIG_PATH, "utf8");
  } catch (err) {
    console.error(
      `[smoke] could not read ${OPENCLAW_CONFIG_PATH}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {};
  }
  let parsed: OpenClawJsonShape;
  try {
    parsed = JSON.parse(raw) as OpenClawJsonShape;
  } catch (err) {
    console.error(
      `[smoke] ${OPENCLAW_CONFIG_PATH} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {};
  }
  return parsed.plugins?.entries?.["remotion-ai"]?.config ?? {};
}

function makeStdoutLogger() {
  const ts = (): string => new Date().toISOString().slice(11, 23);
  return {
    debug: (message: string) => console.log(`[${ts()}] [debug] ${message}`),
    info: (message: string) => console.log(`[${ts()}] [info ] ${message}`),
    warn: (message: string) => console.warn(`[${ts()}] [warn ] ${message}`),
    error: (message: string) => console.error(`[${ts()}] [error] ${message}`),
  };
}

function formatEvent(event: JobEvent): string {
  switch (event.type) {
    case "phase":
      return `phase=${event.phase}`;
    case "engine_message": {
      const trimmed = event.text.replace(/\s+/gu, " ").trim();
      const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
      return `engine_message: ${preview}`;
    }
    case "engine_tool":
      return `engine_tool name=${event.name} status=${event.status}`;
    case "validation_success": {
      const stages = Object.entries(event.stages)
        .map(([k, v]) => `${k}=${v}ms`)
        .join(" ");
      return `validation_success composition=${event.compositionId} ${stages}`;
    }
    case "validation_failure":
      return `validation_failure stage=${event.stage} retriesLeft=${event.retriesLeft} ${event.errorName}: ${truncate(
        event.errorMessage,
        180,
      )}`;
    case "error":
      return `error: ${truncate(event.message, 240)}`;
    default: {
      const exhaustive: never = event;
      void exhaustive;
      return JSON.stringify(event);
    }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

async function main(): Promise<number> {
  const prompt = process.argv.slice(2).join(" ").trim() || DEFAULT_PROMPT;
  console.log(`[smoke] config=${OPENCLAW_CONFIG_PATH}`);
  console.log(`[smoke] prompt=${truncate(prompt, 200)}`);

  let pluginConfig: unknown;
  try {
    pluginConfig = await loadPluginConfig();
  } catch (err) {
    console.error(`[smoke] failed to load plugin config: ${String(err)}`);
    return 2;
  }

  let resolvedConfig;
  try {
    resolvedConfig = resolveRemotionAiConfig(pluginConfig);
  } catch (err) {
    console.error(`[smoke] config invalid: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  console.log(
    `[smoke] resolved engine=${resolvedConfig.engine} retryMax=${resolvedConfig.retryMax} jobTimeoutMs=${resolvedConfig.jobTimeoutMs} skillsBundled=${resolvedConfig.skillsBundled} defaultOutputRoot=${resolvedConfig.defaultOutputRoot}`,
  );

  const logger = makeStdoutLogger();
  const jobs = new JobsStore();
  const engines = new EngineRegistry({ codex: { pluginConfig } });
  const orchestrator = new Orchestrator({
    config: resolvedConfig,
    logger,
    jobs,
    engines,
    removeOpenRouterConfig: () => removeOpenRouterConfig(),
  });

  // Tail every event so we can see the pipeline live.
  const seenJobIds = new Set<string>();
  jobs.subscribeAll((event) => {
    seenJobIds.add(event.jobId);
    const ts = new Date(event.at).toISOString().slice(11, 23);
    console.log(`[${ts}] [event ] ${event.jobId.slice(0, 8)} ${formatEvent(event)}`);
  });

  await fs.mkdir(resolvedConfig.defaultOutputRoot, { recursive: true });

  const start = performance.now();
  const submitted = orchestrator.submit({ prompt });
  console.log(
    `[smoke] submitted jobId=${submitted.snapshot.jobId} engine=${submitted.snapshot.engine}`,
  );

  // Cancel on SIGINT so resources clean up.
  let cancelled = false;
  const onSigint = () => {
    if (cancelled) return;
    cancelled = true;
    console.warn("[smoke] SIGINT — cancelling job …");
    orchestrator.cancel(submitted.snapshot.jobId, "smoke runner SIGINT");
  };
  process.on("SIGINT", onSigint);

  let final: JobSnapshot | undefined;
  try {
    final = await submitted.waitForCompletion();
  } catch (err) {
    console.error(
      `[smoke] waitForCompletion threw: ${err instanceof Error ? err.stack : String(err)}`,
    );
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
  }

  const ms = (performance.now() - start) | 0;
  if (!final) {
    console.error(`[smoke] no final snapshot, took ${ms}ms`);
    return 1;
  }
  const terminal: Phase = final.phase;
  console.log(`[smoke] terminal phase=${terminal} retryCount=${final.retryCount} took=${ms}ms`);
  console.log(`[smoke] workspaceDir=${final.workspaceDir}`);
  if (final.errorSummary) {
    console.log(`[smoke] errorSummary=${final.errorSummary}`);
  }
  if (final.stillPath) {
    console.log(`[smoke] stillPath=${final.stillPath}`);
  }
  if (final.videoOutputPath) {
    console.log(`[smoke] videoOutputPath=${final.videoOutputPath}`);
    try {
      const stat = await fs.stat(final.videoOutputPath);
      console.log(`[smoke] video size=${stat.size} bytes`);
    } catch (err) {
      console.warn(
        `[smoke] could not stat video file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return terminal === "done" ? 0 : 1;
}

main()
  .then((code) => {
    // Codex app-server child stays alive until orchestrator engine.dispose
    // returns; give pending awaits a tick to settle, then exit.
    setTimeout(() => process.exit(code), 100).unref();
  })
  .catch((err) => {
    console.error(`[smoke] uncaught: ${err instanceof Error ? err.stack : String(err)}`);
    setTimeout(() => process.exit(1), 100).unref();
  });
