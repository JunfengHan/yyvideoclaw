import { describe, expect, it } from "vitest";
import { formatBackendStatus } from "./settings-section.ts";

describe("formatBackendStatus", () => {
  it("renders the state alone when no runtime metadata is attached", () => {
    expect(formatBackendStatus({ state: "stopped" })).toBe("stopped");
  });

  it("joins non-null pid / port / uptime segments with a middle-dot separator", () => {
    const out = formatBackendStatus({
      state: "running",
      pid: 12_345,
      port: 34_567,
      uptimeMs: 42_000,
    });
    expect(out).toBe("running · pid=12345 · port=34567 · uptime=42s");
  });

  it("omits nullish and non-finite uptime values", () => {
    expect(formatBackendStatus({ state: "running", pid: 1, port: null, uptimeMs: null })).toBe(
      "running · pid=1",
    );
    expect(formatBackendStatus({ state: "running", uptimeMs: Number.POSITIVE_INFINITY })).toBe(
      "running",
    );
    expect(formatBackendStatus({ state: "running", uptimeMs: 0 })).toBe("running");
  });

  it("rounds uptime to seconds rather than exposing raw millis", () => {
    expect(formatBackendStatus({ state: "running", uptimeMs: 1_750 })).toBe("running · uptime=2s");
  });
});
