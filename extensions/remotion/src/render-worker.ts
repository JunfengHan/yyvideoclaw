// Render worker — standalone Node entry point launched by the main plugin via
// child_process.spawn.
//
// Contract:
//   stdin:  a single JSON line containing a `WorkerInput` message, followed
//           by EOF. The worker ignores anything after the first line.
//   stdout: exactly one JSON line, a `WorkerIpcMessage` from types.ts.
//           Any additional lines are ignored by the parent.
//   stderr: free-form diagnostics. NOT parsed.
//   exit:   0 on success (message sent), 1 on any failure.
//
// The worker deliberately runs with:
//   - a scrubbed environment (parent controls this; we do not expand here),
//   - no access to OpenClaw runtime state,
//   - a single top-level try/catch so crashes always surface as a structured
//     `worker-error` message instead of a silent exit.

import { bundleProject, listCompositions, renderStill, renderVideo } from "./render.runtime.js";
import type { RenderJobRequest, WorkerIpcMessage } from "./types.js";

interface WorkerInputList {
  kind: "list-compositions";
  entryPoint: string;
  cacheDir?: string;
  allowNetwork: boolean;
  browserExecutable?: string;
}

interface WorkerInputRender {
  kind: "render";
  job: RenderJobRequest;
  outputPath: string;
  cacheDir?: string;
  allowNetwork: boolean;
  browserExecutable?: string;
}

type WorkerInput = WorkerInputList | WorkerInputRender;

function sendMessage(msg: WorkerIpcMessage): void {
  // Use a single write so the parent always sees one complete JSON line.
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function readStdinAll(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function run(): Promise<void> {
  const raw = await readStdinAll();
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("worker stdin was empty; expected a WorkerInput JSON line");
  }
  let input: WorkerInput;
  try {
    input = JSON.parse(trimmed) as WorkerInput;
  } catch (err) {
    throw new Error(
      `worker stdin was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (input.kind === "list-compositions") {
    const serveUrl = await bundleProject(input.entryPoint, {
      allowNetwork: input.allowNetwork,
      ...(input.browserExecutable ? { browserExecutable: input.browserExecutable } : {}),
      ...(input.cacheDir ? { cacheDir: input.cacheDir } : {}),
    });
    const compositions = await listCompositions(serveUrl, {
      allowNetwork: input.allowNetwork,
      ...(input.browserExecutable ? { browserExecutable: input.browserExecutable } : {}),
    });
    sendMessage({ kind: "list-compositions", compositions });
    return;
  }

  if (input.kind === "render") {
    const startedAt = Date.now();
    const serveUrl = await bundleProject(input.job.entryPoint, {
      allowNetwork: input.allowNetwork,
      ...(input.browserExecutable ? { browserExecutable: input.browserExecutable } : {}),
      ...(input.cacheDir ? { cacheDir: input.cacheDir } : {}),
    });
    if (input.job.kind === "video") {
      await renderVideo(input.job, serveUrl, input.outputPath, {
        allowNetwork: input.allowNetwork,
        ...(input.browserExecutable ? { browserExecutable: input.browserExecutable } : {}),
      });
    } else {
      await renderStill(input.job, serveUrl, input.outputPath, {
        allowNetwork: input.allowNetwork,
        ...(input.browserExecutable ? { browserExecutable: input.browserExecutable } : {}),
      });
    }
    const { statSync } = await import("node:fs");
    const size = statSync(input.outputPath).size;
    sendMessage({
      kind: "render-complete",
      outputPath: input.outputPath,
      sizeBytes: size,
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  throw new Error(`unknown worker input kind: ${(input as { kind: string }).kind}`);
}

run().then(
  () => {
    process.exit(0);
  },
  (err) => {
    sendMessage({
      kind: "worker-error",
      message: err instanceof Error ? err.message : String(err),
      ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
    });
    process.exit(1);
  },
);
