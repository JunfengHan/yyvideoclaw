// End-to-end smoke test for the Remotion plugin.
//
// SKIPPED BY DEFAULT via two layers of gating:
//   1. The filename `*.e2e.test.ts` is excluded from the default vitest lane.
//      It is only picked up by `pnpm test:e2e` (vitest.e2e.config.ts).
//   2. Even under that config, `describe` is swapped to `describe.skip` unless
//      `OPENCLAW_REMOTION_E2E=1` is set.
//
// To actually run this test:
//   cd extensions/remotion && pnpm install && cd ../..
//   OPENCLAW_REMOTION_E2E=1 OPENCLAW_E2E_VERBOSE=1 \
//     pnpm test:e2e extensions/remotion/test/e2e/render.e2e.test.ts
//
// Running `pnpm vitest run <file>` will report "No test files found" because
// the default unit config explicitly excludes `**/*.e2e.test.ts`.
//
// Runtime: 10-60 seconds depending on the host; launches headless Chromium.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRemotionTools } from "../../src/tools.js";
import type { RemotionPluginConfig } from "../../src/types.js";

const E2E_ENABLED = process.env.OPENCLAW_REMOTION_E2E === "1";
const describeE2e = E2E_ENABLED ? describe : describe.skip;

const tempDirs: string[] = [];

afterEach(async () => {
  if (process.env.OPENCLAW_REMOTION_E2E_KEEP === "1") {
    // Debug aid: keep outputs under /tmp so you can `open` the produced mp4.
    console.log("[remotion-e2e] keeping temp dirs:", tempDirs);
    tempDirs.length = 0;
    return;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeConfig(): Promise<RemotionPluginConfig> {
  const fixtureDir = path.join(import.meta.dirname, "fixtures", "minimal-project");
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-remotion-e2e-out-"));
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-remotion-e2e-cache-"));
  tempDirs.push(outputDir, cacheDir);
  return {
    templateRoots: [await fs.realpath(fixtureDir)],
    outputDir,
    cacheDir,
    jobTimeoutMs: 5 * 60 * 1000,
    maxOutputBytes: 50 * 1024 * 1024,
    allowNetwork: false,
  };
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof createRemotionTools>[0]["logger"];

describeE2e("remotion plugin — end to end", () => {
  it(
    "lists compositions in the fixture project",
    async () => {
      const config = await makeConfig();
      const entryPoint = path.join(config.templateRoots[0], "src", "index.ts");
      const tools = createRemotionTools({ config, logger: noopLogger });
      const list = tools.find(
        (
          t,
        ): t is {
          execute: (
            id: string,
            p: Record<string, unknown>,
          ) => Promise<{
            content: { type: string; text: string }[];
            isError?: boolean;
          }>;
        } =>
          typeof t === "object" &&
          t !== null &&
          (t as { name?: unknown }).name === "remotion_list_compositions",
      )!;
      const result = await list.execute("e2e", { entryPoint });
      if (result.isError) {
        // Surface the real error from the worker so e2e failures are debuggable
        // instead of showing a bare "expected true to be falsy".
        throw new Error(`list_compositions failed: ${result.content[0]?.text ?? "(no body)"}`);
      }
      const body = JSON.parse(result.content[0].text);
      expect(body.compositions.length).toBeGreaterThan(0);
      expect(body.compositions[0].id).toBe("HelloWorld");
    },
    5 * 60 * 1000,
  );

  it(
    "renders the HelloWorld composition to an MP4",
    async () => {
      const config = await makeConfig();
      const entryPoint = path.join(config.templateRoots[0], "src", "index.ts");
      const tools = createRemotionTools({ config, logger: noopLogger });
      const renderTool = tools.find(
        (
          t,
        ): t is {
          execute: (
            id: string,
            p: Record<string, unknown>,
          ) => Promise<{
            content: { type: string; text: string }[];
            isError?: boolean;
          }>;
        } =>
          typeof t === "object" &&
          t !== null &&
          (t as { name?: unknown }).name === "remotion_render_video",
      )!;
      const result = await renderTool.execute("e2e", {
        entryPoint,
        compositionId: "HelloWorld",
        inputProps: { tint: "#22c55e" },
      });
      if (result.isError) {
        throw new Error(`render_video failed: ${result.content[0]?.text ?? "(no body)"}`);
      }
      const body = JSON.parse(result.content[0].text);
      expect(body.outputPath.endsWith("out.mp4")).toBe(true);
      expect(body.sizeBytes).toBeGreaterThan(0);
      const stat = await fs.stat(body.outputPath);
      expect(stat.isFile()).toBe(true);
    },
    5 * 60 * 1000,
  );
});
