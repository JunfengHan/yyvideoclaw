// extensions/remotion-ai/src/workspace.ts
//
// Allocate and populate an AI workspace under the effective output root.
// This module is the SOLE writer of `<outputRoot>/<jobId>/` — orchestrator
// and skills-vendor only read it after `prepareWorkspace` resolves.
//
// Security:
//   - The output root MUST exist or be creatable. We never write outside it.
//   - The output root is canonicalised; the jobId is opaque (UUID) so it
//     cannot escape via "..".
//   - When `outputRootAllowlist` is configured, the output root must lie
//     inside one of the allowlist entries (path-separator-boundary check).
//     `defaultOutputRoot` is always implicitly allowed regardless of the
//     allowlist so users never have to configure their own library root.
//   - The final workspace has a `.remotion-ai/job.json` sidecar carrying
//     the user's prompt + creation metadata. The Library view uses it as
//     the source of truth for "what was this job about".

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "output-root-not-allowed"
      | "output-root-resolve-failed"
      | "starter-missing"
      | "job-id-invalid"
      | "workspace-collision",
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

const JOB_ID_RE = /^[a-zA-Z0-9_-]{6,64}$/u;

export interface PrepareWorkspaceParams {
  readonly jobId: string;
  readonly outputRoot: string;
  /**
   * Plugin-managed default library root. Always implicitly allowed,
   * regardless of the caller's `outputRootAllowlist`. In practice the
   * orchestrator passes this in so the "no allowlist configured"
   * experience just works.
   */
  readonly defaultOutputRoot: string;
  readonly outputRootAllowlist: readonly string[] | undefined;
  readonly starterDir: string;
  /** Full user prompt; written verbatim to `.remotion-ai/job.json`. */
  readonly prompt: string;
  /** Engine id recorded in the sidecar for library filtering. */
  readonly engine: string;
  /** ms-since-epoch used as the job's canonical `createdAt`. */
  readonly createdAt: number;
}

export interface PreparedWorkspace {
  readonly workspaceDir: string;
  readonly entryPointRelative: string;
  readonly cacheDir: string;
  /**
   * SHA-256 of the starter's `src/Root.tsx` immediately after copying it
   * into the workspace. The orchestrator uses this as a tripwire: if the
   * file's hash is unchanged after the agent attempt, the agent didn't
   * actually author anything and we'd otherwise ship a placeholder video.
   * Empty string when the starter doesn't include a `src/Root.tsx`
   * (today's starter always does, but the field stays optional in spirit).
   */
  readonly starterRootHash: string;
}

/** Sidecar file path inside a prepared workspace. */
export const JOB_SIDECAR_RELATIVE = path.join(".remotion-ai", "job.json");

/** Schema of `<workspaceDir>/.remotion-ai/job.json`. Stable across M1 — the
 *  Library route reads this and the UI surfaces its fields. */
export interface JobSidecar {
  readonly jobId: string;
  readonly prompt: string;
  readonly promptPreview: string;
  readonly engine: string;
  readonly createdAt: number;
  readonly starter: { readonly source: string };
  readonly schemaVersion: 1;
  /**
   * Absolute path to the rendered mp4 inside the workspace. Optional —
   * populated by the orchestrator's video pass; pre-M2 sidecars and
   * crashed jobs simply omit it.
   */
  readonly videoOutputPath?: string;
}

const STARTER_REQUIRED_FILES = ["package.json", "src/index.ts", "src/Root.tsx"] as const;
const STARTER_OPTIONAL_DIRS = [".skills"] as const;

/**
 * Resolve + validate the output root, create `<outputRoot>/<jobId>/`, copy
 * the starter template into it, then write the `.remotion-ai/job.json`
 * sidecar. Returns absolute paths the orchestrator threads through to the
 * engine and validator.
 */
export async function prepareWorkspace(params: PrepareWorkspaceParams): Promise<PreparedWorkspace> {
  if (!JOB_ID_RE.test(params.jobId)) {
    throw new WorkspaceError(
      `jobId must match ${JOB_ID_RE.source}; got "${params.jobId}"`,
      "job-id-invalid",
    );
  }

  const canonicalOutputRoot = await canonicaliseOutputRoot(params.outputRoot);
  const canonicalDefaultRoot = await canonicaliseOutputRoot(params.defaultOutputRoot);
  await assertWithinAllowlist(
    canonicalOutputRoot,
    params.outputRootAllowlist,
    canonicalDefaultRoot,
  );

  const workspaceDir = path.join(canonicalOutputRoot, params.jobId);
  if (await pathExists(workspaceDir)) {
    throw new WorkspaceError(
      `workspace already exists at ${workspaceDir}; pick a fresh jobId`,
      "workspace-collision",
    );
  }

  await assertStarterValid(params.starterDir);

  await fs.mkdir(workspaceDir, { recursive: true });
  await copyDirectory(params.starterDir, workspaceDir);
  const starterRootHash = await hashFileQuiet(path.join(workspaceDir, "src", "Root.tsx"));
  await writeJobSidecar(workspaceDir, {
    jobId: params.jobId,
    prompt: params.prompt,
    promptPreview: buildPromptPreview(params.prompt),
    engine: params.engine,
    createdAt: params.createdAt,
    starter: { source: params.starterDir },
    schemaVersion: 1,
  });

  return {
    workspaceDir,
    entryPointRelative: "src/index.ts",
    cacheDir: path.join(workspaceDir, ".cache", "remotion-ai"),
    starterRootHash,
  };
}

/**
 * SHA-256 the file at `target`. Returns "" on any error (file missing,
 * permission denied, IO blip). The orchestrator's tripwire treats the
 * empty hash as "can't tell" and skips the unchanged-files check rather
 * than producing a false positive.
 */
export async function hashFileQuiet(target: string): Promise<string> {
  try {
    const buf = await fs.readFile(target);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return "";
  }
}

/** Best-effort cleanup. Used by orchestrator on terminal failure / cancel. */
export async function disposeWorkspace(workspaceDir: string): Promise<void> {
  try {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  } catch {
    // Cleanup is best-effort; never throw from the cleanup path.
  }
}

/** Read the sidecar from a prepared workspace. Returns `null` if missing /
 *  unreadable / schema mismatch — the Library route degrades gracefully. */
export async function readJobSidecar(workspaceDir: string): Promise<JobSidecar | null> {
  const file = path.join(workspaceDir, JOB_SIDECAR_RELATIVE);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<JobSidecar>;
    if (
      !parsed ||
      typeof parsed.jobId !== "string" ||
      typeof parsed.prompt !== "string" ||
      typeof parsed.engine !== "string" ||
      typeof parsed.createdAt !== "number" ||
      parsed.schemaVersion !== 1
    ) {
      return null;
    }
    return {
      jobId: parsed.jobId,
      prompt: parsed.prompt,
      promptPreview:
        typeof parsed.promptPreview === "string"
          ? parsed.promptPreview
          : buildPromptPreview(parsed.prompt),
      engine: parsed.engine,
      createdAt: parsed.createdAt,
      starter: parsed.starter ?? { source: "" },
      schemaVersion: 1,
    };
  } catch {
    return null;
  }
}

async function writeJobSidecar(workspaceDir: string, sidecar: JobSidecar): Promise<void> {
  const dir = path.join(workspaceDir, ".remotion-ai");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "job.json"), JSON.stringify(sidecar, null, 2), "utf8");
}

/**
 * Update the sidecar with the absolute path to the rendered mp4. Called
 * by the orchestrator once the video pass succeeds. Idempotent — if the
 * sidecar is missing (older workspaces, partial cleanup, …) we silently
 * return without throwing so the orchestrator can still mark the job
 * `done`.
 */
export async function writeVideoPathToSidecar(
  workspaceDir: string,
  videoOutputPath: string,
): Promise<void> {
  const existing = await readJobSidecar(workspaceDir);
  if (!existing) {
    return;
  }
  await writeJobSidecar(workspaceDir, { ...existing, videoOutputPath });
}

function buildPromptPreview(prompt: string): string {
  const flat = prompt.replace(/\s+/gu, " ").trim();
  return flat.length <= 160 ? flat : `${flat.slice(0, 157)}…`;
}

async function canonicaliseOutputRoot(outputRoot: string): Promise<string> {
  if (!path.isAbsolute(outputRoot)) {
    throw new WorkspaceError(
      `outputRoot must be an absolute path; got "${outputRoot}"`,
      "output-root-resolve-failed",
    );
  }
  try {
    await fs.mkdir(outputRoot, { recursive: true });
    return await fs.realpath(outputRoot);
  } catch (err) {
    throw new WorkspaceError(
      `failed to resolve outputRoot "${outputRoot}": ${err instanceof Error ? err.message : String(err)}`,
      "output-root-resolve-failed",
    );
  }
}

async function assertWithinAllowlist(
  canonicalOutputRoot: string,
  allowlist: readonly string[] | undefined,
  canonicalDefaultRoot: string,
): Promise<void> {
  // The plugin-managed library root is always allowed — the whole point of
  // Step 1 of M1.5 is that the user doesn't have to configure anything.
  if (isWithin(canonicalDefaultRoot, canonicalOutputRoot)) {
    return;
  }
  if (!allowlist || allowlist.length === 0) {
    // No allowlist AND caller picked something other than the default root.
    // Reject — we don't want surprise writes outside the library unless
    // operators explicitly opted in.
    throw new WorkspaceError(
      `outputRoot "${canonicalOutputRoot}" is not the managed library root; add it to outputRootAllowlist to allow custom locations`,
      "output-root-not-allowed",
    );
  }
  for (const entry of allowlist) {
    let canonicalEntry: string;
    try {
      canonicalEntry = await fs.realpath(entry);
    } catch {
      // Allowlist entry that doesn't exist on disk is silently skipped —
      // operators may pre-list directories that haven't been created yet.
      continue;
    }
    if (isWithin(canonicalEntry, canonicalOutputRoot)) {
      return;
    }
  }
  throw new WorkspaceError(
    `outputRoot "${canonicalOutputRoot}" is not under any configured outputRootAllowlist entry`,
    "output-root-not-allowed",
  );
}

async function assertStarterValid(starterDir: string): Promise<void> {
  if (!path.isAbsolute(starterDir)) {
    throw new WorkspaceError(
      `starterDir must be an absolute path; got "${starterDir}"`,
      "starter-missing",
    );
  }
  for (const required of STARTER_REQUIRED_FILES) {
    const target = path.join(starterDir, required);
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile()) {
        throw new Error("not a regular file");
      }
    } catch (err) {
      throw new WorkspaceError(
        `starter is missing required file "${required}" under "${starterDir}": ${
          err instanceof Error ? err.message : String(err)
        }`,
        "starter-missing",
      );
    }
  }
  // Optional dirs (e.g. .skills/) — checked by skills-vendor when present;
  // workspace.ts is intentionally lenient about whether they exist.
  void STARTER_OPTIONAL_DIRS;
}

function isWithin(parent: string, child: string): boolean {
  if (child === parent) {
    return true;
  }
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursive directory copy. Implemented with `fs.cp` when available
 * (Node ≥ 16.7), falls back to manual walk for older runtimes.
 */
export async function copyDirectory(source: string, destination: string): Promise<void> {
  const cp = (
    fs as { cp?: (src: string, dst: string, opts: { recursive: boolean }) => Promise<void> }
  ).cp;
  if (typeof cp === "function") {
    await cp(source, destination, { recursive: true });
    return;
  }
  await copyDirectoryManual(source, destination);
}

async function copyDirectoryManual(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(source, entry.name);
    const dst = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryManual(src, dst);
    } else if (entry.isFile()) {
      await fs.copyFile(src, dst);
    }
  }
}
