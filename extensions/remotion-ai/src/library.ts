// extensions/remotion-ai/src/library.ts
//
// "Library" — the set of previously generated AI workspaces on disk. It's
// the source of truth for the Library view in the UI; the in-memory
// `JobsStore` is strictly a liveness / SSE multiplexer and gets evicted /
// wiped on gateway restart.
//
// Contract:
//   - The library root is `config.defaultOutputRoot`. Its direct children
//     are job workspaces (a sidecar `<jobId>/.remotion-ai/job.json` is
//     expected — entries without it are ignored so users can drop any
//     other folder in the root without us complaining).
//   - Every entry resolves to a canonical path *inside* the library root;
//     if canonicalisation leaves the root (symlink trap) the entry is
//     skipped.
//   - Deletion is safe-by-default: we only delete a directory whose
//     realpath is strictly under the library root AND whose name matches
//     the jobId regex AND which currently has a valid sidecar. This is
//     defence-in-depth against typos in the `jobId` path segment.

import { promises as fs } from "node:fs";
import path from "node:path";
import { JOB_SIDECAR_RELATIVE, readJobSidecar, type JobSidecar } from "./workspace.js";

const JOB_ID_RE = /^[a-zA-Z0-9_-]{6,64}$/u;

/** Wire shape returned by `GET /remotion-ai/library`. */
export interface LibraryEntry {
  readonly jobId: string;
  readonly workspaceDir: string;
  readonly prompt: string;
  readonly promptPreview: string;
  readonly engine: string;
  readonly createdAt: number;
  /** Mtime of the workspace — proxy for "last activity" / sort key. */
  readonly updatedAt: number;
  readonly entryPointAbsolute: string;
  /**
   * Whether this workspace currently looks renderable (has both
   * `src/index.ts` and `src/Root.tsx`). Used by the UI to grey out broken
   * entries without removing them from the list.
   */
  readonly renderable: boolean;
  /** Best-effort size in bytes of the workspace directory. */
  readonly sizeBytes: number | null;
}

export interface ListLibraryOptions {
  /** Absolute path of the plugin-managed library root. */
  readonly libraryRoot: string;
  /** Optional: exclude jobs whose jobId matches any of these. Used to
   *  avoid duplicating currently-running jobs that also appear in the
   *  live `JobsStore` (caller merges the two). */
  readonly excludeJobIds?: ReadonlySet<string>;
}

export async function listLibrary(options: ListLibraryOptions): Promise<LibraryEntry[]> {
  const { libraryRoot } = options;
  let realRoot: string;
  try {
    await fs.mkdir(libraryRoot, { recursive: true });
    realRoot = await fs.realpath(libraryRoot);
  } catch {
    return [];
  }
  let dirents: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    dirents = await fs.readdir(realRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const excluded = options.excludeJobIds ?? new Set<string>();
  const entries: LibraryEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const name = dirent.name;
    if (!JOB_ID_RE.test(name)) {
      continue;
    }
    if (excluded.has(name)) {
      continue;
    }
    const workspaceDir = path.join(realRoot, name);
    // Canonicalise to defeat symlink traversal: any workspace whose real
    // path leaves the library root is silently skipped.
    let realWorkspace: string;
    try {
      realWorkspace = await fs.realpath(workspaceDir);
    } catch {
      continue;
    }
    if (!isWithin(realRoot, realWorkspace)) {
      continue;
    }
    const sidecar = await readJobSidecar(realWorkspace);
    if (!sidecar) {
      continue;
    }
    const entry = await projectLibraryEntry(realWorkspace, sidecar);
    entries.push(entry);
  }
  // Newest first (by sidecar createdAt). Ties break by updatedAt desc.
  entries.sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt);
  return entries;
}

export interface DeleteLibraryEntryOptions {
  readonly libraryRoot: string;
  readonly jobId: string;
}

export type DeleteLibraryOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid-job-id"
        | "not-found"
        | "outside-library-root"
        | "missing-sidecar"
        | "io-error";
      readonly detail?: string;
    };

/**
 * Delete a single library workspace. Rejects ANY target whose canonical
 * path isn't strictly inside the library root, which removes the entire
 * class of "../../etc/passwd" style tricks even if the jobId is
 * attacker-controlled in a reflection scenario.
 */
export async function deleteLibraryEntry(
  options: DeleteLibraryEntryOptions,
): Promise<DeleteLibraryOutcome> {
  const { libraryRoot, jobId } = options;
  if (!JOB_ID_RE.test(jobId)) {
    return { ok: false, reason: "invalid-job-id" };
  }
  let realRoot: string;
  try {
    realRoot = await fs.realpath(libraryRoot);
  } catch {
    return { ok: false, reason: "not-found" };
  }
  const candidate = path.join(realRoot, jobId);
  let realCandidate: string;
  try {
    realCandidate = await fs.realpath(candidate);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, reason: "not-found" };
    }
    return { ok: false, reason: "io-error", detail: String(err) };
  }
  if (!isWithin(realRoot, realCandidate) || realCandidate === realRoot) {
    return { ok: false, reason: "outside-library-root" };
  }
  const sidecar = await readJobSidecar(realCandidate);
  if (!sidecar) {
    return { ok: false, reason: "missing-sidecar" };
  }
  try {
    await fs.rm(realCandidate, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "io-error", detail: String(err) };
  }
}

async function projectLibraryEntry(
  workspaceDir: string,
  sidecar: JobSidecar,
): Promise<LibraryEntry> {
  const entryPointAbsolute = path.join(workspaceDir, "src", "index.ts");
  const rootAbsolute = path.join(workspaceDir, "src", "Root.tsx");
  const videoCandidate =
    sidecar.videoOutputPath ??
    path.join(workspaceDir, ".cache", "remotion-ai", "validation-still.mp4");
  const [entryStat, rootStat, dirStat, videoStat] = await Promise.all([
    statQuiet(entryPointAbsolute),
    statQuiet(rootAbsolute),
    statQuiet(workspaceDir),
    statQuiet(videoCandidate),
  ]);
  const renderable = Boolean(entryStat?.isFile() && rootStat?.isFile());
  const hasVideo = Boolean(videoStat?.isFile() && videoStat.size > 0);
  const sizeBytes = await directorySizeBytes(workspaceDir);
  return {
    jobId: sidecar.jobId,
    workspaceDir,
    prompt: sidecar.prompt,
    promptPreview: sidecar.promptPreview,
    engine: sidecar.engine,
    createdAt: sidecar.createdAt,
    updatedAt: dirStat?.mtimeMs ?? sidecar.createdAt,
    entryPointAbsolute,
    renderable,
    sizeBytes,
    hasVideo,
  };
}

/**
 * Resolve the absolute mp4 path for a single job, defending against
 * symlink traversal. Returns `null` if the job has no mp4 yet (`hasVideo`
 * is false), the job is missing, or the candidate path canonicalises
 * outside the library root.
 *
 * Used by the streaming endpoint
 * GET `/remotion-ai/library/:jobId/output.mp4` so the route handler can
 * pipe the file back to the browser without trusting any caller-supplied
 * path.
 */
export interface ResolveVideoOutcome {
  readonly absolutePath: string;
  readonly sizeBytes: number;
}

export async function resolveLibraryVideo(options: {
  readonly libraryRoot: string;
  readonly jobId: string;
}): Promise<ResolveVideoOutcome | null> {
  const { libraryRoot, jobId } = options;
  if (!JOB_ID_RE.test(jobId)) {
    return null;
  }
  let realRoot: string;
  try {
    realRoot = await fs.realpath(libraryRoot);
  } catch {
    return null;
  }
  const workspaceDir = path.join(realRoot, jobId);
  let realWorkspace: string;
  try {
    realWorkspace = await fs.realpath(workspaceDir);
  } catch {
    return null;
  }
  if (!isWithin(realRoot, realWorkspace)) {
    return null;
  }
  const sidecar = await readJobSidecar(realWorkspace);
  if (!sidecar) {
    return null;
  }
  // Prefer the path the orchestrator wrote into the sidecar (covers
  // custom output paths). Fall back to the conventional location used by
  // ai-render-worker's video mode.
  const candidate =
    sidecar.videoOutputPath ??
    path.join(realWorkspace, ".cache", "remotion-ai", "validation-still.mp4");
  // Canonicalise the candidate too — defends against the sidecar being
  // tampered with (it is on disk, after all) to point outside the
  // library root.
  let realCandidate: string;
  try {
    realCandidate = await fs.realpath(candidate);
  } catch {
    return null;
  }
  if (!isWithin(realRoot, realCandidate)) {
    return null;
  }
  const stat = await statQuiet(realCandidate);
  if (!stat?.isFile() || stat.size === 0) {
    return null;
  }
  return { absolutePath: realCandidate, sizeBytes: stat.size };
}

async function statQuiet(target: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

async function directorySizeBytes(dir: string): Promise<number | null> {
  // Best-effort, capped so we don't walk massive trees forever. node_modules
  // and .cache are skipped because they'd dominate the total without being
  // user-meaningful.
  const SKIP_DIRS = new Set(["node_modules", ".cache"]);
  const MAX_ENTRIES = 10_000;
  let seen = 0;
  let total = 0;
  async function walk(current: string): Promise<void> {
    if (seen >= MAX_ENTRIES) {
      return;
    }
    let dirents: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      dirents = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (seen >= MAX_ENTRIES) {
        return;
      }
      seen += 1;
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name)) {
          continue;
        }
        await walk(path.join(current, dirent.name));
      } else if (dirent.isFile()) {
        try {
          const stat = await fs.stat(path.join(current, dirent.name));
          total += stat.size;
        } catch {
          // ignore individual file stat errors
        }
      }
    }
  }
  try {
    await walk(dir);
    return total;
  } catch {
    return null;
  }
}

function isWithin(parent: string, child: string): boolean {
  if (child === parent) {
    return false; // deleting the library root itself is explicitly blocked
  }
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

// Used by tests that want to assert sidecar file location without
// re-importing workspace.ts.
export { JOB_SIDECAR_RELATIVE };
