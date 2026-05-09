import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRemotionConfig, RemotionConfigError } from "./config.js";

describe("resolveRemotionConfig", () => {
  it("requires templateRoots", () => {
    expect(() => resolveRemotionConfig({})).toThrow(RemotionConfigError);
    expect(() => resolveRemotionConfig({ templateRoots: [] })).toThrow(RemotionConfigError);
  });

  it("rejects relative templateRoots entries", () => {
    expect(() => resolveRemotionConfig({ templateRoots: ["./relative"] })).toThrow(/absolute path/);
  });

  it("rejects non-string templateRoots entries", () => {
    expect(() => resolveRemotionConfig({ templateRoots: [123 as unknown as string] })).toThrow(
      RemotionConfigError,
    );
  });

  it("applies sensible defaults when only templateRoots is given", () => {
    const cfg = resolveRemotionConfig({ templateRoots: ["/tmp/templates"] });
    expect(cfg.templateRoots).toEqual(["/tmp/templates"]);
    expect(cfg.outputDir).toBe(path.join(os.homedir(), ".openclaw", "remotion", "outputs"));
    expect(cfg.cacheDir).toBe(path.join(os.homedir(), ".openclaw", "remotion", "cache"));
    expect(cfg.jobTimeoutMs).toBe(600_000);
    expect(cfg.maxOutputBytes).toBe(500 * 1024 * 1024);
    expect(cfg.allowNetwork).toBe(false);
    expect(cfg.chromiumExecutablePath).toBeUndefined();
  });

  it("honours overrides and absolutises them", () => {
    const cfg = resolveRemotionConfig({
      templateRoots: ["/tmp/templates"],
      outputDir: "/tmp/out",
      cacheDir: "/tmp/cache",
      jobTimeoutMs: 30_000,
      maxOutputBytes: 1024,
      allowNetwork: true,
      chromiumExecutablePath: "/usr/bin/chromium",
    });
    expect(cfg.outputDir).toBe("/tmp/out");
    expect(cfg.cacheDir).toBe("/tmp/cache");
    expect(cfg.jobTimeoutMs).toBe(30_000);
    expect(cfg.maxOutputBytes).toBe(1024);
    expect(cfg.allowNetwork).toBe(true);
    expect(cfg.chromiumExecutablePath).toBe("/usr/bin/chromium");
  });

  it("rejects non-positive jobTimeoutMs", () => {
    expect(() => resolveRemotionConfig({ templateRoots: ["/tmp/x"], jobTimeoutMs: 0 })).toThrow(
      /positive/,
    );
    expect(() => resolveRemotionConfig({ templateRoots: ["/tmp/x"], jobTimeoutMs: -1 })).toThrow(
      /positive/,
    );
  });

  it("rejects non-boolean allowNetwork", () => {
    expect(() =>
      resolveRemotionConfig({
        templateRoots: ["/tmp/x"],
        allowNetwork: "yes" as unknown as boolean,
      }),
    ).toThrow(/boolean/);
  });
});
