import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  allocateJobOutput,
  cleanupJobDir,
  OutputError,
  verifyAndMeasure,
} from "./output-manager.js";
import type { RemotionPluginConfig } from "./types.js";

const tempDirs: string[] = [];

async function makeConfig(
  overrides: Partial<RemotionPluginConfig> = {},
): Promise<RemotionPluginConfig> {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-remotion-out-"));
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-remotion-cache-"));
  tempDirs.push(outputDir, cacheDir);
  return {
    templateRoots: ["/dev/null"], // unused by this module
    outputDir,
    cacheDir,
    jobTimeoutMs: 60_000,
    maxOutputBytes: 1024,
    allowNetwork: false,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("allocateJobOutput", () => {
  it("creates a fresh job directory under outputDir and returns a file:// URL", async () => {
    const config = await makeConfig();
    const allocation = await allocateJobOutput(config, "mp4");

    expect(allocation.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(allocation.jobDir).toBe(path.join(config.outputDir, allocation.jobId));
    expect(allocation.outputPath).toBe(path.join(allocation.jobDir, "out.mp4"));
    expect(allocation.fileUrl.startsWith("file://")).toBe(true);
    expect(allocation.fileUrl.endsWith("out.mp4")).toBe(true);

    const stat = await fs.stat(allocation.jobDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("never produces colliding job ids across calls", async () => {
    const config = await makeConfig();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const allocation = await allocateJobOutput(config, "png");
      ids.add(allocation.jobId);
    }
    expect(ids.size).toBe(20);
  });

  it("creates outputDir lazily if it does not yet exist", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-remotion-base-"));
    tempDirs.push(base);
    const config = await makeConfig({ outputDir: path.join(base, "nested", "outputs") });
    const allocation = await allocateJobOutput(config, "mp4");
    const stat = await fs.stat(allocation.jobDir);
    expect(stat.isDirectory()).toBe(true);
  });
});

describe("verifyAndMeasure", () => {
  it("returns size for a file under the cap", async () => {
    const config = await makeConfig({ maxOutputBytes: 100 });
    const allocation = await allocateJobOutput(config, "mp4");
    await fs.writeFile(allocation.outputPath, Buffer.alloc(50, 1));

    const size = await verifyAndMeasure(allocation.outputPath, config.maxOutputBytes);
    expect(size).toBe(50);
  });

  it("deletes the artifact and throws when over the cap", async () => {
    const config = await makeConfig({ maxOutputBytes: 10 });
    const allocation = await allocateJobOutput(config, "mp4");
    await fs.writeFile(allocation.outputPath, Buffer.alloc(50, 1));

    await expect(
      verifyAndMeasure(allocation.outputPath, config.maxOutputBytes),
    ).rejects.toMatchObject({
      code: "too-large",
    });
    await expect(fs.stat(allocation.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws OutputError with code=missing when no file exists", async () => {
    const config = await makeConfig();
    const allocation = await allocateJobOutput(config, "mp4");
    await expect(
      verifyAndMeasure(allocation.outputPath, config.maxOutputBytes),
    ).rejects.toMatchObject({
      code: "missing",
    });
  });

  it("throws when target is a directory, not a file", async () => {
    const config = await makeConfig();
    const allocation = await allocateJobOutput(config, "mp4");
    await fs.mkdir(allocation.outputPath); // make it a dir
    await expect(
      verifyAndMeasure(allocation.outputPath, config.maxOutputBytes),
    ).rejects.toMatchObject({
      code: "not-a-file",
    });
  });
});

describe("cleanupJobDir", () => {
  it("removes the job directory recursively", async () => {
    const config = await makeConfig();
    const allocation = await allocateJobOutput(config, "mp4");
    await fs.writeFile(allocation.outputPath, "data");

    await cleanupJobDir(allocation.jobDir);
    await expect(fs.stat(allocation.jobDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never throws on a missing directory", async () => {
    await expect(
      cleanupJobDir("/tmp/openclaw-remotion-does-not-exist-xyz"),
    ).resolves.toBeUndefined();
  });
});

describe("OutputError", () => {
  it("is throwable and exposes a typed code", () => {
    const err = new OutputError("x", "missing");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("OutputError");
    expect(err.code).toBe("missing");
  });
});
