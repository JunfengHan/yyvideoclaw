// Tests for JobsStore.
//
// The store is a bounded LRU keyed by job creation order. The "L" in LRU
// here actually means "least recently *finished*" — running/queued jobs are
// pinned in place. These tests pin down both the happy path and the
// pinning behavior since they're easy to break later.

import { describe, expect, it } from "vitest";
import { JobsStore } from "./jobs-store.js";

let frozenTime = 1_000_000;
const frozenNow = () => new Date(frozenTime);
function advance(ms: number) {
  frozenTime += ms;
}

let counter = 0;
const sequentialId = () => `id-${++counter}`;

function makeStore(capacity = 50) {
  counter = 0;
  frozenTime = 1_000_000;
  return new JobsStore({ capacity, now: frozenNow, newId: sequentialId });
}

describe("JobsStore", () => {
  it("enqueues a job in the queued state", () => {
    const store = makeStore();
    const job = store.enqueue({
      kind: "video",
      request: { entryPoint: "/abs/x", compositionId: "Hello" },
    });
    expect(job.jobId).toBe("id-1");
    expect(job.status).toBe("queued");
    expect(job.enqueuedAt).toBe(new Date(1_000_000).toISOString());
    expect(store.size()).toBe(1);
  });

  it("transitions queued → running → done", () => {
    const store = makeStore();
    const j = store.enqueue({ kind: "video", request: { entryPoint: "/x", compositionId: "Y" } });
    advance(50);
    const running = store.markRunning(j.jobId);
    expect(running?.status).toBe("running");
    expect(running?.startedAt).toBe(new Date(1_000_050).toISOString());
    advance(2000);
    const done = store.markDone(j.jobId, {
      outputPath: "/out/j.mp4",
      sizeBytes: 12345,
      durationMs: 1900,
    });
    expect(done?.status).toBe("done");
    expect(done?.outputPath).toBe("/out/j.mp4");
    expect(done?.sizeBytes).toBe(12345);
    expect(done?.durationMs).toBe(1900);
    expect(done?.finishedAt).toBe(new Date(1_002_050).toISOString());
  });

  it("markRunning is a no-op once the job is already running", () => {
    const store = makeStore();
    const j = store.enqueue({ kind: "video", request: { entryPoint: "/x" } });
    store.markRunning(j.jobId);
    advance(100);
    const second = store.markRunning(j.jobId);
    // startedAt must NOT be overwritten on re-mark
    expect(second?.startedAt).toBe(new Date(1_000_000).toISOString());
  });

  it("records errors and exposes them on the snapshot", () => {
    const store = makeStore();
    const j = store.enqueue({ kind: "still", request: { entryPoint: "/x", compositionId: "Y" } });
    store.markRunning(j.jobId);
    const err = store.markError(j.jobId, "timeout");
    expect(err?.status).toBe("error");
    expect(err?.error).toBe("timeout");
  });

  it("cancels in-flight jobs but is idempotent on terminal jobs", () => {
    const store = makeStore();
    const a = store.enqueue({ kind: "video", request: { entryPoint: "/x" } });
    const b = store.enqueue({ kind: "video", request: { entryPoint: "/x" } });
    store.markRunning(a.jobId);
    expect(store.markCancelled(a.jobId)?.status).toBe("cancelled");
    // Already-done jobs should not be flipped to cancelled
    store.markDone(b.jobId, { outputPath: "/x", sizeBytes: 1, durationMs: 1 });
    expect(store.markCancelled(b.jobId)?.status).toBe("done");
  });

  it("lists jobs newest-first", () => {
    const store = makeStore();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(store.enqueue({ kind: "video", request: { entryPoint: "/x" } }).jobId);
      advance(10);
    }
    const list = store.list();
    expect(list.map((j) => j.jobId)).toEqual(ids.toReversed());
  });

  it("respects an externally-provided jobId (e.g. from allocateJobOutput)", () => {
    const store = makeStore();
    const j = store.enqueue({
      kind: "video",
      jobId: "external-uuid",
      request: { entryPoint: "/x" },
    });
    expect(j.jobId).toBe("external-uuid");
    expect(store.get("external-uuid")?.status).toBe("queued");
  });

  it("respects capacity by evicting oldest TERMINAL jobs first", () => {
    const store = makeStore(3);
    // Fill with done jobs
    for (let i = 0; i < 3; i++) {
      const j = store.enqueue({ kind: "video", request: { entryPoint: "/x" } });
      store.markDone(j.jobId, { outputPath: "/o", sizeBytes: 1, durationMs: 1 });
    }
    expect(store.size()).toBe(3);
    // Adding a 4th should evict the oldest (id-1)
    const fourth = store.enqueue({ kind: "video", request: { entryPoint: "/x" } });
    expect(store.size()).toBe(3);
    expect(store.get("id-1")).toBeUndefined();
    expect(store.get(fourth.jobId)).toBeDefined();
  });

  it("does NOT evict in-flight jobs even when capacity is exceeded", () => {
    const store = makeStore(2);
    // Two running jobs (impossible in practice with concurrency=1 queue, but
    // a render + an extract-schema job can both be in-flight simultaneously)
    const running1 = store.enqueue({ kind: "video", request: { entryPoint: "/x" } });
    store.markRunning(running1.jobId);
    const running2 = store.enqueue({ kind: "list", request: { entryPoint: "/x" } });
    store.markRunning(running2.jobId);
    // A third enqueue can't evict either running job — capacity gives way
    const queued = store.enqueue({ kind: "still", request: { entryPoint: "/x" } });
    expect(store.size()).toBe(3); // exceeded, but no in-flight job lost
    expect(store.get(running1.jobId)).toBeDefined();
    expect(store.get(running2.jobId)).toBeDefined();
    expect(store.get(queued.jobId)).toBeDefined();
    // Once one finishes, the next enqueue can evict it
    store.markDone(running1.jobId, { outputPath: "/o", sizeBytes: 1, durationMs: 1 });
    store.enqueue({ kind: "video", request: { entryPoint: "/x" } });
    // Now size should drop back to capacity
    expect(store.size()).toBe(3);
    expect(store.get(running1.jobId)).toBeUndefined();
  });
});
