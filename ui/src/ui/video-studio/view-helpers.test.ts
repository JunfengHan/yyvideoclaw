import { describe, expect, it } from "vitest";
import type { TaskSnapshot } from "./client.ts";
import { computePhaseRows, isTaskActive, ORDERED_PHASES, resolveViewMode } from "./view-helpers.ts";

describe("computePhaseRows", () => {
  it("returns all-pending rows when there is no snapshot yet", () => {
    const rows = computePhaseRows(null);
    expect(rows.map((r) => r.phase)).toEqual([...ORDERED_PHASES]);
    expect(rows.every((r) => r.state === "pending")).toBe(true);
  });

  it("marks phases before the current one as done, current as active, rest pending", () => {
    const snap: TaskSnapshot = { id: "t1", status: "running", phase: "images" };
    const rows = computePhaseRows(snap);
    expect(rows.find((r) => r.phase === "title")?.state).toBe("done");
    expect(rows.find((r) => r.phase === "narration")?.state).toBe("done");
    expect(rows.find((r) => r.phase === "images")?.state).toBe("active");
    expect(rows.find((r) => r.phase === "frames")?.state).toBe("pending");
    expect(rows.find((r) => r.phase === "tts")?.state).toBe("pending");
    expect(rows.find((r) => r.phase === "compose")?.state).toBe("pending");
  });

  it("expands to all-done when the task succeeded", () => {
    const rows = computePhaseRows({ id: "t1", status: "succeeded" });
    expect(rows.every((r) => r.state === "done")).toBe(true);
  });

  it("expands to all-failed when the task failed or was cancelled", () => {
    expect(
      computePhaseRows({ id: "t1", status: "failed" }).every((r) => r.state === "failed"),
    ).toBe(true);
    expect(
      computePhaseRows({ id: "t1", status: "cancelled" }).every((r) => r.state === "failed"),
    ).toBe(true);
  });
});

describe("resolveViewMode", () => {
  it("returns `disabled` when the feature flag is off (regardless of backend)", () => {
    expect(
      resolveViewMode({ featureEnabled: false, backend: { kind: "ready", streamlitUrl: null } }),
    ).toEqual({
      kind: "disabled",
    });
  });

  it("maps backend states 1:1 when the feature is on", () => {
    expect(resolveViewMode({ featureEnabled: true, backend: { kind: "missing" } })).toEqual({
      kind: "not-installed",
    });
    expect(resolveViewMode({ featureEnabled: true, backend: { kind: "idle" } })).toEqual({
      kind: "idle",
    });
    expect(resolveViewMode({ featureEnabled: true, backend: { kind: "starting" } })).toEqual({
      kind: "starting",
    });
    expect(
      resolveViewMode({ featureEnabled: true, backend: { kind: "error", reason: "boom" } }),
    ).toEqual({ kind: "error", reason: "boom" });
    // `ready` now carries the Streamlit loopback URL so the view can embed
    // the upstream Pixelle UI directly in an iframe.
    expect(
      resolveViewMode({
        featureEnabled: true,
        backend: { kind: "ready", streamlitUrl: "http://127.0.0.1:57000" },
      }),
    ).toEqual({
      kind: "studio",
      streamlitUrl: "http://127.0.0.1:57000",
    });
    expect(
      resolveViewMode({
        featureEnabled: true,
        backend: { kind: "ready", streamlitUrl: null },
      }),
    ).toEqual({
      kind: "studio",
      streamlitUrl: null,
    });
  });
});

describe("isTaskActive", () => {
  it("treats pending and running as active", () => {
    expect(isTaskActive("pending")).toBe(true);
    expect(isTaskActive("running")).toBe(true);
  });

  it("treats terminal and nullish states as inactive", () => {
    expect(isTaskActive("succeeded")).toBe(false);
    expect(isTaskActive("failed")).toBe(false);
    expect(isTaskActive("cancelled")).toBe(false);
    expect(isTaskActive(null)).toBe(false);
    expect(isTaskActive(undefined)).toBe(false);
  });
});
