// Video Studio runtime plugin.
//
// This extension is the bridge that makes the Video Studio tab *actually* work.
// Without it, the UI view is rendered in a permanent "starting" placeholder
// state because nothing in the main process ever instantiates
// PixelleBackendSupervisor. See the notes at app-render.ts line 2428.
//
// Responsibilities:
//
//   1. Instantiate a single PixelleBackendSupervisor + VideoStudioInstaller
//      lazily on first HTTP request.
//   2. Expose a tiny JSON-over-HTTP surface under /video-studio/*:
//
//        GET  /video-studio/status          → current supervisor snapshot
//        POST /video-studio/install         → provision the Pixelle venv
//        POST /video-studio/start           → spawn the Pixelle subprocess
//        POST /video-studio/stop            → graceful shutdown
//        GET  /video-studio/preflight       → ffmpeg / playwright probes
//        POST /video-studio/proxy/*         → authenticated passthrough to
//                                            the Pixelle loopback backend so
//                                            the browser never needs the
//                                            ephemeral internal token.
//
// The routes use `auth: "gateway"` so they sit behind yyvideoclaw's normal
// bearer / password auth — the Control UI's existing fetch helpers "just
// work" against them.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  PixelleBackendSupervisor,
  VideoStudioInstaller,
  runPreflight,
  type BackendResolution,
  type LogLine,
  type SupervisorStartResult,
  type SupervisorStatus,
} from "../../src/video-studio/index.js";

// ---------------------------------------------------------------------------
// Shared per-plugin singletons.
// ---------------------------------------------------------------------------

type RuntimeState = {
  readonly installer: VideoStudioInstaller;
  supervisor: PixelleBackendSupervisor | null;
  latestStart: SupervisorStartResult | null;
  recentLogs: LogLine[];
};

const RUNTIME_SYMBOL = Symbol.for("openclaw.video-studio.runtime");
type GlobalWithRuntime = typeof globalThis & { [RUNTIME_SYMBOL]?: RuntimeState };

function getRuntime(): RuntimeState {
  const g = globalThis as GlobalWithRuntime;
  if (g[RUNTIME_SYMBOL]) {
    return g[RUNTIME_SYMBOL]!;
  }
  const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
  const userDataRoot = path.join(homedir(), ".openclaw");
  const installer = new VideoStudioInstaller(
    { repoRoot, userDataRoot, platform: detectPlatformTag() },
    {
      fs: {
        existsSync,
        readFileSync: (p: string, enc: "utf8") =>
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- tight runtime coupling: avoid pulling the whole fs/promises surface for one read.
          require("node:fs").readFileSync(p, enc),
        writeFileSync: (p: string, data: string, enc: "utf8") =>
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto; injector-style deps kept narrow.
          require("node:fs").writeFileSync(p, data, enc),
        mkdirSync: (p: string, opts?: { recursive?: boolean }) =>
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto.
          require("node:fs").mkdirSync(p, opts),
        rmSync: (p: string, opts?: { recursive?: boolean; force?: boolean }) =>
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto.
          require("node:fs").rmSync(p, opts),
        statSync: (p: string) =>
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto.
          require("node:fs").statSync(p),
      },
      path,
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      spawnSync: require("node:child_process").spawnSync,
    },
  );
  const state: RuntimeState = {
    installer,
    supervisor: null,
    latestStart: null,
    recentLogs: [],
  };
  g[RUNTIME_SYMBOL] = state;
  return state;
}

function detectPlatformTag():
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "win32-x64"
  | "win32-arm64" {
  const p =
    process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "win32";
  const a = process.arch === "arm64" ? "arm64" : "x64";
  return `${p}-${a}` as ReturnType<typeof detectPlatformTag>;
}

// ---------------------------------------------------------------------------
// Supervisor helpers.
// ---------------------------------------------------------------------------

async function allocateEphemeralPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createTcpServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => {
        if (typeof addr === "object" && addr && "port" in addr) {
          resolve(addr.port);
        } else {
          reject(new Error("unexpected address shape from TCP server"));
        }
      });
    });
  });
}

function ensureSupervisor(state: RuntimeState): PixelleBackendSupervisor {
  if (state.supervisor) {
    return state.supervisor;
  }
  const resolution: BackendResolution = state.installer.resolve();
  const supervisor = new PixelleBackendSupervisor(
    resolution,
    {
      // UI → Gateway loopback; Pixelle dials back to yyvideoclaw's LLM shim.
      gatewayBaseUrl: `http://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT ?? "18789"}/v1`,
      internalToken: process.env.OPENCLAW_VIDEO_STUDIO_INTERNAL_TOKEN ?? "dev-local",
      agentId: "openclaw/llm-passthrough",
      defaultModel: process.env.OPENCLAW_VIDEO_STUDIO_DEFAULT_MODEL ?? "qwen/qwen3.5-plus",
      dataRoot: path.join(homedir(), ".openclaw", "video-studio"),
      onLogLine: (line: LogLine) => {
        state.recentLogs.push(line);
        if (state.recentLogs.length > 200) {
          state.recentLogs.splice(0, state.recentLogs.length - 200);
        }
      },
    },
    {
      spawn: (command, args, options) =>
        spawn(command, [...args], {
          env: options.env,
          cwd: options.cwd,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      fetch: async (url, opts) => {
        const res = await fetch(url, { signal: opts.signal });
        return { ok: res.ok };
      },
      allocatePort: allocateEphemeralPort,
      timers: {
        setTimeout: (cb, ms) => {
          const handle = setTimeout(cb, ms);
          return {
            cancel: () => {
              clearTimeout(handle);
            },
          };
        },
        now: () => Date.now(),
      },
    },
  );
  state.supervisor = supervisor;
  return supervisor;
}

// ---------------------------------------------------------------------------
// HTTP helpers.
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): boolean {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
  return true;
}

function asResolutionWireShape(r: BackendResolution) {
  return r.kind === "missing"
    ? { kind: "missing" as const, reason: r.reason }
    : r.kind === "binary"
      ? { kind: "binary" as const, version: r.version }
      : { kind: "venv" as const, version: r.version };
}

function asStatusWireShape(s: SupervisorStatus) {
  switch (s.state) {
    case "running":
      return {
        kind: "running" as const,
        pid: s.pid,
        port: s.port,
        startedAt: s.startedAt.toISOString(),
      };
    case "starting":
      return { kind: "starting" as const, attempt: s.attempt };
    case "retrying":
      return {
        kind: "retrying" as const,
        attempt: s.attempt,
        retryInMs: s.retryInMs,
        reason: s.reason,
      };
    case "stopped":
      return { kind: "stopped" as const, reason: s.reason };
    case "idle":
    default:
      return { kind: "idle" as const };
  }
}

function mapSupervisorStatusToBackendState(s: SupervisorStatus) {
  // This mirrors the BackendState type expected by `<video-studio-view>`
  // (see ui/src/ui/video-studio/view-helpers.ts). The mapping is deliberate:
  // - "missing" is derived from installer.resolve() upstream and surfaced as
  //   "not-installed" in the view; here we only report supervisor-level
  //   states.
  // - "retrying" / "stopped" collapse to "error" for the view's card layout.
  switch (s.state) {
    case "running":
      return { kind: "ready" as const };
    case "starting":
      return { kind: "starting" as const };
    case "retrying":
      return { kind: "error" as const, reason: `retrying (attempt ${s.attempt}): ${s.reason}` };
    case "stopped":
      return { kind: "error" as const, reason: s.reason };
    case "idle":
    default:
      return { kind: "starting" as const };
  }
}

// ---------------------------------------------------------------------------
// Route handlers.
// ---------------------------------------------------------------------------

async function handleStatus(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  void req;
  const state = getRuntime();
  const resolution = state.installer.resolve();
  const supervisorStatus: SupervisorStatus = state.supervisor
    ? state.supervisor.getStatus()
    : { state: "idle" };
  const backend =
    resolution.kind === "missing"
      ? { kind: "missing" as const, reason: resolution.reason }
      : mapSupervisorStatusToBackendState(supervisorStatus);
  return json(res, 200, {
    resolution: asResolutionWireShape(resolution),
    supervisor: asStatusWireShape(supervisorStatus),
    backend,
    endpoint: state.latestStart?.endpoint ?? null,
    recentLogTail: state.recentLogs.slice(-20),
  });
}

async function handleInstall(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "POST") {
    return json(res, 405, { error: "method_not_allowed" });
  }
  const state = getRuntime();
  try {
    // Pin to the sibling yy-Pixelle-Video source checkout when available so
    // developers get a predictable, reproducible install without waiting for
    // a PyPI publish.
    const pixelleSrc = path.resolve(
      new URL("../..", import.meta.url).pathname,
      "..",
      "yy-Pixelle-Video",
    );
    const requirement = existsSync(pixelleSrc) ? `-e ${pixelleSrc}` : "pixelle-video";
    state.installer.install({ pixelleRequirement: requirement, version: "local" });
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, 500, {
      error: "install_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleStart(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "POST") {
    return json(res, 405, { error: "method_not_allowed" });
  }
  const state = getRuntime();
  const resolution = state.installer.resolve();
  if (resolution.kind === "missing") {
    return json(res, 409, { error: "not_installed", reason: resolution.reason });
  }
  try {
    const supervisor = ensureSupervisor(state);
    state.latestStart = await supervisor.startIfNeeded();
    return json(res, 200, {
      ok: true,
      endpoint: state.latestStart.endpoint,
      pid: state.latestStart.pid,
      port: state.latestStart.port,
    });
  } catch (err) {
    return json(res, 500, {
      error: "start_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleStop(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "POST") {
    return json(res, 405, { error: "method_not_allowed" });
  }
  const state = getRuntime();
  if (!state.supervisor) {
    return json(res, 200, { ok: true, note: "not running" });
  }
  try {
    await state.supervisor.stop("control-ui requested stop");
    state.latestStart = null;
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, 500, {
      error: "stop_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handlePreflight(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  void req;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- spawnSync is injected narrowly on purpose.
    const { spawnSync } = require("node:child_process");
    const report = runPreflight({ spawnSync, platform: process.platform });
    return json(res, 200, report);
  } catch (err) {
    return json(res, 500, {
      error: "preflight_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleProxy(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const state = getRuntime();
  const endpoint = state.latestStart?.endpoint;
  if (!endpoint) {
    return json(res, 503, { error: "backend_not_ready" });
  }
  const requestUrl = req.url ?? "";
  // The registered path uses match="prefix", so strip the prefix to get the
  // Pixelle-side path (everything after /video-studio/proxy).
  const prefix = "/video-studio/proxy";
  const suffix = requestUrl.startsWith(prefix) ? requestUrl.slice(prefix.length) : requestUrl;
  const target = `${endpoint}${suffix || "/"}`;
  // Buffer the incoming body (these are short JSON requests); streaming is
  // not needed for the MVP generate / status / templates endpoints.
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  try {
    const upstream = await fetch(target, {
      method: req.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        // Pixelle embedded mode accepts an internal bearer; this stays on
        // loopback and is never exposed to the browser.
        authorization: `Bearer ${process.env.OPENCLAW_VIDEO_STUDIO_INTERNAL_TOKEN ?? "dev-local"}`,
      },
      body,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = upstream.status;
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);
    res.end(buf);
    return true;
  } catch (err) {
    return json(res, 502, {
      error: "proxy_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Plugin entry.
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: "video-studio",
  name: "Video Studio",
  description:
    "Embedded yy-Pixelle-Video runtime. Hosts the supervisor + installer and exposes /video-studio/* routes for the Control UI.",
  register(api) {
    api.registerHttpRoute({
      path: "/video-studio/status",
      match: "exact",
      auth: "gateway",
      handler: handleStatus,
    });
    api.registerHttpRoute({
      path: "/video-studio/install",
      match: "exact",
      auth: "gateway",
      handler: handleInstall,
    });
    api.registerHttpRoute({
      path: "/video-studio/start",
      match: "exact",
      auth: "gateway",
      handler: handleStart,
    });
    api.registerHttpRoute({
      path: "/video-studio/stop",
      match: "exact",
      auth: "gateway",
      handler: handleStop,
    });
    api.registerHttpRoute({
      path: "/video-studio/preflight",
      match: "exact",
      auth: "gateway",
      handler: handlePreflight,
    });
    api.registerHttpRoute({
      path: "/video-studio/proxy",
      match: "prefix",
      auth: "gateway",
      handler: handleProxy,
    });
  },
});
