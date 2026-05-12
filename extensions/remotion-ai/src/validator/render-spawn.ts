// extensions/remotion-ai/src/validator/render-spawn.ts
//
// Spawn manager for the AI render worker. Mirrors the env-scrub / SIGKILL /
// JSON-line-IPC discipline of `extensions/remotion/src/render-queue.ts`,
// scoped to the single-shot validation use case (no concurrency=1 queue
// because the AI workspace owns one job at a time).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AiRenderWorkerInput, AiRenderWorkerMessage } from "./types.js";

export class AiRenderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`AI render validation exceeded ${timeoutMs}ms and was killed`);
    this.name = "AiRenderTimeoutError";
  }
}

export class AiRenderProtocolError extends Error {
  constructor(message: string) {
    super(`AI render worker protocol error: ${message}`);
    this.name = "AiRenderProtocolError";
  }
}

export class AiRenderWorkerError extends Error {
  constructor(message: string) {
    super(`AI render worker failed: ${message}`);
    this.name = "AiRenderWorkerError";
  }
}

export interface SpawnOptions {
  readonly input: AiRenderWorkerInput;
  readonly jobTimeoutMs: number;
  readonly abortSignal?: AbortSignal;
  /** Override the worker entry path (used by tests). */
  readonly workerPath?: string;
  /** Override the Node executable used to launch the worker. */
  readonly nodeExecutable?: string;
}

const WORKER_CANDIDATES = [
  // Same probing logic as `extensions/remotion/src/render-queue.ts`: dev-lane
  // .ts sibling first, then packaged .js variants.
  { rel: "./ai-render-worker.js", needsTsxLoader: false },
  { rel: "./src/validator/ai-render-worker.js", needsTsxLoader: false },
  { rel: "./ai-render-worker.ts", needsTsxLoader: true },
  { rel: "./src/validator/ai-render-worker.ts", needsTsxLoader: true },
] as const;

function resolveWorkerEntry(explicitPath?: string): { entry: string; needsTsxLoader: boolean } {
  if (explicitPath) {
    return { entry: explicitPath, needsTsxLoader: explicitPath.endsWith(".ts") };
  }
  for (const candidate of WORKER_CANDIDATES) {
    const entry = fileURLToPath(new URL(candidate.rel, import.meta.url));
    if (existsSync(entry)) {
      return { entry, needsTsxLoader: candidate.needsTsxLoader };
    }
  }
  return {
    entry: fileURLToPath(new URL("./ai-render-worker.ts", import.meta.url)),
    needsTsxLoader: true,
  };
}

const SAFE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ"] as const;

function buildSafeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.REMOTION_DISABLE_TELEMETRY = "1";
  return env;
}

/**
 * Spawn the AI render worker, stream the input JSON to stdin, and await its
 * single-line JSON response. Mirrors the contract of `RenderQueue.runWorker`
 * in the remotion plugin: SIGKILL on timeout/abort, structured error types,
 * stderr captured for diagnostics.
 */
export async function spawnAiRenderValidation(
  options: SpawnOptions,
): Promise<AiRenderWorkerMessage> {
  if (options.abortSignal?.aborted) {
    throw new Error("ai render validation aborted before spawn");
  }
  const { entry: workerPath, needsTsxLoader } = resolveWorkerEntry(options.workerPath);
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const args = needsTsxLoader ? ["--import", "tsx", workerPath] : [workerPath];

  const child = spawn(nodeExecutable, args, {
    env: buildSafeEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  let timedOut = false;
  let abortedExternally = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.jobTimeoutMs);
  timer.unref?.();

  const onUpstreamAbort = (): void => {
    abortedExternally = true;
    child.kill("SIGKILL");
  };
  if (options.abortSignal) {
    if (options.abortSignal.aborted) {
      onUpstreamAbort();
    } else {
      options.abortSignal.addEventListener("abort", onUpstreamAbort, { once: true });
    }
  }

  try {
    child.stdin.write(`${JSON.stringify(options.input)}\n`);
    child.stdin.end();
  } catch (err) {
    child.kill("SIGKILL");
    clearTimeout(timer);
    options.abortSignal?.removeEventListener("abort", onUpstreamAbort);
    throw new AiRenderWorkerError(
      `failed to write worker stdin: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const exitCode: number | null = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  clearTimeout(timer);
  options.abortSignal?.removeEventListener("abort", onUpstreamAbort);

  if (timedOut) {
    throw new AiRenderTimeoutError(options.jobTimeoutMs);
  }
  if (abortedExternally) {
    throw new Error("ai render validation aborted by caller");
  }

  const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
  if (!stdout) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    throw new AiRenderProtocolError(
      `worker exited with code ${exitCode ?? "null"} and produced no stdout. stderr=${stderr.slice(0, 512)}`,
    );
  }

  // The worker contract emits one JSON line. If anything else slipped in
  // (console.log inside the bundler, etc.), keep the LAST non-empty line.
  const lines = stdout.split(/\r?\n/);
  let lastLine = "";
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line !== undefined && line !== "") {
      lastLine = line;
      break;
    }
  }
  let message: AiRenderWorkerMessage;
  try {
    message = JSON.parse(lastLine) as AiRenderWorkerMessage;
  } catch (err) {
    throw new AiRenderProtocolError(
      `worker stdout was not JSON: ${err instanceof Error ? err.message : String(err)}; raw=${lastLine.slice(0, 256)}`,
    );
  }

  if (message.kind === "worker-error") {
    throw new AiRenderWorkerError(message.message);
  }
  if (exitCode !== 0) {
    throw new AiRenderWorkerError(`worker exited with non-zero code ${exitCode}`);
  }
  return message;
}
