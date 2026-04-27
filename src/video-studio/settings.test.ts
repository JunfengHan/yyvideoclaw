import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIDEO_STUDIO_SETTINGS,
  detectSettingsChanges,
  flattenForPersistence,
  parseVideoStudioSettings,
  RESTART_REQUIRED_FIELDS,
  VIDEO_STUDIO_SETTINGS_KEY_PREFIX,
  type VideoStudioSettings,
} from "./settings.js";

describe("parseVideoStudioSettings", () => {
  it("returns the documented defaults for `null`, `undefined`, and non-object input", () => {
    expect(parseVideoStudioSettings(null)).toEqual(DEFAULT_VIDEO_STUDIO_SETTINGS);
    expect(parseVideoStudioSettings(undefined)).toEqual(DEFAULT_VIDEO_STUDIO_SETTINGS);
    expect(parseVideoStudioSettings("garbage")).toEqual(DEFAULT_VIDEO_STUDIO_SETTINGS);
  });

  it("coerces string booleans and numeric strings", () => {
    const parsed = parseVideoStudioSettings({
      enabled: "true",
      autoStopIdleMinutes: "45",
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.autoStopIdleMinutes).toBe(45);
  });

  it("rejects invalid enums and falls back to defaults", () => {
    const parsed = parseVideoStudioSettings({
      defaultAspectRatio: "2:3",
      defaultPipeline: "freeform",
    });
    expect(parsed.defaultAspectRatio).toBe(DEFAULT_VIDEO_STUDIO_SETTINGS.defaultAspectRatio);
    expect(parsed.defaultPipeline).toBe(DEFAULT_VIDEO_STUDIO_SETTINGS.defaultPipeline);
  });

  it("clamps negative autoStopIdleMinutes to 0 (keep backend alive)", () => {
    expect(parseVideoStudioSettings({ autoStopIdleMinutes: -5 }).autoStopIdleMinutes).toBe(0);
  });

  it("strips empty / whitespace-only strings on defaultFrameTemplate", () => {
    expect(parseVideoStudioSettings({ defaultFrameTemplate: "" }).defaultFrameTemplate).toBeNull();
    expect(
      parseVideoStudioSettings({ defaultFrameTemplate: "  " }).defaultFrameTemplate,
    ).toBeNull();
    expect(
      parseVideoStudioSettings({ defaultFrameTemplate: "foo.html" }).defaultFrameTemplate,
    ).toBe("foo.html");
  });

  it("round-trips a full legitimate payload", () => {
    const payload: VideoStudioSettings = {
      enabled: true,
      defaultModel: "openai/gpt-4o-mini",
      defaultAspectRatio: "16:9",
      defaultPipeline: "custom",
      defaultFrameTemplate: "1920x1080/foo.html",
      autoStopIdleMinutes: 0,
    };
    expect(parseVideoStudioSettings(payload)).toEqual(payload);
  });
});

describe("detectSettingsChanges", () => {
  const base = DEFAULT_VIDEO_STUDIO_SETTINGS;

  it("returns an empty diff when nothing changed", () => {
    expect(detectSettingsChanges(base, base)).toEqual({ changed: [], requiresRestart: false });
  });

  it("flags defaultModel changes as requiring a restart", () => {
    const diff = detectSettingsChanges(base, { ...base, defaultModel: "openai/gpt-4o-mini" });
    expect(diff.changed).toEqual(["defaultModel"]);
    expect(diff.requiresRestart).toBe(true);
  });

  it("non-restart fields change without requiring a restart", () => {
    const diff = detectSettingsChanges(base, { ...base, defaultAspectRatio: "16:9" });
    expect(diff.changed).toEqual(["defaultAspectRatio"]);
    expect(diff.requiresRestart).toBe(false);
  });

  it("matches RESTART_REQUIRED_FIELDS exactly", () => {
    expect(RESTART_REQUIRED_FIELDS).toEqual(["defaultModel"]);
  });
});

describe("flattenForPersistence", () => {
  it("emits dotted `videoStudio.*` keys covering every field", () => {
    const flat = flattenForPersistence(DEFAULT_VIDEO_STUDIO_SETTINGS);
    expect(flat[`${VIDEO_STUDIO_SETTINGS_KEY_PREFIX}.enabled`]).toBe(false);
    expect(flat[`${VIDEO_STUDIO_SETTINGS_KEY_PREFIX}.defaultModel`]).toBe("qwen/qwen-max");
    expect(flat[`${VIDEO_STUDIO_SETTINGS_KEY_PREFIX}.defaultAspectRatio`]).toBe("9:16");
    expect(flat[`${VIDEO_STUDIO_SETTINGS_KEY_PREFIX}.defaultPipeline`]).toBe("standard");
    expect(flat[`${VIDEO_STUDIO_SETTINGS_KEY_PREFIX}.defaultFrameTemplate`]).toBeNull();
    expect(flat[`${VIDEO_STUDIO_SETTINGS_KEY_PREFIX}.autoStopIdleMinutes`]).toBe(30);
  });
});
