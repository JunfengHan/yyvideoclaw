// extensions/remotion-ai/src/jobs-store.ts
//
// Bounded LRU job store with SSE subscription dispatch.
//
// Differs from `extensions/remotion/src/server/jobs-store.ts`:
//   - The remotion-ai snapshot is keyed by `phase` (not `status`) and adds
//     `engine` / `retryCount` / `compositionId` / `stillPath` fields so the
//     UI can render the AI Create progress without a parallel store.
//   - Live subscribers receive every `JobEvent` as it's emitted; the store
//     is the multiplexer between orchestrator producers and HTTP/SSE
//     consumers.
//   - In-flight jobs (`queued` / `workspace` / `skills` / `agent` / `bundle` /
//     `select` / `still` / `retry`) are pinned against eviction.

import { randomUUID } from "node:crypto";
import type { JobEvent, JobSnapshot, Phase } from "./types.js";

export interface JobsStoreOptions {
  readonly capacity?: number;
  readonly now?: () => number;
  readonly newId?: () => string;
}

const DEFAULT_CAPACITY = 50;

const TERMINAL_PHASES = new Set<Phase>(["done", "failed", "cancelled"]);

type Subscriber = (event: JobEvent) => void;

export class JobsStore {
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly jobs = new Map<string, JobSnapshot>();
  private readonly perJobSubscribers = new Map<string, Set<Subscriber>>();
  private readonly globalSubscribers = new Set<Subscriber>();
  private readonly recentEvents = new Map<string, JobEvent[]>();

  constructor(opts: JobsStoreOptions = {}) {
    this.capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY);
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? (() => randomUUID());
  }

  /**
   * Create a new snapshot in `phase=queued`. Pinned against eviction until
   * a terminal phase transition is recorded.
   */
  enqueue(params: {
    readonly jobId?: string;
    readonly engine: JobSnapshot["engine"];
    readonly workspaceDir: string;
    readonly promptPreview?: string;
  }): JobSnapshot {
    const now = this.now();
    const jobId = params.jobId ?? this.newId();
    const snapshot: JobSnapshot = {
      jobId,
      phase: "queued",
      retryCount: 0,
      workspaceDir: params.workspaceDir,
      engine: params.engine,
      createdAt: now,
      updatedAt: now,
      ...(params.promptPreview !== undefined ? { promptPreview: params.promptPreview } : {}),
    };
    this.jobs.set(jobId, snapshot);
    this.evictIfNeeded();
    return snapshot;
  }

  /** Look up a snapshot. Returns the latest version. */
  get(jobId: string): JobSnapshot | undefined {
    return this.jobs.get(jobId);
  }

  /** Most-recent snapshots (newest first). */
  list(limit = 20): JobSnapshot[] {
    const arr = Array.from(this.jobs.values()).toReversed();
    return arr.slice(0, Math.max(0, limit));
  }

  size(): number {
    return this.jobs.size;
  }

  /**
   * Apply a partial update to the snapshot AND emit any synthesized
   * JobEvents (phase transitions; the orchestrator emits engine/validation
   * events directly via `emit`).
   */
  update(
    jobId: string,
    patch: Partial<Omit<JobSnapshot, "jobId" | "createdAt">>,
  ): JobSnapshot | undefined {
    const current = this.jobs.get(jobId);
    if (!current) {
      return undefined;
    }
    const now = this.now();
    const next: JobSnapshot = {
      ...current,
      ...patch,
      jobId: current.jobId,
      createdAt: current.createdAt,
      updatedAt: now,
    };
    this.jobs.set(jobId, next);
    if (patch.phase && patch.phase !== current.phase) {
      this.emit({ type: "phase", jobId, phase: patch.phase, at: now });
    }
    if (TERMINAL_PHASES.has(next.phase)) {
      this.evictIfNeeded();
      // Settle subscribers: emit a final phase event already fired above,
      // then drop the per-job subscriber set so reconnects after a job
      // finishes can still read the snapshot via `get(jobId)` but won't
      // hang waiting for new events.
      const subs = this.perJobSubscribers.get(jobId);
      if (subs) {
        this.perJobSubscribers.delete(jobId);
        // Notify any remaining subscribers that the stream is over by
        // sending a synthetic terminal phase. We don't define a separate
        // `closed` event because the SSE handler already disconnects on
        // terminal phases.
      }
    }
    return next;
  }

  /**
   * Emit an event to all subscribers (per-job + global). The event is also
   * recorded in a small per-job replay buffer so SSE clients that connect
   * mid-job receive recent context immediately.
   */
  emit(event: JobEvent): void {
    const buffer = this.recentEvents.get(event.jobId) ?? [];
    buffer.push(event);
    while (buffer.length > 64) {
      buffer.shift();
    }
    this.recentEvents.set(event.jobId, buffer);
    const subs = this.perJobSubscribers.get(event.jobId);
    if (subs) {
      for (const sub of subs) {
        try {
          sub(event);
        } catch {
          // Subscribers must not be allowed to break event delivery.
        }
      }
    }
    for (const sub of this.globalSubscribers) {
      try {
        sub(event);
      } catch {
        // Same as above.
      }
    }
  }

  /**
   * Subscribe to events for a specific job. Returns a disposer that
   * removes the subscription. The replay buffer is delivered synchronously
   * before the disposer is returned so SSE handlers can hydrate the client
   * mid-stream.
   */
  subscribe(jobId: string, subscriber: Subscriber): () => void {
    const buffered = this.recentEvents.get(jobId);
    if (buffered) {
      for (const event of buffered) {
        try {
          subscriber(event);
        } catch {
          // Ignore — caller's bug.
        }
      }
    }
    let set = this.perJobSubscribers.get(jobId);
    if (!set) {
      set = new Set<Subscriber>();
      this.perJobSubscribers.set(jobId, set);
    }
    set.add(subscriber);
    return () => {
      const current = this.perJobSubscribers.get(jobId);
      current?.delete(subscriber);
      if (current && current.size === 0) {
        this.perJobSubscribers.delete(jobId);
      }
    };
  }

  /** Subscribe to ALL events (used by tests / future global telemetry). */
  subscribeAll(subscriber: Subscriber): () => void {
    this.globalSubscribers.add(subscriber);
    return () => {
      this.globalSubscribers.delete(subscriber);
    };
  }

  /**
   * Drop the per-job replay buffer once the orchestrator is sure no more
   * subscribers will arrive. Optional cleanup hook used after the
   * job has been terminal for a while.
   */
  forgetEvents(jobId: string): void {
    this.recentEvents.delete(jobId);
  }

  private evictIfNeeded(): void {
    while (this.jobs.size > this.capacity) {
      let evicted = false;
      for (const [id, snapshot] of this.jobs) {
        if (TERMINAL_PHASES.has(snapshot.phase)) {
          this.jobs.delete(id);
          this.recentEvents.delete(id);
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
