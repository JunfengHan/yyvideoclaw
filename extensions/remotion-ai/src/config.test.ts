import { describe, expect, it } from "vitest";
import { resolveRemotionAiConfig, RemotionAiConfigError } from "./config.js";

describe("resolveRemotionAiConfig", () => {
  it("returns defaults when no config is provided", () => {
    const cfg = resolveRemotionAiConfig(undefined);
    expect(cfg.engine).toBe("codex");
    expect(cfg.retryMax).toBe(3);
    expect(cfg.jobTimeoutMs).toBe(600_000);
    expect(cfg.skillsBundled).toBe(true);
    expect(cfg.allowNetwork).toBe(false);
    expect(cfg.maxOutputBytes).toBe(10 * 1024 * 1024);
    expect(cfg.outputRootAllowlist).toBeUndefined();
    expect(cfg.starterDir).toBeUndefined();
    expect(cfg.chromiumExecutablePath).toBeUndefined();
  });

  it("accepts an explicit codex engine", () => {
    const cfg = resolveRemotionAiConfig({ engine: "codex" });
    expect(cfg.engine).toBe("codex");
  });

  it("rejects an unknown engine", () => {
    expect(() => resolveRemotionAiConfig({ engine: "claude-code" })).toThrowError(
      RemotionAiConfigError,
    );
  });

  it("rejects a non-object config", () => {
    expect(() => resolveRemotionAiConfig("oops")).toThrowError(RemotionAiConfigError);
    expect(() => resolveRemotionAiConfig(42)).toThrowError(RemotionAiConfigError);
    expect(() => resolveRemotionAiConfig([1, 2, 3])).toThrowError(RemotionAiConfigError);
  });

  it("validates retryMax bounds and type", () => {
    expect(() => resolveRemotionAiConfig({ retryMax: -1 })).toThrowError(/retryMax must be >= 0/);
    expect(() => resolveRemotionAiConfig({ retryMax: 11 })).toThrowError(/retryMax must be <= 10/);
    expect(() => resolveRemotionAiConfig({ retryMax: 1.5 })).toThrowError(
      /retryMax must be an integer/,
    );
    expect(() => resolveRemotionAiConfig({ retryMax: "3" })).toThrowError(
      /retryMax must be a finite number/,
    );
  });

  it("validates jobTimeoutMs minimum", () => {
    expect(() => resolveRemotionAiConfig({ jobTimeoutMs: 500 })).toThrowError(
      /jobTimeoutMs must be >= 1000/,
    );
  });

  it("requires outputRootAllowlist entries to be non-empty absolute paths", () => {
    expect(() => resolveRemotionAiConfig({ outputRootAllowlist: "/not/an/array" })).toThrowError(
      /outputRootAllowlist must be an array/,
    );
    expect(() => resolveRemotionAiConfig({ outputRootAllowlist: ["relative/path"] })).toThrowError(
      /must be an absolute path/,
    );
    expect(() => resolveRemotionAiConfig({ outputRootAllowlist: [""] })).toThrowError(
      /must be a non-empty string/,
    );
  });

  it("accepts a valid absolute outputRootAllowlist", () => {
    const cfg = resolveRemotionAiConfig({
      outputRootAllowlist: ["/Users/foo/projects", "/tmp/ai-workspaces"],
    });
    expect(cfg.outputRootAllowlist).toEqual(["/Users/foo/projects", "/tmp/ai-workspaces"]);
  });

  it("requires starterDir to be an absolute path if provided", () => {
    expect(() => resolveRemotionAiConfig({ starterDir: "relative" })).toThrowError(
      /starterDir must be an absolute path/,
    );
    expect(() => resolveRemotionAiConfig({ starterDir: "" })).toThrowError(
      /starterDir must be a non-empty absolute path/,
    );
  });
});
