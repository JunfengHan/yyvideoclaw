// Tests for HTTP route handlers — currently just GET /remotion/status.
//
// We exercise the handlers directly with a tiny IncomingMessage / ServerResponse
// fake. This avoids having to spin up an actual http server in unit tests; the
// e2e suite covers the wired-up plugin host case.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { RenderQueue } from "../render-queue.js";
import type { RemotionPluginConfig } from "../types.js";
import { JobsStore } from "./jobs-store.js";
import { handleStatus, type RouteContext } from "./routes.js";

// ---------------------------------------------------------------------------
// Fake req/res.
// ---------------------------------------------------------------------------

interface ResCapture {
  statusCode?: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
}

function makeReq(
  method: string,
  url = "/remotion/status",
): {
  req: Parameters<typeof handleStatus>[0];
  capture: ResCapture;
  res: Parameters<typeof handleStatus>[1];
} {
  const req = Object.assign(new EventEmitter(), {
    method,
    url,
    headers: {},
  }) as unknown as Parameters<typeof handleStatus>[0];

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

function makeCtx(overrides: Partial<RemotionPluginConfig> = {}): RouteContext {
  const config: RemotionPluginConfig = {
    templateRoots: ["/abs/templates"],
    outputDir: "/abs/out",
    cacheDir: "/abs/cache",
    jobTimeoutMs: 60_000,
    maxOutputBytes: 1024,
    allowNetwork: false,
    ...overrides,
  };
  return {
    config,
    queue: new RenderQueue({ jobTimeoutMs: config.jobTimeoutMs }),
    jobs: new JobsStore(),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as RouteContext["logger"],
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("handleStatus", () => {
  it("returns 200 + canonical JSON for GET", async () => {
    const { req, res, capture } = makeReq("GET");
    const ctx = makeCtx();
    const handled = await handleStatus(req, res, ctx);
    expect(handled).toBe(true);
    expect(capture.statusCode).toBe(200);
    expect(capture.headers["content-type"]).toBe("application/json; charset=utf-8");
    const body = JSON.parse(capture.body);
    expect(body).toEqual({
      enabled: true,
      templateRoots: ["/abs/templates"],
      outputDir: "/abs/out",
      jobsActive: 0,
      jobsTotal: 0,
    });
  });

  it("supports HEAD by writing only headers", async () => {
    const { req, res, capture } = makeReq("HEAD");
    const ctx = makeCtx();
    await handleStatus(req, res, ctx);
    expect(capture.statusCode).toBe(200);
    expect(capture.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(capture.body).toBe(""); // HEAD has no body
  });

  it("rejects non-GET/HEAD methods with 405 + Allow header", async () => {
    const { req, res, capture } = makeReq("POST");
    const ctx = makeCtx();
    await handleStatus(req, res, ctx);
    expect(capture.statusCode).toBe(405);
    expect(capture.headers["allow"]).toBe("GET, HEAD");
    const body = JSON.parse(capture.body);
    expect(body.error).toBe("method_not_allowed");
  });

  it("counts running + queued jobs in jobsActive", async () => {
    const { req, res, capture } = makeReq("GET");
    const ctx = makeCtx();
    const queued = ctx.jobs.enqueue({ kind: "video", request: { entryPoint: "/abs/x" } });
    const running = ctx.jobs.enqueue({ kind: "video", request: { entryPoint: "/abs/x" } });
    ctx.jobs.markRunning(running.jobId);
    const done = ctx.jobs.enqueue({ kind: "video", request: { entryPoint: "/abs/x" } });
    ctx.jobs.markDone(done.jobId, { outputPath: "/o", sizeBytes: 1, durationMs: 1 });
    void queued;
    await handleStatus(req, res, ctx);
    const body = JSON.parse(capture.body);
    expect(body.jobsActive).toBe(2); // queued + running
    expect(body.jobsTotal).toBe(3);
  });

  it("does not leak templateRoots reference (returns a copy)", async () => {
    const { req, res, capture } = makeReq("GET");
    const ctx = makeCtx();
    await handleStatus(req, res, ctx);
    const body = JSON.parse(capture.body);
    // Mutating the response should not affect ctx
    body.templateRoots.push("/evil");
    expect(ctx.config.templateRoots).toEqual(["/abs/templates"]);
  });
});
