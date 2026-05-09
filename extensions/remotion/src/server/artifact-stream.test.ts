// Tests for the artifact streaming route — focused on Range header semantics
// because that's where Webkit `<video>` regressions tend to hide.

import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RenderQueue } from "../render-queue.js";
import { extractArtifactJobId, handleArtifactStream, parseRangeHeader } from "./artifact-stream.js";
import { JobsStore } from "./jobs-store.js";
import type { RouteContext } from "./routes.js";

// ---------------------------------------------------------------------------
// parseRangeHeader unit tests — pure function; no I/O needed.
// ---------------------------------------------------------------------------

describe("parseRangeHeader", () => {
  it("treats absent header as absent", () => {
    expect(parseRangeHeader(undefined, 100)).toEqual({ kind: "absent" });
    expect(parseRangeHeader("", 100)).toEqual({ kind: "absent" });
  });

  it("parses standard byte range", () => {
    expect(parseRangeHeader("bytes=0-99", 1000)).toEqual({ kind: "ok", start: 0, end: 99 });
  });

  it("parses open-ended range as up-to-end", () => {
    expect(parseRangeHeader("bytes=500-", 1000)).toEqual({ kind: "ok", start: 500, end: 999 });
  });

  it("parses suffix range as last N bytes", () => {
    expect(parseRangeHeader("bytes=-200", 1000)).toEqual({ kind: "ok", start: 800, end: 999 });
  });

  it("rejects malformed unit prefix", () => {
    expect(parseRangeHeader("foo=0-99", 1000)).toEqual({ kind: "malformed" });
    expect(parseRangeHeader("0-99", 1000)).toEqual({ kind: "malformed" });
  });

  it("returns unsatisfiable when range exceeds file size", () => {
    expect(parseRangeHeader("bytes=1000-2000", 500).kind).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=999999-", 100).kind).toBe("unsatisfiable");
  });

  it("returns unsatisfiable on empty file", () => {
    expect(parseRangeHeader("bytes=0-0", 0).kind).toBe("unsatisfiable");
  });

  it("rejects malformed empty start+end", () => {
    expect(parseRangeHeader("bytes=-", 100).kind).toBe("malformed");
  });

  it("rejects start > end", () => {
    expect(parseRangeHeader("bytes=200-100", 1000).kind).toBe("unsatisfiable");
  });

  it("clamps suffix range when N >= total size", () => {
    expect(parseRangeHeader("bytes=-9999", 100)).toEqual({ kind: "ok", start: 0, end: 99 });
  });
});

// ---------------------------------------------------------------------------
// extractArtifactJobId
// ---------------------------------------------------------------------------

describe("extractArtifactJobId", () => {
  function reqWithUrl(url: string) {
    return Object.assign(new EventEmitter(), {
      method: "GET",
      url,
      headers: {},
    }) as unknown as Parameters<typeof handleArtifactStream>[0];
  }

  it("extracts the jobId from /remotion/jobs/<id>/artifact", () => {
    expect(extractArtifactJobId(reqWithUrl("/remotion/jobs/abc-123/artifact"))).toBe("abc-123");
    expect(extractArtifactJobId(reqWithUrl("/remotion/jobs/abc/artifact/"))).toBe("abc");
  });

  it("returns null on non-matching paths", () => {
    expect(extractArtifactJobId(reqWithUrl("/remotion/jobs/abc"))).toBeNull();
    expect(extractArtifactJobId(reqWithUrl("/remotion/jobs/abc/something-else"))).toBeNull();
  });

  it("URL-decodes the jobId", () => {
    expect(extractArtifactJobId(reqWithUrl("/remotion/jobs/a%20b/artifact"))).toBe("a b");
  });
});

// ---------------------------------------------------------------------------
// Full route tests — uses real temp files but no real RenderQueue.
// ---------------------------------------------------------------------------

interface ResCapture {
  statusCode?: number;
  headers: Record<string, string>;
  body: Buffer;
  ended: boolean;
}

function makeReqRes(opts: { method: string; url: string; range?: string }): {
  req: Parameters<typeof handleArtifactStream>[0];
  res: Parameters<typeof handleArtifactStream>[1];
  capture: ResCapture;
  done: Promise<void>;
} {
  const headers: Record<string, string> = {};
  if (opts.range) {
    headers.range = opts.range;
  }
  const req = Object.assign(new EventEmitter(), {
    method: opts.method,
    url: opts.url,
    headers,
  }) as unknown as Parameters<typeof handleArtifactStream>[0];

  const capture: ResCapture = { headers: {}, body: Buffer.alloc(0), ended: false };
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  // We need: a writable-stream-like sink so createReadStream(...).pipe(res)
  // works, plus statusCode (assignable) and setHeader/end methods. Build
  // it with defineProperties so the setter fires when the handler does
  // `res.statusCode = N`.
  const sink = new EventEmitter() as EventEmitter & {
    statusCode: number;
    setHeader(name: string, value: string): void;
    write(chunk: Buffer | string): boolean;
    end(chunk?: Buffer | string): void;
    cork(): void;
    uncork(): void;
    destroy(): void;
  };
  Object.defineProperty(sink, "statusCode", {
    get() {
      return capture.statusCode ?? 0;
    },
    set(code: number) {
      capture.statusCode = code;
    },
    configurable: true,
    enumerable: true,
  });
  sink.setHeader = (name: string, value: string) => {
    capture.headers[name.toLowerCase()] = value;
  };
  sink.write = (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    capture.body = Buffer.concat([capture.body, buf]);
    return true;
  };
  sink.end = (chunk?: Buffer | string) => {
    if (chunk !== undefined) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      capture.body = Buffer.concat([capture.body, buf]);
    }
    capture.ended = true;
    sink.emit("finish");
    sink.emit("close");
    resolveDone();
  };
  sink.cork = () => undefined;
  sink.uncork = () => undefined;
  sink.destroy = () => {
    resolveDone();
  };
  return {
    req,
    res: sink as unknown as Parameters<typeof handleArtifactStream>[1],
    capture,
    done,
  };
}

const tempArtifacts: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempArtifacts
      .splice(0)
      .map((p) => fs.rm(p, { recursive: true, force: true }).catch(() => undefined)),
  );
});

async function makeArtifactDir(): Promise<{ outputDir: string; outputPath: string }> {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-artifact-"));
  tempArtifacts.push(outputDir);
  const jobDir = path.join(outputDir, "fixed-jobid");
  await fs.mkdir(jobDir, { recursive: true });
  const outputPath = path.join(jobDir, "out.mp4");
  // 1000 bytes of recognizable test content (incrementing byte values).
  const content = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  await fs.writeFile(outputPath, content);
  return { outputDir, outputPath };
}

function makeCtx(outputPath: string): RouteContext {
  const jobs = new JobsStore();
  jobs.enqueue({
    kind: "video",
    jobId: "fixed-jobid",
    request: { entryPoint: "/x", compositionId: "Y" },
  });
  jobs.markRunning("fixed-jobid");
  jobs.markDone("fixed-jobid", { outputPath, sizeBytes: 1000, durationMs: 100 });
  return {
    config: {
      templateRoots: [],
      outputDir: path.dirname(path.dirname(outputPath)),
      cacheDir: undefined,
      jobTimeoutMs: 60_000,
      maxOutputBytes: 100 * 1024 * 1024,
      allowNetwork: false,
    } as unknown as RouteContext["config"],
    queue: new RenderQueue({ jobTimeoutMs: 1000 }),
    jobs,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as RouteContext["logger"],
  };
}

describe("handleArtifactStream", () => {
  it("returns 404 when jobId is unknown", async () => {
    const { outputPath } = await makeArtifactDir();
    const ctx = makeCtx(outputPath);
    const { req, res, capture, done } = makeReqRes({
      method: "GET",
      url: "/remotion/jobs/unknown/artifact",
    });
    await handleArtifactStream(req, res, ctx);
    await done;
    expect(capture.statusCode).toBe(404);
  });

  it("returns 200 + full body + Accept-Ranges + Content-Length when no Range header", async () => {
    const { outputPath } = await makeArtifactDir();
    const ctx = makeCtx(outputPath);
    const { req, res, capture, done } = makeReqRes({
      method: "GET",
      url: "/remotion/jobs/fixed-jobid/artifact",
    });
    await handleArtifactStream(req, res, ctx);
    await done;
    expect(capture.statusCode).toBe(200);
    expect(capture.headers["accept-ranges"]).toBe("bytes");
    expect(capture.headers["content-type"]).toBe("video/mp4");
    expect(capture.headers["content-length"]).toBe("1000");
    expect(capture.headers["content-disposition"]).toContain("inline");
    expect(capture.body.length).toBe(1000);
    expect(capture.body[0]).toBe(0);
    expect(capture.body[255]).toBe(255);
  });

  it("returns 206 + correct Content-Range for a satisfiable range", async () => {
    const { outputPath } = await makeArtifactDir();
    const ctx = makeCtx(outputPath);
    const { req, res, capture, done } = makeReqRes({
      method: "GET",
      url: "/remotion/jobs/fixed-jobid/artifact",
      range: "bytes=10-19",
    });
    await handleArtifactStream(req, res, ctx);
    await done;
    expect(capture.statusCode).toBe(206);
    expect(capture.headers["content-range"]).toBe("bytes 10-19/1000");
    expect(capture.headers["content-length"]).toBe("10");
    expect(capture.body.length).toBe(10);
    // Bytes 10-19 should be values 10,11,...,19 per our test content
    expect(Array.from(capture.body)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it("returns 416 + Content-Range:*/N for an out-of-bounds range", async () => {
    const { outputPath } = await makeArtifactDir();
    const ctx = makeCtx(outputPath);
    const { req, res, capture, done } = makeReqRes({
      method: "GET",
      url: "/remotion/jobs/fixed-jobid/artifact",
      range: "bytes=99999-",
    });
    await handleArtifactStream(req, res, ctx);
    await done;
    expect(capture.statusCode).toBe(416);
    expect(capture.headers["content-range"]).toBe("bytes */1000");
  });

  it("supports HEAD by writing only headers", async () => {
    const { outputPath } = await makeArtifactDir();
    const ctx = makeCtx(outputPath);
    const { req, res, capture, done } = makeReqRes({
      method: "HEAD",
      url: "/remotion/jobs/fixed-jobid/artifact",
    });
    await handleArtifactStream(req, res, ctx);
    await done;
    expect(capture.statusCode).toBe(200);
    expect(capture.headers["content-length"]).toBe("1000");
    expect(capture.headers["accept-ranges"]).toBe("bytes");
    expect(capture.body.length).toBe(0);
  });

  it("returns 409 not_done while the job is still running", async () => {
    const { outputPath } = await makeArtifactDir();
    // Build ctx where the job is in `running` state (NOT done).
    const jobs = new JobsStore();
    jobs.enqueue({
      kind: "video",
      jobId: "fixed-jobid",
      request: { entryPoint: "/x", compositionId: "Y" },
    });
    jobs.markRunning("fixed-jobid");
    const ctx: RouteContext = {
      ...makeCtx(outputPath),
      jobs,
    };
    const { req, res, capture, done } = makeReqRes({
      method: "GET",
      url: "/remotion/jobs/fixed-jobid/artifact",
    });
    await handleArtifactStream(req, res, ctx);
    await done;
    expect(capture.statusCode).toBe(409);
    const body = JSON.parse(capture.body.toString("utf8"));
    expect(body.error).toBe("not_done");
    expect(body.status).toBe("running");
  });
});
