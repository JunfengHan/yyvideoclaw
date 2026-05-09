// RenderQueue: serial executor for render jobs.
//
// concurrency=1 by design. The queue:
//   1. Spawns the render worker as a sanitized child Node process.
//   2. Streams the JSON job description to its stdin.
//   3. Awaits the single JSON response on stdout (or a worker-error).
//   4. Enforces a hard timeout via SIGKILL.
//   5. Buffers stderr for diagnostics but never lets it block stdout draining.
//
// All env-scrubbing / `spawn(cmd, args[])` discipline lives here. The plugin
// must NEVER spawn the worker from elsewhere.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CompositionInfo, RenderJobRequest, WorkerIpcMessage } from "./types.js";

export class RenderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`render job exceeded ${timeoutMs}ms and was killed`);
    this.name = "RenderTimeoutError";
  }
}

export class RenderProtocolError extends Error {
  constructor(message: string) {
    super(`render worker protocol error: ${message}`);
    this.name = "RenderProtocolError";
  }
}

export class RenderWorkerError extends Error {
  constructor(message: string) {
    super(`render worker failed: ${message}`);
    this.name = "RenderWorkerError";
  }
}

interface SpawnEnvOptions {
  /** Override the Node executable used to launch the worker. */
  nodeExecutable?: string;
}

interface ListJobOptions {
  entryPoint: string;
  cacheDir?: string;
  allowNetwork: boolean;
  browserExecutable?: string;
}

interface RenderJobOptions {
  job: RenderJobRequest;
  outputPath: string;
  cacheDir?: string;
  allowNetwork: boolean;
  browserExecutable?: string;
}

interface QueueOptions extends SpawnEnvOptions {
  jobTimeoutMs: number;
  /** Path to the compiled render-worker entry. Defaults to the colocated file. */
  workerPath?: string;
}

// Worker entry candidates.
//
// The physical location of the worker depends on how this file itself was
// loaded:
//
//   * Dev / vitest lane:
//       render-queue.ts lives under `extensions/remotion/src/`, so
//       `./render-worker.ts` (sibling) is the right relative path.
//
//   * Packaged build (tsdown output):
//       render-queue.ts is INLINED into `dist/extensions/remotion/index.js`,
//       so `import.meta.url` points at `dist/extensions/remotion/`. Meanwhile
//       tsdown emits the worker (declared as a separate entry in
//       `openclaw.extensions`) at `dist/extensions/remotion/src/render-worker.js`,
//       preserving the source layout.
//
// We therefore probe multiple candidates in order: sibling first (dev),
// then `src/` subdir (packaged), for both .js and .ts. The first existing
// file wins.
const WORKER_CANDIDATES = [
  { rel: "./render-worker.js", needsTsxLoader: false },
  { rel: "./src/render-worker.js", needsTsxLoader: false },
  { rel: "./render-worker.ts", needsTsxLoader: true },
  { rel: "./src/render-worker.ts", needsTsxLoader: true },
] as const;

/**
 * Locate the worker entry at runtime. See WORKER_CANDIDATES for layout notes.
 * The caller may override `workerPath` explicitly (used by tests).
 */
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
  // Nothing found — return the most likely dev-lane path so the error message
  // at spawn time is informative rather than empty.
  return {
    entry: fileURLToPath(new URL("./render-worker.ts", import.meta.url)),
    needsTsxLoader: true,
  };
}

/**
 * The set of env vars the worker is allowed to inherit. Anything else is
 * stripped, which prevents OpenClaw bearer tokens, model API keys, etc. from
 * leaking into a (potentially user-authored) composition.
 */
const SAFE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ"] as const;

function buildSafeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // Quiet noise from Remotion's own telemetry / opt-out prompts when present.
  env.REMOTION_DISABLE_TELEMETRY = "1";
  return env;
}

export class RenderQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly events = new EventEmitter();

  constructor(private readonly opts: QueueOptions) {}

  /** Allow tests to observe lifecycle without coupling to logger output. */
  on(event: "spawn" | "finish" | "timeout", listener: (info: { jobId?: string }) => void): void {
    this.events.on(event, listener);
  }

  enqueueList(input: ListJobOptions): Promise<CompositionInfo[]> {
    return this.run(async () => {
      const message = await this.runWorker({
        kind: "list-compositions",
        entryPoint: input.entryPoint,
        ...(input.cacheDir ? { cacheDir: input.cacheDir } : {}),
        allowNetwork: input.allowNetwork,
        ...(input.browserExecutable ? { browserExecutable: input.browserExecutable } : {}),
      });
      if (message.kind !== "list-compositions") {
        throw new RenderProtocolError(`expected list-compositions, got ${message.kind}`);
      }
      return message.compositions;
    });
  }

  enqueueRender(
    input: RenderJobOptions,
  ): Promise<{ outputPath: string; sizeBytes: number; durationMs: number }> {
    return this.run(async () => {
      const message = await this.runWorker(
        {
          kind: "render",
          job: input.job,
          outputPath: input.outputPath,
          ...(input.cacheDir ? { cacheDir: input.cacheDir } : {}),
          allowNetwork: input.allowNetwork,
          ...(input.browserExecutable ? { browserExecutable: input.browserExecutable } : {}),
        },
        input.job.jobId,
      );
      if (message.kind !== "render-complete") {
        throw new RenderProtocolError(`expected render-complete, got ${message.kind}`);
      }
      return {
        outputPath: message.outputPath,
        sizeBytes: message.sizeBytes,
        durationMs: message.durationMs,
      };
    });
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    // Serialise: chain every job onto the previous one so concurrency=1 holds
    // even under parallel callers.
    const next = this.chain.then(fn, fn);
    // Swallow the value type for the chain so a failure does not poison
    // subsequent jobs.
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async runWorker(input: unknown, jobId?: string): Promise<WorkerIpcMessage> {
    const { entry: workerPath, needsTsxLoader } = resolveWorkerEntry(this.opts.workerPath);
    const nodeExecutable = this.opts.nodeExecutable ?? process.execPath;

    // SECURITY: spawn(cmd, args[]) form — never string concatenation. The
    // worker path is plugin-internal (resolved via import.meta.url) so it is
    // not user-controllable.
    const args = needsTsxLoader ? ["--import", "tsx", workerPath] : [workerPath];
    const child = spawn(nodeExecutable, args, {
      env: buildSafeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      // Detach=false is the default; we keep the worker tied to our lifecycle
      // so an abrupt parent exit also terminates it.
    });

    this.events.emit("spawn", { jobId });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.events.emit("timeout", { jobId });
      child.kill("SIGKILL");
    }, this.opts.jobTimeoutMs);
    if (timer.unref) {
      timer.unref();
    }

    try {
      child.stdin.write(`${JSON.stringify(input)}\n`);
      child.stdin.end();
    } catch (err) {
      child.kill("SIGKILL");
      clearTimeout(timer);
      throw new RenderWorkerError(
        `failed to write worker stdin: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const exitCode: number | null = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });
    clearTimeout(timer);
    this.events.emit("finish", { jobId });

    if (timedOut) {
      throw new RenderTimeoutError(this.opts.jobTimeoutMs);
    }

    const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
    if (!stdout) {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      throw new RenderProtocolError(
        `worker exited with code ${exitCode ?? "null"} and produced no stdout. stderr=${stderr.slice(0, 512)}`,
      );
    }

    // The worker is contractually allowed exactly one JSON line. If multiple
    // lines arrive (e.g. console.log leaked in), the LAST line is the one we
    // honour because the worker writes its result message immediately before
    // exit.
    const lines = stdout.split(/\r?\n/);
    let lastLine = "";
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line !== undefined && line !== "") {
        lastLine = line;
        break;
      }
    }
    let message: WorkerIpcMessage;
    try {
      message = JSON.parse(lastLine) as WorkerIpcMessage;
    } catch (err) {
      throw new RenderProtocolError(
        `worker stdout was not JSON: ${err instanceof Error ? err.message : String(err)}; raw=${lastLine.slice(0, 256)}`,
      );
    }

    if (message.kind === "worker-error") {
      throw new RenderWorkerError(message.message);
    }
    if (exitCode !== 0) {
      throw new RenderWorkerError(`worker exited with non-zero code ${exitCode}`);
    }
    return message;
  }
}
