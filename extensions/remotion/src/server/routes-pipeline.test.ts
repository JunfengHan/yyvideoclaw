// Full-pipeline tests for the HTTP routes.
//
// We drive the routes end-to-end using:
//   - A FakeQueue that returns deterministic results without spawning workers.
//   - A throwaway templateRoots dir + outputDir on local disk.
//   - The fake req/res shape used in routes.test.ts (no real http server).
//
// What we DO cover:
//   GET /templates  → composition list, sidecar metadata merge
//   POST /render    → 202 + queued snapshot, async pipeline drives it to done
//   GET /jobs/:id   → polls until status === "done", verifies size + media path
//   GET /history    → recent jobs
//   POST /render with bad path → 403 template_rejected
//   POST /render with bad json → 400 bad_request
//
// What we DO NOT cover here (covered elsewhere):
//   Real Remotion rendering (test/e2e/render.e2e.test.ts)
//   saveMediaBuffer behavior (register-media.test.ts)

import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RenderQueue } from "../render-queue.js";
import type { CompositionInfo, RenderJobRequest, RemotionPluginConfig } from "../types.js";
import { JobsStore } from "./jobs-store.js";
import {
  extractJobIdFromPath,
  handleHistory,
  handleRenderSubmit,
  handleStatus,
  handleTemplates,
  makeJobLookupHandler,
  type RouteContext,
} from "./routes.js";

// ---------------------------------------------------------------------------
// FakeQueue (mirrors extensions/remotion/src/tools.test.ts).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fake req/res helpers.
// ---------------------------------------------------------------------------

interface ResCapture {
  statusCode?: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
}

function makeReqRes(opts: { method: string; url: string; body?: string }): {
  req: Parameters<typeof handleStatus>[0];
  res: Parameters<typeof handleStatus>[1];
  capture: ResCapture;
} {
  const reqEvents = new EventEmitter();
  const req = Object.assign(reqEvents, {
    method: opts.method,
    url: opts.url,
    headers: {},
    destroy: () => undefined,
  }) as unknown as Parameters<typeof handleStatus>[0];

  // Replay body asynchronously, exactly like Node's IncomingMessage would.
  if (opts.body !== undefined) {
    queueMicrotask(() => {
      reqEvents.emit("data", Buffer.from(opts.body!, "utf8"));
      reqEvents.emit("end");
    });
  } else {
    queueMicrotask(() => reqEvents.emit("end"));
  }

  const capture: ResCapture = { headers: {}, body: "", ended: false };
  const res = {
    set statusCode(code: number) {
      capture.statusCode = code;
    },
    get statusCode(): number {
      return capture.statusCode ?? 0;
    },
    setHeader(name: string, value: string) {
      capture.headers[name.toLowerCase()] = value;
    },
    end(payload?: string) {
      capture.body = typeof payload === "string" ? payload : "";
      capture.ended = true;
    },
  } as unknown as Parameters<typeof handleStatus>[1];

  return { req, res, capture };
}

// ---------------------------------------------------------------------------
// Disk fixture: a fake templateRoot with a real index.ts file (the routes
// only need the file to *exist* for resolveTemplateEntryPoint).
// ---------------------------------------------------------------------------

async function makeFixture(): Promise<{
  templateRoot: string;
  /** Real (canonical) entry path — matches what resolveTemplateEntryPoint produces. */
  entryPoint: string;
  outputDir: string;
  cleanup: () => Promise<void>;
}> {
  const templateRootRaw = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-routes-tpl-"));
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-routes-out-"));
  await fs.mkdir(path.join(templateRootRaw, "src"));
  const entryPointRaw = path.join(templateRootRaw, "src", "index.ts");
  await fs.writeFile(entryPointRaw, "// stub");
  // resolveTemplateEntryPoint canonicalises via fs.realpath which on macOS
  // resolves /var/folders/... to /private/var/folders/... — make the
  // fixture match so test assertions work on both platforms.
  const templateRoot = await fs.realpath(templateRootRaw);
  const entryPoint = await fs.realpath(entryPointRaw);
  const cleanup = async () => {
    await Promise.allSettled([
      fs.rm(templateRootRaw, { recursive: true, force: true }),
      fs.rm(outputDir, { recursive: true, force: true }),
    ]);
  };
  return { templateRoot, entryPoint, outputDir, cleanup };
}

function makeCtx(overrides: {
  config: Partial<RemotionPluginConfig> & { templateRoots: string[]; outputDir: string };
  queue: RenderQueue;
}): RouteContext {
  const config: RemotionPluginConfig = {
    cacheDir: undefined,
    jobTimeoutMs: 60_000,
    maxOutputBytes: 100 * 1024 * 1024,
    allowNetwork: false,
    ...overrides.config,
  };
  return {
    config,
    queue: overrides.queue,
    jobs: new JobsStore(),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as RouteContext["logger"],
    basePath: "",
  };
}

const tempState: string[] = [];
const originalState = process.env.OPENCLAW_STATE_DIR;
beforeEach(async () => {
  // saveMediaBuffer writes to ~/.openclaw — sandbox it so the test doesn't
  // pollute the operator's media library.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-routes-state-"));
  tempState.push(dir);
  process.env.OPENCLAW_STATE_DIR = dir;
});
afterEach(async () => {
  if (originalState === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalState;
  }
  await Promise.all(
    tempState
      .splice(0)
      .map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => undefined)),
  );
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("GET /remotion/templates", () => {
  it("returns compositions + merged metadata when studio.json is present", async () => {
    const { templateRoot, entryPoint, outputDir, cleanup } = await makeFixture();
    try {
      // Drop a sidecar.
      await fs.writeFile(
        path.join(templateRoot, "studio.json"),
        JSON.stringify({
          compositions: { Hello: { label: "Hi", description: "greeting" } },
        }),
      );
      const queue = new FakeQueue(
        [{ id: "Hello", width: 320, height: 180, fps: 30, durationInFrames: 30 }],
        () => Promise.reject(new Error("unused")),
      );
      const ctx = makeCtx({
        config: { templateRoots: [templateRoot], outputDir },
        queue,
      });
      const { req, res, capture } = makeReqRes({
        method: "GET",
        url: "/remotion/templates",
      });
      await handleTemplates(req, res, ctx);
      expect(capture.statusCode).toBe(200);
      const body = JSON.parse(capture.body);
      expect(body.errors).toEqual([]);
      expect(body.templates).toHaveLength(1);
      expect(body.templates[0].entryPoint).toBe(entryPoint);
      expect(body.templates[0].metadataAvailable).toBe(true);
      expect(body.templates[0].compositions[0]).toEqual({
        compositionId: "Hello",
        width: 320,
        height: 180,
        fps: 30,
        durationInFrames: 30,
        metadata: { label: "Hi", description: "greeting" },
      });
    } finally {
      await cleanup();
    }
  });

  it("collects per-entryPoint errors instead of failing the request", async () => {
    const { templateRoot, outputDir, cleanup } = await makeFixture();
    try {
      const queue = new FakeQueue(new Error("bundler exploded"), () =>
        Promise.reject(new Error("unused")),
      );
      const ctx = makeCtx({
        config: { templateRoots: [templateRoot], outputDir },
        queue,
      });
      const { req, res, capture } = makeReqRes({
        method: "GET",
        url: "/remotion/templates",
      });
      await handleTemplates(req, res, ctx);
      expect(capture.statusCode).toBe(200);
      const body = JSON.parse(capture.body);
      expect(body.templates).toEqual([]);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].reason).toContain("bundler exploded");
    } finally {
      await cleanup();
    }
  });

  it("rejects non-GET", async () => {
    const ctx = makeCtx({
      config: { templateRoots: ["/x"], outputDir: "/x" },
      queue: new FakeQueue([], () => Promise.reject(new Error("x"))),
    });
    const { req, res, capture } = makeReqRes({ method: "POST", url: "/remotion/templates" });
    await handleTemplates(req, res, ctx);
    expect(capture.statusCode).toBe(405);
  });
});

describe("POST /remotion/render", () => {
  it("enqueues a render and returns 202 + a queued snapshot", async () => {
    const { templateRoot, entryPoint, outputDir, cleanup } = await makeFixture();
    try {
      const queue = new FakeQueue([], async (_job: RenderJobRequest, outputPath: string) => {
        // Pretend the worker wrote 1234 bytes to outputPath.
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, Buffer.alloc(1234));
        return { outputPath, sizeBytes: 1234, durationMs: 100 };
      });
      const ctx = makeCtx({
        config: { templateRoots: [templateRoot], outputDir },
        queue,
      });
      const { req, res, capture } = makeReqRes({
        method: "POST",
        url: "/remotion/render",
        body: JSON.stringify({
          kind: "video",
          entryPoint,
          compositionId: "Hello",
          inputProps: { tint: "#22c55e" },
        }),
      });
      await handleRenderSubmit(req, res, ctx);
      expect(capture.statusCode).toBe(202);
      const body = JSON.parse(capture.body);
      expect(body.job.status).toBe("queued");
      expect(body.job.kind).toBe("video");
      expect(body.artifactUrl).toContain(`/remotion/jobs/${body.job.jobId}/artifact`);
      // Wait for the async pipeline to flip to done.
      await waitFor(() => ctx.jobs.get(body.job.jobId)?.status === "done");
      const finished = ctx.jobs.get(body.job.jobId);
      expect(finished?.status).toBe("done");
      expect(finished?.sizeBytes).toBe(1234);
      expect(finished?.outputPath).toBeDefined();
      // Media library registration should have produced a path under
      // ${OPENCLAW_STATE_DIR}/media/outbound/.
      expect(finished?.mediaLibraryPath).toContain(path.join("media", "outbound"));
    } finally {
      await cleanup();
    }
  });

  it("returns 403 when entryPoint is outside templateRoots", async () => {
    const { templateRoot, outputDir, cleanup } = await makeFixture();
    try {
      const queue = new FakeQueue([], () => Promise.reject(new Error("unused")));
      const ctx = makeCtx({
        config: { templateRoots: [templateRoot], outputDir },
        queue,
      });
      const { req, res, capture } = makeReqRes({
        method: "POST",
        url: "/remotion/render",
        body: JSON.stringify({
          kind: "video",
          entryPoint: "/etc/passwd",
          compositionId: "X",
        }),
      });
      await handleRenderSubmit(req, res, ctx);
      expect(capture.statusCode).toBe(403);
      const body = JSON.parse(capture.body);
      expect(body.error).toBe("template_rejected");
    } finally {
      await cleanup();
    }
  });

  it("returns 400 on invalid JSON body", async () => {
    const ctx = makeCtx({
      config: { templateRoots: ["/x"], outputDir: "/y" },
      queue: new FakeQueue([], () => Promise.reject(new Error("x"))),
    });
    const { req, res, capture } = makeReqRes({
      method: "POST",
      url: "/remotion/render",
      body: "{not valid",
    });
    await handleRenderSubmit(req, res, ctx);
    expect(capture.statusCode).toBe(400);
    const body = JSON.parse(capture.body);
    expect(body.error).toBe("bad_request");
  });

  it("returns 400 when kind is missing", async () => {
    const ctx = makeCtx({
      config: { templateRoots: ["/x"], outputDir: "/y" },
      queue: new FakeQueue([], () => Promise.reject(new Error("x"))),
    });
    const { req, res, capture } = makeReqRes({
      method: "POST",
      url: "/remotion/render",
      body: JSON.stringify({ entryPoint: "/x", compositionId: "Y" }),
    });
    await handleRenderSubmit(req, res, ctx);
    expect(capture.statusCode).toBe(400);
  });
});

describe("GET /remotion/jobs/:jobId", () => {
  it("returns the snapshot when found, 404 otherwise", async () => {
    const ctx = makeCtx({
      config: { templateRoots: ["/x"], outputDir: "/y" },
      queue: new FakeQueue([], () => Promise.reject(new Error("x"))),
    });
    const job = ctx.jobs.enqueue({
      kind: "video",
      jobId: "deadbeef",
      request: { entryPoint: "/x", compositionId: "Y" },
    });
    const handler = makeJobLookupHandler(extractJobIdFromPath);

    {
      const { req, res, capture } = makeReqRes({
        method: "GET",
        url: `/remotion/jobs/${job.jobId}`,
      });
      await handler(req, res, ctx);
      expect(capture.statusCode).toBe(200);
      const body = JSON.parse(capture.body);
      expect(body.job.jobId).toBe("deadbeef");
      // queued → no artifactUrl yet
      expect(body.artifactUrl).toBeNull();
    }

    {
      const { req, res, capture } = makeReqRes({
        method: "GET",
        url: "/remotion/jobs/missing",
      });
      await handler(req, res, ctx);
      expect(capture.statusCode).toBe(404);
    }
  });
});

describe("GET /remotion/history", () => {
  it("returns most recent jobs first, capped by limit", async () => {
    const ctx = makeCtx({
      config: { templateRoots: ["/x"], outputDir: "/y" },
      queue: new FakeQueue([], () => Promise.reject(new Error("x"))),
    });
    for (let i = 0; i < 3; i++) {
      ctx.jobs.enqueue({
        kind: "video",
        jobId: `id-${i}`,
        request: { entryPoint: "/x", compositionId: "Y" },
      });
    }
    const { req, res, capture } = makeReqRes({
      method: "GET",
      url: "/remotion/history?limit=2",
    });
    await handleHistory(req, res, ctx);
    expect(capture.statusCode).toBe(200);
    const body = JSON.parse(capture.body);
    expect(body.jobs).toHaveLength(2);
    expect(body.jobs[0].job.jobId).toBe("id-2");
    expect(body.jobs[1].job.jobId).toBe("id-1");
  });
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}
