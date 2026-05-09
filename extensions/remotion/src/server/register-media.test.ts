// Tests for media library registration.
//
// We don't mock saveMediaBuffer — it's already covered by core. Instead we
// drive register-media end-to-end against the real ~/.openclaw/media dir,
// then clean up. A scoped temp dir would be ideal but saveMediaBuffer
// targets resolveMediaDir() which honours OPENCLAW_STATE_DIR; we override
// that env var to keep the tests hermetic.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerArtifactToMediaLibrary } from "./register-media.js";

let stateDir = "";
const originalStateEnv = process.env.OPENCLAW_STATE_DIR;
const tempArtifacts: string[] = [];

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-remotion-mediareg-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
});

afterEach(async () => {
  if (originalStateEnv === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateEnv;
  }
  await Promise.all([
    ...tempArtifacts
      .splice(0)
      .map((p) => fs.rm(p, { force: true, recursive: true }).catch(() => undefined)),
    fs.rm(stateDir, { force: true, recursive: true }).catch(() => undefined),
  ]);
});

async function makeArtifact(name: string, bytes: Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-remotion-art-"));
  tempArtifacts.push(dir);
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, bytes);
  return filePath;
}

describe("registerArtifactToMediaLibrary", () => {
  it("copies a small mp4 into ~/.openclaw/media/outbound/ with the canonical name shape", async () => {
    const artifact = await makeArtifact("out.mp4", Buffer.from("fake mp4 bytes"));
    const result = await registerArtifactToMediaLibrary({
      outputPath: artifact,
      maxBytes: 100 * 1024,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.mediaLibraryPath).toContain(path.join("media", "outbound"));
    // The basename should retain `out.mp4` (the canonical "name---uuid.ext" shape)
    expect(path.basename(result.mediaLibraryPath)).toMatch(/out---[0-9a-f-]+\.mp4$/i);
    const stat = await fs.stat(result.mediaLibraryPath);
    expect(stat.size).toBe("fake mp4 bytes".length);
  });

  it("returns ok:false when the file does not exist", async () => {
    const result = await registerArtifactToMediaLibrary({
      outputPath: "/definitely/not/a/real/path.mp4",
      maxBytes: 1024,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("read failed");
  });

  it("returns ok:false on an empty artifact", async () => {
    const artifact = await makeArtifact("empty.mp4", Buffer.alloc(0));
    const result = await registerArtifactToMediaLibrary({
      outputPath: artifact,
      maxBytes: 1024,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("artifact is empty");
  });

  it("returns ok:false (does NOT throw) when the artifact exceeds maxBytes", async () => {
    const artifact = await makeArtifact("big.mp4", Buffer.alloc(10_000));
    const result = await registerArtifactToMediaLibrary({
      outputPath: artifact,
      maxBytes: 1024, // cap below file size
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("saveMediaBuffer failed");
  });

  it("forwards mp4 content type", async () => {
    const artifact = await makeArtifact("clip.mp4", Buffer.from("video bytes"));
    const result = await registerArtifactToMediaLibrary({
      outputPath: artifact,
      maxBytes: 100 * 1024,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // saveMediaBuffer may sniff and disagree; we just verify it's a video/* type
    expect(result.contentType?.startsWith("video/")).toBe(true);
  });

  it("handles png artifacts", async () => {
    // Minimal PNG header so the sniffer doesn't bail out
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const artifact = await makeArtifact("frame.png", pngHeader);
    const result = await registerArtifactToMediaLibrary({
      outputPath: artifact,
      maxBytes: 100 * 1024,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(path.basename(result.mediaLibraryPath)).toMatch(/frame---.+\.png$/i);
  });
});
