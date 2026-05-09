import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RenderQueue } from "./render-queue.js";
import { createRemotionTools } from "./tools.js";
import type { CompositionInfo, RemotionPluginConfig, RenderJobRequest } from "./types.js";

// Minimal PluginLogger stub that records calls so we can assert redaction.
interface LogCall {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  data?: unknown;
}

function createLogger(): {
  calls: LogCall[];
  logger: Parameters<typeof createRemotionTools>[0]["logger"];
} {
  const calls: LogCall[] = [];
  const push = (level: LogCall["level"]) => (message: string, data?: unknown) => {
    calls.push({ level, message, ...(data !== undefined ? { data } : {}) });
  };
  return {
    calls,
    logger: {
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
      debug: push("debug"),
    } as unknown as Parameters<typeof createRemotionTools>[0]["logger"],
  };
}

// Fake queue that swaps in canned behaviour without spawning a child process.
class FakeQueue extends RenderQueue {
  constructor(
    private readonly listResult: CompositionInfo[] | Error,
    private readonly renderImpl: (
      job: RenderJobRequest,
      outputPath: string,
    ) => Promise<{ outputPath: string; sizeBytes: number; durationMs: number }>,
  ) {
    super({ jobTimeoutMs: 1000, workerPath: "/dev/null" });
  }
  override enqueueList(): Promise<CompositionInfo[]> {
    if (this.listResult instanceof Error) {
      return Promise.reject(this.listResult);
    }
    return Promise.resolve(this.listResult);
  }
  override enqueueRender(input: {
    job: RenderJobRequest;
    outputPath: string;
  }): Promise<{ outputPath: string; sizeBytes: number; durationMs: number }> {
    return this.renderImpl(input.job, input.outputPath);
  }
}

const tempDirs: string[] = [];

async function makeConfig(
  overrides: Partial<RemotionPluginConfig> = {},
): Promise<RemotionPluginConfig> {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-remotion-tools-out-"));
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-remotion-tools-cache-"));
  const templateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-remotion-tools-tmpl-"));
  tempDirs.push(outputDir, cacheDir, templateRoot);
  return {
    templateRoots: [await fs.realpath(templateRoot)],
    outputDir,
    cacheDir,
    jobTimeoutMs: 1000,
    maxOutputBytes: 1024 * 1024,
    allowNetwork: false,
    ...overrides,
  };
}

async function writeEntryPoint(config: RemotionPluginConfig): Promise<string> {
  const file = path.join(config.templateRoots[0], "index.ts");
  await fs.writeFile(file, "// fake entry", "utf8");
  return file;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function getTool(
  tools: unknown[],
  name: string,
): {
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;
} {
  const tool = tools.find(
    (t): t is { name: string } & { execute: unknown } =>
      typeof t === "object" && t !== null && (t as { name?: unknown }).name === name,
  ) as unknown as {
    execute: (
      id: string,
      params: Record<string, unknown>,
    ) => Promise<{
      content: { type: string; text: string }[];
      isError?: boolean;
    }>;
  };
  if (!tool) {
    throw new Error(`tool ${name} not found`);
  }
  return tool;
}

describe("createRemotionTools — list", () => {
  it("returns compositions on success", async () => {
    const config = await makeConfig();
    const entry = await writeEntryPoint(config);
    const { logger } = createLogger();
    const queue = new FakeQueue(
      [{ id: "Hello", width: 1, height: 1, fps: 1, durationInFrames: 1 }],
      () => Promise.reject(new Error("unused")),
    );
    const tools = createRemotionTools({ config, logger, queue });
    const result = await getTool(tools, "remotion_list_compositions").execute("t1", {
      entryPoint: entry,
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.compositions).toEqual([
      { id: "Hello", width: 1, height: 1, fps: 1, durationInFrames: 1 },
    ]);
  });

  it("rejects an entryPoint outside templateRoots without invoking the queue", async () => {
    const config = await makeConfig();
    const { logger } = createLogger();
    let queueCalled = false;
    const queue = new FakeQueue([], () => {
      queueCalled = true;
      return Promise.reject(new Error("should not run"));
    });
    const tools = createRemotionTools({ config, logger, queue });
    const result = await getTool(tools, "remotion_list_compositions").execute("t1", {
      entryPoint: "/etc/passwd",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("template rejected");
    expect(queueCalled).toBe(false);
  });
});

describe("createRemotionTools — render_video", () => {
  it("renders and returns structured metadata", async () => {
    const config = await makeConfig();
    const entry = await writeEntryPoint(config);
    const { logger, calls } = createLogger();
    const queue = new FakeQueue([], async (_job, outputPath) => {
      // Simulate a successful render by writing a dummy MP4.
      await fs.writeFile(outputPath, Buffer.alloc(100, 1));
      return { outputPath, sizeBytes: 100, durationMs: 42 };
    });
    const tools = createRemotionTools({ config, logger, queue });
    const result = await getTool(tools, "remotion_render_video").execute("t1", {
      entryPoint: entry,
      compositionId: "Hello",
      inputProps: { apiKey: "sk-secret-XXXX", title: "Hi" },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.sizeBytes).toBe(100);
    expect(body.outputPath.startsWith(config.outputDir)).toBe(true);
    expect(body.fileUrl.startsWith("file://")).toBe(true);

    // REDACTION REGRESSION: logs must never contain the apiKey value.
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("sk-secret");
  });

  it("rejects bad inputs without touching the queue", async () => {
    const config = await makeConfig();
    const { logger } = createLogger();
    let queueCalled = false;
    const queue = new FakeQueue([], (_job, _out) => {
      queueCalled = true;
      return Promise.resolve({ outputPath: "", sizeBytes: 0, durationMs: 0 });
    });
    const tools = createRemotionTools({ config, logger, queue });
    const result = await getTool(tools, "remotion_render_video").execute("t1", {
      // missing compositionId
      entryPoint: "/etc/passwd",
    });
    expect(result.isError).toBe(true);
    expect(queueCalled).toBe(false);
  });

  it("cleans up the job directory on render failure", async () => {
    const config = await makeConfig();
    const entry = await writeEntryPoint(config);
    const { logger } = createLogger();
    const queue = new FakeQueue([], () => Promise.reject(new Error("boom")));
    const tools = createRemotionTools({ config, logger, queue });
    const before = (await fs.readdir(config.outputDir)).length;
    const result = await getTool(tools, "remotion_render_video").execute("t1", {
      entryPoint: entry,
      compositionId: "Hello",
    });
    expect(result.isError).toBe(true);
    const after = (await fs.readdir(config.outputDir)).length;
    // Failed job directory must be cleaned up.
    expect(after).toBe(before);
  });

  it("enforces maxOutputBytes and cleans up oversized output", async () => {
    const config = await makeConfig({ maxOutputBytes: 10 });
    const entry = await writeEntryPoint(config);
    const { logger } = createLogger();
    const queue = new FakeQueue([], async (_job, outputPath) => {
      await fs.writeFile(outputPath, Buffer.alloc(50, 1)); // over the cap
      return { outputPath, sizeBytes: 50, durationMs: 10 };
    });
    const tools = createRemotionTools({ config, logger, queue });
    const result = await getTool(tools, "remotion_render_video").execute("t1", {
      entryPoint: entry,
      compositionId: "Hello",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("exceeds");
    // Job dir cleaned up.
    const entries = await fs.readdir(config.outputDir);
    expect(entries.length).toBe(0);
  });
});

describe("createRemotionTools — render_still", () => {
  it("honours imageFormat and frame", async () => {
    const config = await makeConfig();
    const entry = await writeEntryPoint(config);
    const { logger } = createLogger();
    let captured: RenderJobRequest | undefined;
    const queue = new FakeQueue([], async (job, outputPath) => {
      captured = job;
      await fs.writeFile(outputPath, Buffer.alloc(20, 2));
      return { outputPath, sizeBytes: 20, durationMs: 5 };
    });
    const tools = createRemotionTools({ config, logger, queue });
    const result = await getTool(tools, "remotion_render_still").execute("t1", {
      entryPoint: entry,
      compositionId: "Frame",
      frame: 17,
      imageFormat: "jpeg",
    });
    expect(result.isError).toBeFalsy();
    expect(captured?.kind).toBe("still");
    expect(captured?.imageFormat).toBe("jpeg");
    expect(captured?.frame).toBe(17);
    const body = JSON.parse(result.content[0].text);
    expect(body.outputPath.endsWith("out.jpeg")).toBe(true);
  });
});
