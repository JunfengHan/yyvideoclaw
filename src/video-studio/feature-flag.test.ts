import { describe, expect, it } from "vitest";
import { resolveVideoStudioFeatureFlag } from "./feature-flag.js";

describe("resolveVideoStudioFeatureFlag", () => {
  it("defaults to enabled in dev builds", () => {
    expect(
      resolveVideoStudioFeatureFlag({ env: { NODE_ENV: "development" }, userConfig: undefined }),
    ).toBe(true);
  });

  it("defaults to enabled in production builds too (ship-enabled by default)", () => {
    expect(
      resolveVideoStudioFeatureFlag({ env: { NODE_ENV: "production" }, userConfig: undefined }),
    ).toBe(true);
  });

  it("honours an explicit user-config override over the default", () => {
    // User opt-out: turn it off even though default is on.
    expect(
      resolveVideoStudioFeatureFlag({
        env: { NODE_ENV: "production" },
        userConfig: { enabled: false },
      }),
    ).toBe(false);
    expect(
      resolveVideoStudioFeatureFlag({
        env: { NODE_ENV: "development" },
        userConfig: { enabled: false },
      }),
    ).toBe(false);
    // User opt-in is a no-op when the default is already on, but the plumbing
    // still reports the value they asked for.
    expect(
      resolveVideoStudioFeatureFlag({
        env: { NODE_ENV: "production" },
        userConfig: { enabled: true },
      }),
    ).toBe(true);
  });

  it("env override beats the user config", () => {
    expect(
      resolveVideoStudioFeatureFlag({
        env: { NODE_ENV: "production", YYVIDEOCLAW_VIDEO_STUDIO: "1" },
        userConfig: { enabled: false },
      }),
    ).toBe(true);
    expect(
      resolveVideoStudioFeatureFlag({
        env: { NODE_ENV: "development", YYVIDEOCLAW_VIDEO_STUDIO: "0" },
        userConfig: { enabled: true },
      }),
    ).toBe(false);
  });

  it("ignores unparseable env overrides and falls back to the next layer", () => {
    expect(
      resolveVideoStudioFeatureFlag({
        env: { NODE_ENV: "production", YYVIDEOCLAW_VIDEO_STUDIO: "maybe" },
        userConfig: { enabled: true },
      }),
    ).toBe(true);
  });
});
