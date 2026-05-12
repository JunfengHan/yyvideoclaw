import { describe, expect, it } from "vitest";
import { JobsStore } from "./jobs-store.js";
import type { JobEvent } from "./types.js";

function fixedNow(): () => number {
  let counter = 1_000;
  return () => {
    counter += 1;
    return counter;
  };
}

describe("JobsStore", () => {
  it("enqueues a snapshot in the queued phase with createdAt/updatedAt populated", () => {
    const store = new JobsStore({ now: fixedNow(), newId: () => "fixed-id" });
    const snap = store.enqueue({ jobId: "j1", engine: "codex", workspaceDir: "/ws" });
    expect(snap.jobId).toBe("j1");
    expect(snap.phase).toBe("queued");
    expect(snap.engine).toBe("codex");
    expect(snap.retryCount).toBe(0);
    expect(snap.workspaceDir).toBe("/ws");
    expect(snap.createdAt).toBeGreaterThan(0);
    expect(snap.updatedAt).toBe(snap.createdAt);
  });

  it("uses the default newId when no jobId is provided", () => {
    let n = 0;
    const store = new JobsStore({ newId: () => `gen-${++n}` });
    const a = store.enqueue({ engine: "codex", workspaceDir: "/a" });
    const b = store.enqueue({ engine: "codex", workspaceDir: "/b" });
    expect(a.jobId).toBe("gen-1");
    expect(b.jobId).toBe("gen-2");
  });

  it("update() patches the snapshot and emits a phase event on phase changes", () => {
    const store = new JobsStore({ now: fixedNow() });
    store.enqueue({ jobId: "j1", engine: "codex", workspaceDir: "/ws" });
    const events: JobEvent[] = [];
    store.subscribeAll((e) => events.push(e));
    const updated = store.update("j1", { phase: "agent", workspaceDir: "/ws" });
    expect(updated?.phase).toBe("agent");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "phase", phase: "agent", jobId: "j1" });
  });

  it("update() does not emit a phase event when the phase is unchanged", () => {
    const store = new JobsStore();
    store.enqueue({ jobId: "j1", engine: "codex", workspaceDir: "/ws" });
    const events: JobEvent[] = [];
    store.subscribeAll((e) => events.push(e));
    store.update("j1", { workspaceDir: "/ws-2" });
    // The phase did not change, so no synthesized phase event.
    expect(events.filter((e) => e.type === "phase")).toHaveLength(0);
  });

  it("subscribe() delivers the replay buffer first, then live events", () => {
    const store = new JobsStore();
    store.enqueue({ jobId: "j1", engine: "codex", workspaceDir: "/ws" });
    store.emit({ type: "engine_message", jobId: "j1", text: "hello", at: 1 });
    store.emit({ type: "engine_message", jobId: "j1", text: "world", at: 2 });
    const seen: JobEvent[] = [];
    const dispose = store.subscribe("j1", (e) => seen.push(e));
    expect(seen).toHaveLength(2);
    expect(seen.map((e) => (e.type === "engine_message" ? e.text : ""))).toEqual([
      "hello",
      "world",
    ]);
    store.emit({ type: "engine_message", jobId: "j1", text: "live", at: 3 });
    expect(seen).toHaveLength(3);
    dispose();
    store.emit({ type: "engine_message", jobId: "j1", text: "after-dispose", at: 4 });
    expect(seen).toHaveLength(3);
  });

  it("subscribe() ignores events for other jobs", () => {
    const store = new JobsStore();
    store.enqueue({ jobId: "j1", engine: "codex", workspaceDir: "/a" });
    store.enqueue({ jobId: "j2", engine: "codex", workspaceDir: "/b" });
    const j1Events: JobEvent[] = [];
    store.subscribe("j1", (e) => j1Events.push(e));
    store.emit({ type: "engine_message", jobId: "j2", text: "for j2", at: 1 });
    expect(j1Events).toHaveLength(0);
  });

  it("subscribe() unsubscribes when the job reaches a terminal phase", () => {
    const store = new JobsStore();
    store.enqueue({ jobId: "j1", engine: "codex", workspaceDir: "/ws" });
    let subscriberCount = 0;
    const dispose = store.subscribe("j1", () => {
      subscriberCount += 1;
    });
    store.update("j1", { phase: "done" });
    // The terminal phase emits one final phase event before the store
    // drops the subscriber set.
    expect(subscriberCount).toBe(1);
    // After the terminal transition, additional events should NOT reach
    // the subscriber.
    store.emit({ type: "engine_message", jobId: "j1", text: "stale", at: 99 });
    expect(subscriberCount).toBe(1);
    dispose();
  });

  it("evicts terminal entries first when capacity is exceeded", () => {
    const store = new JobsStore({ capacity: 2 });
    store.enqueue({ jobId: "j1", engine: "codex", workspaceDir: "/a" });
    store.enqueue({ jobId: "j2", engine: "codex", workspaceDir: "/b" });
    store.update("j1", { phase: "done" });
    store.update("j2", { phase: "done" });
    store.enqueue({ jobId: "j3", engine: "codex", workspaceDir: "/c" });
    // Terminal entries are eligible for eviction; oldest terminal first.
    expect(store.get("j1")).toBeUndefined();
    expect(store.get("j2")).toBeDefined();
    expect(store.get("j3")).toBeDefined();
  });

  it("never evicts an in-flight job even when the cap is exceeded", () => {
    const store = new JobsStore({ capacity: 1 });
    store.enqueue({ jobId: "j1", engine: "codex", workspaceDir: "/a" });
    // j1 is queued (in-flight). Adding j2 must NOT evict j1.
    store.enqueue({ jobId: "j2", engine: "codex", workspaceDir: "/b" });
    expect(store.get("j1")).toBeDefined();
    expect(store.get("j2")).toBeDefined();
    expect(store.size()).toBe(2); // exceeds capacity intentionally
  });

  it("list() returns newest-first up to limit", () => {
    const store = new JobsStore();
    for (let i = 0; i < 5; i += 1) {
      store.enqueue({ jobId: `job-${i}`, engine: "codex", workspaceDir: `/w/${i}` });
    }
    const recent = store.list(3);
    expect(recent.map((s) => s.jobId)).toEqual(["job-4", "job-3", "job-2"]);
  });
});
