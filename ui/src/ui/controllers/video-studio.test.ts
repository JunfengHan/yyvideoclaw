// Unit tests for the Video Studio controller helpers that can be exercised
// without a live gateway. HTTP-layer calls (install / start / generate / …)
// are covered through the integration-style route contract tests next to the
// runtime plugin; here we stick to pure synchronous helpers so the suite
// stays fast and deterministic.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIDEO_STUDIO_DRAFT,
  mapStatusToBackendState,
  updateVideoStudioDraft,
  type VideoStudioControllerState,
  type VideoStudioStatusPayload,
} from "./video-studio.ts";

function statusWith(backend: VideoStudioStatusPayload["backend"]): VideoStudioStatusPayload {
  return {
    resolution: { kind: "venv", version: "test" },
    supervisor: { kind: "idle" },
    backend,
    endpoint: null,
    recentLogTail: [],
  };
}

describe("mapStatusToBackendState", () => {
  it("returns `starting` when nothing has come back yet", () => {
    expect(mapStatusToBackendState(null, false, null)).toEqual({ kind: "starting" });
    expect(mapStatusToBackendState(null, true, null)).toEqual({ kind: "starting" });
  });

  it("surfaces controller errors as an `error` backend state", () => {
    expect(mapStatusToBackendState(null, false, "boom")).toEqual({ kind: "error", reason: "boom" });
  });

  it("collapses `missing` resolution into the dedicated install card", () => {
    const snap = statusWith({ kind: "missing", reason: "no binary" });
    expect(mapStatusToBackendState(snap, false, null)).toEqual({ kind: "missing" });
  });

  it("passes `ready` / `starting` / `error` through unchanged", () => {
    expect(mapStatusToBackendState(statusWith({ kind: "ready" }), false, null)).toEqual({
      kind: "ready",
    });
    expect(mapStatusToBackendState(statusWith({ kind: "starting" }), false, null)).toEqual({
      kind: "starting",
    });
    expect(
      mapStatusToBackendState(statusWith({ kind: "error", reason: "crashed" }), false, null),
    ).toEqual({ kind: "error", reason: "crashed" });
  });
});

describe("updateVideoStudioDraft", () => {
  function makeState(): Pick<VideoStudioControllerState, "videoStudioDraft"> {
    return { videoStudioDraft: { ...DEFAULT_VIDEO_STUDIO_DRAFT } };
  }

  it("applies a partial patch and leaves untouched fields as-is", () => {
    const state = makeState();
    updateVideoStudioDraft(state as VideoStudioControllerState, { title: "Atomic habits" });
    expect(state.videoStudioDraft).toEqual({
      title: "Atomic habits",
      narration: "",
      aspectRatio: "9:16",
      pipeline: "standard",
      frameTemplate: null,
    });
  });

  it("replaces the draft object so Lit change detection fires", () => {
    const state = makeState();
    const before = state.videoStudioDraft;
    updateVideoStudioDraft(state as VideoStudioControllerState, { narration: "hi" });
    expect(state.videoStudioDraft).not.toBe(before);
  });

  it("supports multiple successive patches without losing earlier edits", () => {
    const state = makeState();
    updateVideoStudioDraft(state as VideoStudioControllerState, { title: "A" });
    updateVideoStudioDraft(state as VideoStudioControllerState, { narration: "B" });
    updateVideoStudioDraft(state as VideoStudioControllerState, { pipeline: "linear" });
    expect(state.videoStudioDraft).toMatchObject({
      title: "A",
      narration: "B",
      pipeline: "linear",
    });
  });
});
