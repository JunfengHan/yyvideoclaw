// In-memory bounded job store.
//
// Tracks every render job triggered through the HTTP routes. The agent-tool
// path doesn't go through this store; it uses RenderQueue directly and
// returns the result synchronously. The HTTP routes need an async polling
// model (POST /render returns a jobId; GET /jobs/:id polls), so we record a
// snapshot per job and let it be queried.
//
// Bounded: keeps the most recent `capacity` entries (default 50). Oldest
// finished/cancelled jobs are evicted first; running jobs are never
// evicted while in-flight (they're pinned via `pinned`).
//
// Single-process; not persisted across plugin reloads. Acceptable for v1
// (matches video-studio behavior).

import { randomUUID } from "node:crypto";

export type JobKind = "video" | "still" | "list";

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface JobRequestSummary {
  entryPoint: string;
  compositionId?: string;
  /**
   * Already-redacted summary of inputProps suitable for storage / logs.
   * The full inputProps live only inside the worker process.
   */
  inputPropsSummary?: { keys: string[]; sizeBytes: number };
}

export interface JobSnapshot {
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** Absolute path on disk (durable copy). */
  outputPath?: string;
  /** Path inside ~/.openclaw/media/outbound/ if media library registration succeeded. */
  mediaLibraryPath?: string;
  sizeBytes?: number;
  /** Sanitised error message; never contains full paths outside templateRoots. */
  error?: string;
  request: JobRequestSummary;
}

export interface JobsStoreOptions {
  capacity?: number;
  /** Injected for deterministic tests. */
  now?: () => Date;
  /** Injected for deterministic tests. */
  newId?: () => string;
}

const DEFAULT_CAPACITY = 50;

/**
 * Bounded LRU-by-completion store. All mutating methods are synchronous; the
 * store does NOT do its own locking — the caller (single-instance plugin) is
 * responsible for ordering. Ordering is naturally serial because the
 * underlying RenderQueue runs concurrency=1, but list/extract jobs CAN run
 * in parallel with renders. Keep methods cheap and idempotent.
 */
export class JobsStore {
  private readonly capacity: number;
  private readonly now: () => Date;
  private readonly newId: () => string;
  /** Keyed by jobId, insertion-ordered (Map iteration order). */
  private readonly jobs = new Map<string, JobSnapshot>();

  constructor(opts: JobsStoreOptions = {}) {
    this.capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY);
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => randomUUID());
  }

  enqueue(params: {
    kind: JobKind;
    request: JobRequestSummary;
    /**
     * Optional caller-provided jobId. Pass this to keep the in-memory store
     * keyed identically to the on-disk allocation in `allocateJobOutput()`.
     * When omitted a UUID is generated (handy in tests).
     */
    jobId?: string;
  }): JobSnapshot {
    const job: JobSnapshot = {
      jobId: params.jobId ?? this.newId(),
      kind: params.kind,
      status: "queued",
      enqueuedAt: this.now().toISOString(),
      request: params.request,
    };
    this.jobs.set(job.jobId, job);
    this.evictIfNeeded();
    return job;
  }

  markRunning(jobId: string): JobSnapshot | undefined {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "queued") {
      return job;
    }
    const updated: JobSnapshot = {
      ...job,
      status: "running",
      startedAt: this.now().toISOString(),
    };
    this.jobs.set(jobId, updated);
    return updated;
  }

  markDone(
    jobId: string,
    payload: {
      outputPath: string;
      sizeBytes: number;
      durationMs: number;
      mediaLibraryPath?: string;
    },
  ): JobSnapshot | undefined {
    const job = this.jobs.get(jobId);
    if (!job) {
      return undefined;
    }
    const updated: JobSnapshot = {
      ...job,
      status: "done",
      finishedAt: this.now().toISOString(),
      durationMs: payload.durationMs,
      outputPath: payload.outputPath,
      sizeBytes: payload.sizeBytes,
      ...(payload.mediaLibraryPath ? { mediaLibraryPath: payload.mediaLibraryPath } : {}),
    };
    this.jobs.set(jobId, updated);
    this.evictIfNeeded();
    return updated;
  }

  markError(jobId: string, error: string): JobSnapshot | undefined {
    const job = this.jobs.get(jobId);
    if (!job) {
      return undefined;
    }
    const updated: JobSnapshot = {
      ...job,
      status: "error",
      finishedAt: this.now().toISOString(),
      error,
    };
    this.jobs.set(jobId, updated);
    this.evictIfNeeded();
    return updated;
  }

  markCancelled(jobId: string): JobSnapshot | undefined {
    const job = this.jobs.get(jobId);
    if (!job) {
      return undefined;
    }
    if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
      return job;
    }
    const updated: JobSnapshot = {
      ...job,
      status: "cancelled",
      finishedAt: this.now().toISOString(),
    };
    this.jobs.set(jobId, updated);
    this.evictIfNeeded();
    return updated;
  }

  get(jobId: string): JobSnapshot | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Return up to `limit` most-recent jobs, newest first.
   *
   * "Recent" is measured by enqueue time. We don't sort by finishedAt because
   * an in-flight job with no finishedAt should still appear at the top.
   */
  list(limit = 20): JobSnapshot[] {
    const arr = Array.from(this.jobs.values()).toReversed();
    return arr.slice(0, Math.max(0, limit));
  }

  size(): number {
    return this.jobs.size;
  }

  private evictIfNeeded(): void {
    while (this.jobs.size > this.capacity) {
      // Find the OLDEST entry that is in a terminal state. If none exists
      // (all running/queued), accept exceeding capacity rather than
      // dropping in-flight work.
      let evicted = false;
      for (const [id, job] of this.jobs) {
        if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
          this.jobs.delete(id);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        return;
      }
    }
  }
}
