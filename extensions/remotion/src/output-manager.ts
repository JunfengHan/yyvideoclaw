// Output directory & artifact management.
//
// Every render job gets its own subdirectory under `config.outputDir`. All
// writes are confined to that subdirectory; the rest of the plugin never
// touches paths outside it, which keeps the blast radius of a buggy render
// contained.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { RemotionPluginConfig } from "./types.js";

export interface OutputAllocation {
  jobId: string;
  jobDir: string;
  outputPath: string;
  fileUrl: string;
}

export class OutputError extends Error {
  constructor(
    message: string,
    readonly code: "too-large" | "missing" | "not-a-file",
  ) {
    super(message);
    this.name = "OutputError";
  }
}

export async function allocateJobOutput(
  config: RemotionPluginConfig,
  extension: "mp4" | "png" | "jpeg",
): Promise<OutputAllocation> {
  await fs.mkdir(config.outputDir, { recursive: true });
  const jobId = randomUUID();
  const jobDir = path.join(config.outputDir, jobId);
  await fs.mkdir(jobDir, { recursive: true });
  const outputPath = path.join(jobDir, `out.${extension}`);
  return {
    jobId,
    jobDir,
    outputPath,
    fileUrl: pathToFileUrl(outputPath),
  };
}

/**
 * Verify the rendered artifact exists, is a regular file, and does not exceed
 * `maxOutputBytes`. On violation, delete the partial artifact and throw.
 */
export async function verifyAndMeasure(
  outputPath: string,
  maxOutputBytes: number,
): Promise<number> {
  let stat;
  try {
    stat = await fs.stat(outputPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OutputError(`render produced no output at ${outputPath}`, "missing");
    }
    throw err;
  }
  if (!stat.isFile()) {
    throw new OutputError(`expected a regular file at ${outputPath}`, "not-a-file");
  }
  if (stat.size > maxOutputBytes) {
    await fs.rm(outputPath, { force: true });
    throw new OutputError(
      `output size ${stat.size} exceeds configured maxOutputBytes ${maxOutputBytes}`,
      "too-large",
    );
  }
  return stat.size;
}

/** Best-effort cleanup of a job directory. Never throws. */
export async function cleanupJobDir(jobDir: string): Promise<void> {
  try {
    await fs.rm(jobDir, { recursive: true, force: true });
  } catch {
    // Intentional: cleanup is best-effort.
  }
}

function pathToFileUrl(p: string): string {
  const normalized = path.resolve(p).replace(/\\/g, "/");
  const prefix = normalized.startsWith("/") ? "file://" : "file:///";
  return `${prefix}${encodeURI(normalized)}`;
}
