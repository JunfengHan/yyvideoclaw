// Tests for the studio-sidecar loader.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeSidecarCandidates,
  loadStudioSidecar,
  validateStudioMetadata,
} from "./studio-sidecar.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function makeFixture(): Promise<{ projectRoot: string; entry: string }> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-remotion-sidecar-"));
  tempDirs.push(projectRoot);
  await fs.mkdir(path.join(projectRoot, "src"));
  const entry = path.join(projectRoot, "src", "index.ts");
  await fs.writeFile(entry, "// stub\n");
  return { projectRoot, entry };
}

describe("computeSidecarCandidates", () => {
  it("looks in entryPoint sibling first, then in project root when entry is in src/", () => {
    const candidates = computeSidecarCandidates("/abs/proj/src/index.ts");
    expect(candidates).toEqual(["/abs/proj/src/studio.json", "/abs/proj/studio.json"]);
  });

  it("does not walk up when the entry is NOT in a src/ subdir", () => {
    const candidates = computeSidecarCandidates("/abs/proj/index.ts");
    expect(candidates).toEqual(["/abs/proj/studio.json"]);
  });
});

describe("validateStudioMetadata", () => {
  it("accepts the canonical shape", () => {
    const meta = validateStudioMetadata({
      compositions: {
        Hello: { label: "Hi", description: "greeting", inputPropsSchema: { type: "object" } },
      },
    });
    expect(meta).toEqual({
      compositions: {
        Hello: { label: "Hi", description: "greeting", inputPropsSchema: { type: "object" } },
      },
    });
  });

  it("returns null on non-object root", () => {
    expect(validateStudioMetadata(null)).toBeNull();
    expect(validateStudioMetadata("string")).toBeNull();
    expect(validateStudioMetadata([])).toBeNull();
  });

  it("returns null when compositions is missing or not an object", () => {
    expect(validateStudioMetadata({})).toBeNull();
    expect(validateStudioMetadata({ compositions: "x" })).toBeNull();
    expect(validateStudioMetadata({ compositions: [] })).toBeNull();
  });

  it("silently drops entries with unexpected shapes", () => {
    const meta = validateStudioMetadata({
      compositions: {
        Good: { label: "Y" },
        BadEntry: "not an object",
        AlsoBad: 42,
      },
    });
    // BadEntry / AlsoBad were dropped; Good preserved
    expect(meta?.compositions).toEqual({ Good: { label: "Y" } });
  });

  it("ignores fields with wrong types but keeps the rest of the entry", () => {
    const meta = validateStudioMetadata({
      compositions: {
        Mixed: {
          label: 123, // wrong → dropped
          description: "ok",
          inputPropsSchema: "not-an-object", // wrong → dropped
        },
      },
    });
    expect(meta?.compositions.Mixed).toEqual({ description: "ok" });
  });
});

describe("loadStudioSidecar", () => {
  it("returns metadata when studio.json sits next to entryPoint", async () => {
    const { entry } = await makeFixture();
    const sidecarPath = path.join(path.dirname(entry), "studio.json");
    await fs.writeFile(sidecarPath, JSON.stringify({ compositions: { Hello: { label: "Hi" } } }));
    const meta = await loadStudioSidecar(entry);
    expect(meta?.compositions.Hello?.label).toBe("Hi");
  });

  it("falls back to project-root studio.json when entry is in src/", async () => {
    const { projectRoot, entry } = await makeFixture();
    const sidecarPath = path.join(projectRoot, "studio.json");
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({ compositions: { World: { description: "from root" } } }),
    );
    const meta = await loadStudioSidecar(entry);
    expect(meta?.compositions.World?.description).toBe("from root");
  });

  it("returns null when no sidecar exists", async () => {
    const { entry } = await makeFixture();
    const meta = await loadStudioSidecar(entry);
    expect(meta).toBeNull();
  });

  it("returns null on invalid JSON instead of throwing", async () => {
    const { entry } = await makeFixture();
    await fs.writeFile(path.join(path.dirname(entry), "studio.json"), "not json {{{");
    const meta = await loadStudioSidecar(entry);
    expect(meta).toBeNull();
  });

  it("rejects oversized sidecars (> 64KB) for safety", async () => {
    const { entry } = await makeFixture();
    const big = JSON.stringify({
      compositions: { X: { description: "x".repeat(70 * 1024) } },
    });
    await fs.writeFile(path.join(path.dirname(entry), "studio.json"), big);
    const meta = await loadStudioSidecar(entry);
    expect(meta).toBeNull();
  });

  it("rejects empty sidecar file", async () => {
    const { entry } = await makeFixture();
    await fs.writeFile(path.join(path.dirname(entry), "studio.json"), "");
    const meta = await loadStudioSidecar(entry);
    expect(meta).toBeNull();
  });

  it("first match wins (sibling preferred over project-root)", async () => {
    const { projectRoot, entry } = await makeFixture();
    await fs.writeFile(
      path.join(path.dirname(entry), "studio.json"),
      JSON.stringify({ compositions: { Hello: { label: "from-src" } } }),
    );
    await fs.writeFile(
      path.join(projectRoot, "studio.json"),
      JSON.stringify({ compositions: { Hello: { label: "from-root" } } }),
    );
    const meta = await loadStudioSidecar(entry);
    expect(meta?.compositions.Hello?.label).toBe("from-src");
  });
});
