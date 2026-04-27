// Pure helpers for the Video Studio Lit view.
//
// Split out from `video-studio-view.ts` so unit tests can exercise the
// progress-phase computation and the "which card should we render now"
// state machine without having to mount the Lit element.

import type { TaskPhase, TaskSnapshot, TaskStatus } from "./client.ts";

export const ORDERED_PHASES: readonly TaskPhase[] = [
  "title",
  "narration",
  "images",
  "frames",
  "tts",
  "compose",
];

export type PhaseState = "pending" | "active" | "done" | "failed";

export type PhaseRow = {
  readonly phase: TaskPhase;
  readonly state: PhaseState;
};

/**
 * Compute the per-phase state given a task snapshot. Terminal statuses
 * ("succeeded", "failed", "cancelled") are expanded into all-done / all-
 * failed rows so the UI collapses cleanly when the task finishes mid-flight.
 */
export function computePhaseRows(snap: TaskSnapshot | null): readonly PhaseRow[] {
  if (!snap) {
    return ORDERED_PHASES.map((phase) => ({ phase, state: "pending" as PhaseState }));
  }
  if (snap.status === "succeeded") {
    return ORDERED_PHASES.map((phase) => ({ phase, state: "done" as PhaseState }));
  }
  if (snap.status === "failed" || snap.status === "cancelled") {
    return ORDERED_PHASES.map((phase) => ({ phase, state: "failed" as PhaseState }));
  }
  const idx = snap.phase ? ORDERED_PHASES.indexOf(snap.phase) : -1;
  return ORDERED_PHASES.map((phase, i) => {
    if (idx < 0) return { phase, state: "pending" as PhaseState };
    if (i < idx) return { phase, state: "done" as PhaseState };
    if (i === idx) return { phase, state: "active" as PhaseState };
    return { phase, state: "pending" as PhaseState };
  });
}

// ---------------------------------------------------------------------------
// View state machine — decides which top-level card to render.
// ---------------------------------------------------------------------------

export type BackendState =
  | { readonly kind: "ready" }
  | { readonly kind: "missing" }
  | { readonly kind: "starting" }
  | { readonly kind: "error"; readonly reason: string };

export type ViewMode =
  | { readonly kind: "disabled" }
  | { readonly kind: "not-installed" }
  | { readonly kind: "starting" }
  | { readonly kind: "error"; readonly reason: string }
  | { readonly kind: "studio" };

export function resolveViewMode(input: {
  readonly featureEnabled: boolean;
  readonly backend: BackendState;
}): ViewMode {
  if (!input.featureEnabled) return { kind: "disabled" };
  switch (input.backend.kind) {
    case "missing":
      return { kind: "not-installed" };
    case "starting":
      return { kind: "starting" };
    case "error":
      return { kind: "error", reason: input.backend.reason };
    case "ready":
    default:
      return { kind: "studio" };
  }
}

// ---------------------------------------------------------------------------
// Running / idle predicate — keeps the Generate button's disabled state in
// one place so both the view and its tests agree.
// ---------------------------------------------------------------------------

export function isTaskActive(status: TaskStatus | undefined | null): boolean {
  return status === "pending" || status === "running";
}
