// Unit tests for the Remotion AI controller helpers. We exercise pure
// synchronous helpers + the polling driver against a fake fetch so the
// suite stays deterministic and fast (no real timers / no real network).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REMOTION_AI_DRAFT,
  defaultRemotionAiState,
  isInFlightPhase,
  isTerminalPhase,
  startRemotionAiJobPolling,
  stopAllRemotionAiPolling,
  stopRemotionAiJobPolling,
  updateRemotionAiDraft,
  validateRemotionAiDraft,
  type RemotionAiControllerState,
  type RemotionAiHttpDeps,
  type RemotionAiJobSnapshotWire,
  type RemotionAiPhase,
} from "./remotion-ai.ts";

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

describe("validateRemotionAiDraft", () => {
  it("accepts a draft with a non-empty prompt", () => {
    const result = validateRemotionAiDraft({
      ...DEFAULT_REMOTION_AI_DRAFT,
      prompt: "Make me a 3-second title card",
    });
    expect(result).toEqual({ ok: true });
  });

  it("flags empty prompt", () => {
    const result = validateRemotionAiDraft({
      ...DEFAULT_REMOTION_AI_DRAFT,
      prompt: "   ",
    });
    expect(result).toEqual({ ok: false, reason: "promptRequired" });
  });

  it("does NOT require an output directory (server manages the library root)", () => {
    // Regression: older UIs demanded an absolute outputRoot. M1.5 removed
    // the field so the user never picks a path.
    const draft = { ...DEFAULT_REMOTION_AI_DRAFT, prompt: "x" };
    expect(validateRemotionAiDraft(draft)).toEqual({ ok: true });
    // Only `promptRequired` is a valid failure reason now.
    expect(validateRemotionAiDraft({ ...draft, prompt: "" })).toEqual({
      ok: false,
      reason: "promptRequired",
    });
  });
});

describe("isTerminalPhase / isInFlightPhase", () => {
  const cases: Array<{
    phase: RemotionAiPhase;
    terminal: boolean;
    inFlight: boolean;
  }> = [
    { phase: "queued", terminal: false, inFlight: false },
    { phase: "workspace", terminal: false, inFlight: true },
    { phase: "skills", terminal: false, inFlight: true },
    { phase: "agent", terminal: false, inFlight: true },
    { phase: "bundle", terminal: false, inFlight: true },
    { phase: "select", terminal: false, inFlight: true },
    { phase: "still", terminal: false, inFlight: true },
    { phase: "retry", terminal: false, inFlight: true },
    { phase: "done", terminal: true, inFlight: false },
    { phase: "failed", terminal: true, inFlight: false },
    { phase: "cancelled", terminal: true, inFlight: false },
  ];
  it.each(cases)("phase=$phase terminal=$terminal inFlight=$inFlight", (c) => {
    expect(isTerminalPhase(c.phase)).toBe(c.terminal);
    expect(isInFlightPhase(c.phase)).toBe(c.inFlight);
  });
});

describe("updateRemotionAiDraft", () => {
  it("applies partial patches and replaces the object identity", () => {
    const state = defaultRemotionAiState();
    const before = state.remotionAiDraft;
    updateRemotionAiDraft(state, { prompt: "hello" });
    expect(state.remotionAiDraft.prompt).toBe("hello");
    expect(state.remotionAiDraft.engine).toBe("codex"); // untouched
    expect(state.remotionAiDraft).not.toBe(before);
  });

  it("supports successive patches without losing earlier edits", () => {
    const state = defaultRemotionAiState();
    updateRemotionAiDraft(state, { prompt: "a" });
    updateRemotionAiDraft(state, { outputRoot: "/tmp/ai" });
    updateRemotionAiDraft(state, { retryMax: 5 });
    expect(state.remotionAiDraft).toMatchObject({
      prompt: "a",
      outputRoot: "/tmp/ai",
      retryMax: 5,
    });
  });
});

// ---------------------------------------------------------------------------
// Polling driver.
// ---------------------------------------------------------------------------

describe("startRemotionAiJobPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeFakeFetch(sequence: ReadonlyArray<RemotionAiJobSnapshotWire>): {
    fetchImpl: typeof globalThis.fetch;
    callsRef: { count: number };
  } {
    const callsRef = { count: 0 };
    const fetchImpl: typeof globalThis.fetch = async () => {
      const idx = Math.min(callsRef.count, sequence.length - 1);
      callsRef.count += 1;
      const snapshot = sequence[idx];
      // Server wraps the snapshot in `{ job }` (matches cancel's `{ cancelled, job }`);
      // the controller un-wraps it before handing it to callers.
      return new Response(JSON.stringify({ job: snapshot }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    return { fetchImpl, callsRef };
  }

  function makeSnapshot(overrides: Partial<RemotionAiJobSnapshotWire>): RemotionAiJobSnapshotWire {
    return {
      jobId: "job-1",
      phase: "agent",
      engine: "codex",
      workspaceDir: "/tmp/ai-jobs/job-1",
      enqueuedAt: 1,
      retryCount: 0,
      ...overrides,
    };
  }

  it("delivers an immediate first tick before the interval fires", async () => {
    const { fetchImpl } = makeFakeFetch([
      makeSnapshot({ phase: "agent" }),
      makeSnapshot({ phase: "done" }),
    ]);
    const deps: RemotionAiHttpDeps = { basePath: "", fetchImpl };
    const onUpdate = vi.fn<(s: RemotionAiJobSnapshotWire) => void>();
    const onTerminal = vi.fn<(s: RemotionAiJobSnapshotWire) => void>();

    const handle = startRemotionAiJobPolling(deps, "job-1", { onUpdate, onTerminal }, 500);

    // Drain the immediate first tick (microtasks).
    await vi.runAllTimersAsync();

    // First tick already arrived without the 500ms interval elapsing.
    expect(onUpdate).toHaveBeenCalled();
    clearInterval(handle);
  });

  it("stops on terminal phase and fires onTerminal exactly once", async () => {
    const sequence: RemotionAiJobSnapshotWire[] = [
      makeSnapshot({ phase: "agent" }),
      makeSnapshot({ phase: "validate" }),
      makeSnapshot({ phase: "done" }),
    ];
    const { fetchImpl } = makeFakeFetch(sequence);
    const deps: RemotionAiHttpDeps = { basePath: "", fetchImpl };
    const updates: RemotionAiPhase[] = [];
    const terminals: RemotionAiPhase[] = [];

    const handle = startRemotionAiJobPolling(
      deps,
      "job-1",
      {
        onUpdate: (snap) => updates.push(snap.phase),
        onTerminal: (snap) => terminals.push(snap.phase),
      },
      10,
    );

    // Tick 1 (immediate) + tick 2 (10ms) + tick 3 (20ms): each tick is
    // async and we need micro+macro flushes between them.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(updates).toContain("done");
    expect(terminals).toEqual(["done"]);
    clearInterval(handle); // no-op: interval already cleared by tick code
  });

  it("forwards transient errors via onPollError without stopping the loop", async () => {
    let calls = 0;
    const fetchImpl: typeof globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("oops", { status: 500 });
      }
      return new Response(
        JSON.stringify({
          job: {
            jobId: "job-1",
            phase: "done",
            engine: "codex",
            workspaceDir: "/tmp",
            enqueuedAt: 1,
            retryCount: 0,
          } satisfies RemotionAiJobSnapshotWire,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const deps: RemotionAiHttpDeps = { basePath: "", fetchImpl };
    const onUpdate = vi.fn<(s: RemotionAiJobSnapshotWire) => void>();
    const onPollError = vi.fn<(error: Error) => void>();
    const onTerminal = vi.fn<(s: RemotionAiJobSnapshotWire) => void>();

    const handle = startRemotionAiJobPolling(
      deps,
      "job-1",
      { onUpdate, onTerminal, onPollError },
      10,
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);

    expect(onPollError).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({ phase: "done" }));
    clearInterval(handle);
  });
});

describe("stopRemotionAiJobPolling / stopAllRemotionAiPolling", () => {
  it("stopRemotionAiJobPolling removes the handle from the map and clears the interval", () => {
    const state: RemotionAiControllerState = defaultRemotionAiState();
    const handle = setInterval(() => undefined, 1_000_000);
    state.remotionAiPollHandles.set("job-1", handle);
    stopRemotionAiJobPolling(state, "job-1");
    expect(state.remotionAiPollHandles.size).toBe(0);
  });

  it("stopAllRemotionAiPolling clears every interval", () => {
    const state: RemotionAiControllerState = defaultRemotionAiState();
    state.remotionAiPollHandles.set(
      "a",
      setInterval(() => undefined, 1_000_000),
    );
    state.remotionAiPollHandles.set(
      "b",
      setInterval(() => undefined, 1_000_000),
    );
    stopAllRemotionAiPolling(state);
    expect(state.remotionAiPollHandles.size).toBe(0);
  });
});
