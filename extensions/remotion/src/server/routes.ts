// HTTP route handlers for the Remotion plugin.
//
// Mirrors the shape of `extensions/video-studio/index.ts:handle*` —
// `(IncomingMessage, ServerResponse) => Promise<boolean>` returning `true`
// once the response has been written. Auth is delegated to the plugin host
// (registerHttpRoute({ auth: "gateway" })); these handlers do NOT
// re-implement auth.
//
// Each handler:
//   1. Validates the HTTP method.
//   2. Parses + validates the body / params.
//   3. Calls into the shared services (template resolver, render queue,
//      jobs store, output manager).
//   4. Returns a structured JSON response on the canonical contract.
//
// Error responses NEVER contain raw filesystem paths outside the configured
// templateRoots, and never contain stdin/stdout snippets.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { logJobFinish, logJobStart, summarizeInputProps } from "../logging.js";
import { allocateJobOutput, cleanupJobDir, verifyAndMeasure } from "../output-manager.js";
import type { RenderQueue } from "../render-queue.js";
import { loadStudioSidecar, type StudioCompositionMetadata } from "../studio-sidecar.js";
import { resolveTemplateEntryPoint, TemplateResolutionError } from "../template-resolver.js";
import type { RemotionPluginConfig, RenderJobRequest } from "../types.js";
import type { JobSnapshot, JobsStore } from "./jobs-store.js";
import { registerArtifactToMediaLibrary } from "./register-media.js";

// ---------------------------------------------------------------------------
// Wire types — kept in sync with `ui/src/ui/remotion-studio/client.ts`.
// ---------------------------------------------------------------------------

export interface StatusResponse {
  enabled: true;
  templateRoots: string[];
  outputDir: string;
  jobsActive: number;
  jobsTotal: number;
}

export interface TemplateCompositionWire {
  compositionId: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  /** Optional UI metadata from a sibling `studio.json`. */
  metadata?: StudioCompositionMetadata;
}

export interface TemplateWire {
  entryPoint: string;
  compositions: TemplateCompositionWire[];
  /** When the entryPoint had no studio.json or it was malformed. */
  metadataAvailable: boolean;
}

export interface TemplatesResponse {
  templates: TemplateWire[];
  /** Per-entryPoint failures (allowlist rejection, bundler error, etc.). */
  errors: Array<{ entryPoint: string; reason: string }>;
}

export interface RenderRequestBody {
  kind: "video" | "still";
  entryPoint: string;
  compositionId: string;
  inputProps?: Record<string, unknown>;
  codec?: "h264" | "h265" | "vp8" | "vp9";
  imageFormat?: "png" | "jpeg";
  frame?: number;
}

export interface JobResponseBody {
  job: JobSnapshot;
  artifactUrl: string | null;
}

// ---------------------------------------------------------------------------
// Plumbing.
// ---------------------------------------------------------------------------

export interface RouteContext {
  config: RemotionPluginConfig;
  queue: RenderQueue;
  jobs: JobsStore;
  logger: PluginLogger;
  /** Optional HTTP base path under which the plugin is mounted. */
  basePath?: string;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
) => Promise<boolean>;

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1MB JSON cap — generous for inputProps

export function jsonResponse(res: ServerResponse, status: number, body: unknown): boolean {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  // SECURITY: never expose raw error messages that contain absolute paths
  // unless the path is under templateRoots. Callers are responsible for
  // sanitising before passing into this helper.
  res.end(JSON.stringify(body));
  return true;
}

export function methodNotAllowed(res: ServerResponse, allowed: string): boolean {
  res.setHeader("allow", allowed);
  return jsonResponse(res, 405, { error: "method_not_allowed", allowed });
}

export function notFound(res: ServerResponse, what: string): boolean {
  return jsonResponse(res, 404, { error: "not_found", detail: what });
}

export function badRequest(res: ServerResponse, detail: string): boolean {
  return jsonResponse(res, 400, { error: "bad_request", detail });
}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        reject(new Error("empty body"));
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(new Error(`invalid json: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

function artifactUrlFor(ctx: RouteContext, jobId: string): string {
  const base = ctx.basePath ? ctx.basePath.replace(/\/$/, "") : "";
  return `${base}/remotion/jobs/${encodeURIComponent(jobId)}/artifact`;
}

function describeError(err: unknown): string {
  if (err instanceof TemplateResolutionError) {
    return `template rejected (${err.code}): ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// GET /remotion/status
// ---------------------------------------------------------------------------

export const handleStatus: RouteHandler = async (req, res, ctx) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return methodNotAllowed(res, "GET, HEAD");
  }
  const recentJobs = ctx.jobs.list(200);
  const jobsActive = recentJobs.filter(
    (j) => j.status === "queued" || j.status === "running",
  ).length;
  const body: StatusResponse = {
    enabled: true,
    templateRoots: [...ctx.config.templateRoots],
    outputDir: ctx.config.outputDir,
    jobsActive,
    jobsTotal: ctx.jobs.size(),
  };
  if (req.method === "HEAD") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end();
    return true;
  }
  return jsonResponse(res, 200, body);
};

// ---------------------------------------------------------------------------
// GET /remotion/templates
//
// Iterates every configured templateRoot, attempts to resolve each
// `<root>/src/index.ts` (the conventional Remotion entry; we don't recurse
// for now), bundles + lists compositions, and merges in studio.json
// metadata. Per-entryPoint failures are returned as `errors[]` rather than
// failing the whole request — operators with multiple roots shouldn't lose
// every template just because one root is broken.
// ---------------------------------------------------------------------------

export const handleTemplates: RouteHandler = async (req, res, ctx) => {
  if (req.method !== "GET") {
    return methodNotAllowed(res, "GET");
  }

  const errors: Array<{ entryPoint: string; reason: string }> = [];
  const templates: TemplateWire[] = [];

  // Discover entry points: convention is <root>/src/index.ts. Future versions
  // may walk the directory tree, but a known filename keeps the surface tiny
  // for v1 and matches what the Phase 1 fixture uses.
  const entryCandidates = ctx.config.templateRoots.map((root) =>
    `${root}/src/index.ts`.replace(/\\/g, "/"),
  );

  for (const candidate of entryCandidates) {
    let resolvedEntry: string;
    try {
      resolvedEntry = await resolveTemplateEntryPoint({
        templateRoots: ctx.config.templateRoots,
        entryPoint: candidate,
      });
    } catch (err) {
      errors.push({ entryPoint: candidate, reason: describeError(err) });
      continue;
    }
    let compositions;
    try {
      compositions = await ctx.queue.enqueueList({
        entryPoint: resolvedEntry,
        ...(ctx.config.cacheDir ? { cacheDir: ctx.config.cacheDir } : {}),
        allowNetwork: ctx.config.allowNetwork,
      });
    } catch (err) {
      errors.push({ entryPoint: resolvedEntry, reason: describeError(err) });
      continue;
    }
    const sidecar = await loadStudioSidecar(resolvedEntry);
    templates.push({
      entryPoint: resolvedEntry,
      metadataAvailable: sidecar !== null,
      compositions: compositions.map((c): TemplateCompositionWire => {
        const meta = sidecar?.compositions[c.id];
        const wire: TemplateCompositionWire = {
          compositionId: c.id,
          width: c.width,
          height: c.height,
          fps: c.fps,
          durationInFrames: c.durationInFrames,
        };
        if (meta) {
          wire.metadata = meta;
        }
        return wire;
      }),
    });
  }

  const response: TemplatesResponse = { templates, errors };
  return jsonResponse(res, 200, response);
};

// ---------------------------------------------------------------------------
// POST /remotion/render
//
// Body shape: RenderRequestBody. Returns 202 + { job, artifactUrl } as soon
// as the job is enqueued. The render runs serially through the shared
// RenderQueue (concurrency=1), so callers must poll GET /jobs/:id.
// ---------------------------------------------------------------------------

export const handleRenderSubmit: RouteHandler = async (req, res, ctx) => {
  if (req.method !== "POST") {
    return methodNotAllowed(res, "POST");
  }

  let body: RenderRequestBody;
  try {
    body = await readJsonBody<RenderRequestBody>(req);
  } catch (err) {
    return badRequest(res, describeError(err));
  }

  // Lightweight validation; the rest is enforced by the type system at the
  // call site (we still narrow runtime values defensively).
  if (body.kind !== "video" && body.kind !== "still") {
    return badRequest(res, `kind must be "video" or "still"`);
  }
  if (typeof body.entryPoint !== "string" || body.entryPoint.length === 0) {
    return badRequest(res, "entryPoint is required");
  }
  if (typeof body.compositionId !== "string" || body.compositionId.length === 0) {
    return badRequest(res, "compositionId is required");
  }
  if (
    body.inputProps !== undefined &&
    (typeof body.inputProps !== "object" || Array.isArray(body.inputProps))
  ) {
    return badRequest(res, "inputProps must be an object");
  }

  let resolvedEntry: string;
  try {
    resolvedEntry = await resolveTemplateEntryPoint({
      templateRoots: ctx.config.templateRoots,
      entryPoint: body.entryPoint,
    });
  } catch (err) {
    return jsonResponse(res, 403, { error: "template_rejected", detail: describeError(err) });
  }

  const inputProps = body.inputProps ?? {};
  const propsSummary = summarizeInputProps(inputProps);

  // Allocate the on-disk slot first so we can pin the jobId between
  // the disk and the in-memory store.
  const allocation = await allocateJobOutput(
    ctx.config,
    body.kind === "video" ? "mp4" : body.imageFormat === "jpeg" ? "jpeg" : "png",
  );
  const jobSnapshot = ctx.jobs.enqueue({
    kind: body.kind,
    jobId: allocation.jobId,
    request: {
      entryPoint: resolvedEntry,
      compositionId: body.compositionId,
      inputPropsSummary: propsSummary,
    },
  });

  // Kick off the work without awaiting — the response returns immediately
  // with the queued snapshot. The async pipeline mutates the store as it
  // progresses.
  void runRenderPipeline({
    ctx,
    body,
    inputProps,
    propsSummary,
    resolvedEntry,
    allocation,
  });

  res.statusCode = 202;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("location", `/remotion/jobs/${encodeURIComponent(jobSnapshot.jobId)}`);
  const responseBody: JobResponseBody = {
    job: jobSnapshot,
    artifactUrl: artifactUrlFor(ctx, jobSnapshot.jobId),
  };
  res.end(JSON.stringify(responseBody));
  return true;
};

interface RunPipelineParams {
  ctx: RouteContext;
  body: RenderRequestBody;
  inputProps: Record<string, unknown>;
  propsSummary: ReturnType<typeof summarizeInputProps>;
  resolvedEntry: string;
  allocation: Awaited<ReturnType<typeof allocateJobOutput>>;
}

async function runRenderPipeline(params: RunPipelineParams): Promise<void> {
  const { ctx, body, inputProps, propsSummary, resolvedEntry, allocation } = params;

  ctx.jobs.markRunning(allocation.jobId);
  logJobStart(ctx.logger, {
    jobId: allocation.jobId,
    kind: body.kind === "video" ? "video" : "still",
    entryPoint: resolvedEntry,
    compositionId: body.compositionId,
    propsSummary,
  });

  try {
    const job: RenderJobRequest =
      body.kind === "video"
        ? {
            kind: "video",
            jobId: allocation.jobId,
            entryPoint: resolvedEntry,
            compositionId: body.compositionId,
            inputProps,
            codec: body.codec ?? "h264",
          }
        : {
            kind: "still",
            jobId: allocation.jobId,
            entryPoint: resolvedEntry,
            compositionId: body.compositionId,
            inputProps,
            imageFormat: body.imageFormat ?? "png",
            ...(typeof body.frame === "number" ? { frame: body.frame } : {}),
          };

    const result = await ctx.queue.enqueueRender({
      job,
      outputPath: allocation.outputPath,
      ...(ctx.config.cacheDir ? { cacheDir: ctx.config.cacheDir } : {}),
      allowNetwork: ctx.config.allowNetwork,
    });

    // Verify size cap. verifyAndMeasure deletes the file on overflow so we
    // catch the error path and surface a clean "exceeded maxOutputBytes"
    // message rather than leaving partial output around.
    const sizeBytes = await verifyAndMeasure(allocation.outputPath, ctx.config.maxOutputBytes);

    // Best-effort media library registration. Failure is non-fatal — the
    // primary artifact in outputDir still serves the preview pane.
    const registered = await registerArtifactToMediaLibrary({
      outputPath: allocation.outputPath,
      maxBytes: ctx.config.maxOutputBytes,
    });

    ctx.jobs.markDone(allocation.jobId, {
      outputPath: allocation.outputPath,
      sizeBytes,
      durationMs: result.durationMs,
      ...(registered.ok ? { mediaLibraryPath: registered.mediaLibraryPath } : {}),
    });
    logJobFinish(ctx.logger, {
      jobId: allocation.jobId,
      durationMs: result.durationMs,
    });
    if (!registered.ok) {
      ctx.logger.warn("remotion media-library registration skipped", {
        jobId: allocation.jobId,
        reason: registered.reason,
      });
    }
  } catch (err) {
    ctx.jobs.markError(allocation.jobId, describeError(err));
    ctx.logger.warn("remotion job failed", {
      jobId: allocation.jobId,
      error: describeError(err),
    });
    await cleanupJobDir(allocation.jobDir);
  }
}

// ---------------------------------------------------------------------------
// GET /remotion/jobs/:jobId
//
// Returns the current snapshot. UI uses this to poll. We keep the polling
// model simple (no SSE / websocket) because v1 is single-user single-host.
// ---------------------------------------------------------------------------

export function makeJobLookupHandler(
  jobIdFromPath: (req: IncomingMessage) => string | null,
): RouteHandler {
  return async (req, res, ctx) => {
    if (req.method !== "GET") {
      return methodNotAllowed(res, "GET");
    }
    const jobId = jobIdFromPath(req);
    if (!jobId) {
      return badRequest(res, "missing jobId");
    }
    const job = ctx.jobs.get(jobId);
    if (!job) {
      return notFound(res, `job ${jobId}`);
    }
    const responseBody: JobResponseBody = {
      job,
      artifactUrl: job.status === "done" ? artifactUrlFor(ctx, job.jobId) : null,
    };
    return jsonResponse(res, 200, responseBody);
  };
}

// ---------------------------------------------------------------------------
// GET /remotion/history?limit=N
// ---------------------------------------------------------------------------

export const handleHistory: RouteHandler = async (req, res, ctx) => {
  if (req.method !== "GET") {
    return methodNotAllowed(res, "GET");
  }
  const url = new URL(req.url ?? "/", "http://internal");
  const limitRaw = url.searchParams.get("limit");
  const parsed = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 20;
  const jobs = ctx.jobs.list(limit).map((job) => ({
    job,
    artifactUrl: job.status === "done" ? artifactUrlFor(ctx, job.jobId) : null,
  }));
  return jsonResponse(res, 200, { jobs });
};

// ---------------------------------------------------------------------------
// Path matching helpers used by index.ts to plug into registerHttpRoute.
// ---------------------------------------------------------------------------

/**
 * Extract `:jobId` segment from a URL whose path matches
 * `<...>/remotion/jobs/<jobId>` (and optionally a trailing component like
 * `/artifact`).
 */
export function extractJobIdFromPath(req: IncomingMessage): string | null {
  if (!req.url) {
    return null;
  }
  const url = new URL(req.url, "http://internal");
  const match = url.pathname.match(/\/remotion\/jobs\/([^/]+)(?:\/[^/]+)?\/?$/u);
  if (!match) {
    return null;
  }
  return decodeURIComponent(match[1] ?? "");
}
