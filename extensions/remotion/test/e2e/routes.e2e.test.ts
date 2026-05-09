// True end-to-end tests for the HTTP routes against the production dist.
//
// Unlike `routes-pipeline.test.ts` (uses FakeQueue), this file:
//   - Loads the BUILT plugin from dist/extensions/remotion/index.js, the
//     same artifact OpenClaw boots in production.
//   - Lets the real RenderQueue spawn a real Chromium-driven worker.
//   - Reads/writes real disk under sandboxed temp dirs.
//
// Gating (matches the pattern set by render.e2e.test.ts):
//   1. Filename ends in `.e2e.test.ts` so the default vitest lane skips it.
//   2. `OPENCLAW_REMOTION_E2E=1` env var must be set, otherwise describe
//      becomes describe.skip.
//
// Run with:
//   OPENCLAW_REMOTION_E2E=1 OPENCLAW_E2E_VERBOSE=1 \
//     pnpm test:e2e extensions/remotion/test/e2e/routes.e2e.test.ts
//
// What we cover:
//   GET /remotion/status          → enabled, templateRoots, jobsActive
//   GET /remotion/templates       → fixture compositions + sidecar metadata
//   POST /remotion/render → poll  → runs Remotion bundler+renderer end-to-end
//   GET /remotion/jobs/:id        → done with mediaLibraryPath populated
//   GET /remotion/jobs/:id/artifact          → 200 + Accept-Ranges + bytes
//   GET /.../artifact (Range:bytes=0-99)     → 206 + Content-Range
//   GET /.../artifact (Range:bytes=99999999-) → 416

import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const E2E_ENABLED = process.env.OPENCLAW_REMOTION_E2E === "1";
const describeE2e = E2E_ENABLED ? describe : describe.skip;

interface ResCapture {
  statusCode?: number;
  headers: Record<string, string>;
  body: Buffer;
  ended: boolean;
}

interface RegisteredRoute {
  path: string;
  match: "exact" | "prefix";
  handler: (req: unknown, res: unknown) => Promise<boolean>;
}

interface PluginHarness {
  routes: RegisteredRoute[];
  tools: Array<{ name: string }>;
  /** Resolved config the plugin saw. */
  pluginConfig: Record<string, unknown>;
}

/** Spin up a fresh plugin instance with the given config. */
async function loadPlugin(pluginConfig: Record<string, unknown>): Promise<PluginHarness> {
  const distPath = "/Users/johnhan/Desktop/myself/yyvideoclaw/dist/extensions/remotion/index.js";
  const mod = await import(distPath);
  const plugin = (mod as { default?: { register: (api: unknown) => unknown } }).default ?? mod;
  const routes: RegisteredRoute[] = [];
  const tools: Array<{ name: string }> = [];
  const api = {
    pluginConfig,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    registerTool: (tool: { name: string }) => tools.push(tool),
    registerCommand: () => {},
    registerHook: () => {},
    registerService: () => {},
    registerHttpRoute: (route: RegisteredRoute) => routes.push(route),
    config: {},
    runtime: {},
  };
  await (plugin as { register: (api: unknown) => Promise<unknown> | unknown }).register(api);
  return { routes, tools, pluginConfig };
}

/** Match a URL against the registered routes in registration order. */
function findRoute(routes: RegisteredRoute[], pathname: string): RegisteredRoute | undefined {
  for (const r of routes) {
    if (r.match === "exact" && r.path === pathname) {
      return r;
    }
    if (r.match === "prefix" && pathname.startsWith(r.path)) {
      return r;
    }
  }
  return undefined;
}

/** Full request/response simulation that mimics what the gateway provides. */
async function callRoute(
  routes: RegisteredRoute[],
  opts: {
    method: string;
    url: string;
    body?: string;
    range?: string;
  },
): Promise<ResCapture> {
  const url = new URL(opts.url, "http://internal");
  const route = findRoute(routes, url.pathname);
  if (!route) {
    throw new Error(`no route for ${opts.url}`);
  }

  const headers: Record<string, string> = {};
  if (opts.range) {
    headers.range = opts.range;
  }
  const reqEvents = new EventEmitter();
  const req = Object.assign(reqEvents, {
    method: opts.method,
    url: opts.url,
    headers,
    destroy: () => undefined,
  });
  if (opts.body !== undefined) {
    queueMicrotask(() => {
      reqEvents.emit("data", Buffer.from(opts.body!, "utf8"));
      reqEvents.emit("end");
    });
  } else {
    queueMicrotask(() => reqEvents.emit("end"));
  }

  const capture: ResCapture = { headers: {}, body: Buffer.alloc(0), ended: false };
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

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
  sink.destroy = () => resolveDone();

  await route.handler(req, sink);
  await done;
  return capture;
}

async function pollUntilDone(
  routes: RegisteredRoute[],
  jobId: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<{ status: string; body: Record<string, unknown> }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await callRoute(routes, {
      method: "GET",
      url: `/remotion/jobs/${jobId}`,
    });
    const body = JSON.parse(r.body.toString("utf8")) as { job: { status: string } } & Record<
      string,
      unknown
    >;
    if (
      body.job.status === "done" ||
      body.job.status === "error" ||
      body.job.status === "cancelled"
    ) {
      return { status: body.job.status, body };
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`pollUntilDone timed out for job ${jobId}`);
}

// ---------------------------------------------------------------------------
// Suite.
// ---------------------------------------------------------------------------

const fixtureRoot = path.join(import.meta.dirname, "fixtures", "minimal-project");

let stateDir = "";
let outputDir = "";
let plugin: PluginHarness;
const originalState = process.env.OPENCLAW_STATE_DIR;

describeE2e("remotion HTTP routes — end-to-end (production dist)", () => {
  beforeAll(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-routes-e2e-state-"));
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-routes-e2e-out-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    plugin = await loadPlugin({
      templateRoots: [await fs.realpath(fixtureRoot)],
      outputDir,
      jobTimeoutMs: 5 * 60 * 1000,
      maxOutputBytes: 50 * 1024 * 1024,
      allowNetwork: false,
    });
  }, 60_000);

  afterAll(async () => {
    if (originalState === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalState;
    }
    await Promise.allSettled([
      fs.rm(stateDir, { recursive: true, force: true }),
      fs.rm(outputDir, { recursive: true, force: true }),
    ]);
  });

  it("registers all expected routes and tools", () => {
    const paths = plugin.routes.map((r) => `${r.path}|${r.match}`);
    expect(paths).toContain("/remotion/status|exact");
    expect(paths).toContain("/remotion/templates|exact");
    expect(paths).toContain("/remotion/render|exact");
    expect(paths).toContain("/remotion/history|exact");
    expect(paths).toContain("/remotion/jobs/|prefix");
    const toolNames = plugin.tools.map((t) => t.name);
    expect(toolNames).toEqual([
      "remotion_list_compositions",
      "remotion_render_video",
      "remotion_render_still",
    ]);
  });

  it("GET /remotion/status returns enabled + templateRoots", async () => {
    const r = await callRoute(plugin.routes, { method: "GET", url: "/remotion/status" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body.toString("utf8"));
    expect(body.enabled).toBe(true);
    expect(body.templateRoots).toHaveLength(1);
    expect(body.templateRoots[0]).toContain("minimal-project");
  });

  it(
    "GET /remotion/templates → real bundler + sidecar metadata merge",
    async () => {
      const r = await callRoute(plugin.routes, {
        method: "GET",
        url: "/remotion/templates",
      });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body.toString("utf8"));
      expect(body.errors).toEqual([]);
      expect(body.templates).toHaveLength(1);
      expect(body.templates[0].metadataAvailable).toBe(true);
      const comps = body.templates[0].compositions as Array<{
        compositionId: string;
        width: number;
        metadata?: { label?: string };
      }>;
      expect(comps).toHaveLength(1);
      expect(comps[0]?.compositionId).toBe("HelloWorld");
      expect(comps[0]?.width).toBe(320);
      expect(comps[0]?.metadata?.label).toBe("Hello World");
    },
    5 * 60 * 1000,
  );

  it(
    "POST /render → poll → GET /artifact (full body + Accept-Ranges)",
    async () => {
      const fixtureRealRoot = await fs.realpath(fixtureRoot);
      const submit = await callRoute(plugin.routes, {
        method: "POST",
        url: "/remotion/render",
        body: JSON.stringify({
          kind: "video",
          entryPoint: path.join(fixtureRealRoot, "src", "index.ts"),
          compositionId: "HelloWorld",
          inputProps: { tint: "#0ea5e9" },
        }),
      });
      expect(submit.statusCode).toBe(202);
      const submitBody = JSON.parse(submit.body.toString("utf8"));
      expect(submitBody.job.status).toBe("queued");
      const jobId = submitBody.job.jobId as string;

      const { status, body } = await pollUntilDone(plugin.routes, jobId);
      expect(status).toBe("done");
      const finished = body.job as {
        sizeBytes?: number;
        outputPath?: string;
        mediaLibraryPath?: string;
      };
      expect(finished.sizeBytes).toBeGreaterThan(0);
      expect(finished.outputPath).toBeDefined();
      // Media library registration should have populated this path inside
      // OPENCLAW_STATE_DIR/media/outbound/.
      expect(finished.mediaLibraryPath).toContain(path.join("media", "outbound"));

      // Full-body fetch.
      const full = await callRoute(plugin.routes, {
        method: "GET",
        url: `/remotion/jobs/${jobId}/artifact`,
      });
      expect(full.statusCode).toBe(200);
      expect(full.headers["accept-ranges"]).toBe("bytes");
      expect(full.headers["content-type"]).toBe("video/mp4");
      expect(full.body.length).toBe(finished.sizeBytes);

      // Range fetch (first 100 bytes).
      const ranged = await callRoute(plugin.routes, {
        method: "GET",
        url: `/remotion/jobs/${jobId}/artifact`,
        range: "bytes=0-99",
      });
      expect(ranged.statusCode).toBe(206);
      expect(ranged.headers["content-range"]).toBe(`bytes 0-99/${finished.sizeBytes}`);
      expect(ranged.body.length).toBe(100);

      // Out-of-bounds range.
      const oob = await callRoute(plugin.routes, {
        method: "GET",
        url: `/remotion/jobs/${jobId}/artifact`,
        range: "bytes=99999999-",
      });
      expect(oob.statusCode).toBe(416);
      expect(oob.headers["content-range"]).toBe(`bytes */${finished.sizeBytes}`);
    },
    5 * 60 * 1000,
  );

  it("GET /remotion/history includes the recent render", async () => {
    const r = await callRoute(plugin.routes, {
      method: "GET",
      url: "/remotion/history?limit=5",
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body.toString("utf8")) as {
      jobs: Array<{ job: { status: string } }>;
    };
    expect(body.jobs.length).toBeGreaterThanOrEqual(1);
    expect(body.jobs[0]?.job.status).toBe("done");
  });

  it("rejects entryPoint outside templateRoots with 403", async () => {
    const r = await callRoute(plugin.routes, {
      method: "POST",
      url: "/remotion/render",
      body: JSON.stringify({
        kind: "video",
        entryPoint: "/etc/passwd",
        compositionId: "X",
      }),
    });
    expect(r.statusCode).toBe(403);
    const body = JSON.parse(r.body.toString("utf8"));
    expect(body.error).toBe("template_rejected");
  });
});
