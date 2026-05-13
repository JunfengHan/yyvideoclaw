// extensions/remotion-ai/src/server/routes.ts
//
// HTTP route handlers for the remotion-ai plugin. Mirrors the shape used by
// `extensions/remotion/src/server/routes.ts` — `RouteHandler` returns
// `Promise<boolean>`, auth is delegated to the plugin host
// (`registerHttpRoute({ auth: "gateway" })`).
//
// Endpoints:
//   POST   /remotion-ai/jobs                          — submit a new job
//   GET    /remotion-ai/jobs/:jobId                   — snapshot polling
//   POST   /remotion-ai/jobs/:jobId/cancel            — request cancellation
//   GET    /remotion-ai/history                       — recent jobs (in-memory)
//   GET    /remotion-ai/jobs/:jobId/events            — SSE stream (in events.ts)
//   GET    /remotion-ai/library                       — disk-backed library listing
//   POST   /remotion-ai/voiceover                     — generate TTS audio assets from cues
//   DELETE /remotion-ai/library/:jobId                — delete one library entry
//   GET    /remotion-ai/library/:jobId/output.mp4     — stream the rendered video
//                                                       (supports HTTP Range so
//                                                       `<video>` can seek)

import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ResolvedRemotionAiConfig } from "../config.js";
import type { JobsStore } from "../jobs-store.js";
import {
  deleteLibraryEntry,
  listLibrary,
  resolveLibraryVideo,
  type LibraryEntry,
} from "../library.js";
import type { Orchestrator } from "../orchestrator.js";
import type { JobSnapshot, Phase } from "../types.js";

export interface RouteContext {
  readonly config: ResolvedRemotionAiConfig;
  readonly coreConfig: OpenClawConfig;
  readonly runtime: Pick<OpenClawPluginApi["runtime"], "tts">;
  readonly jobs: JobsStore;
  readonly orchestrator: Orchestrator;
  readonly logger: PluginLogger;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
) => Promise<boolean>;

const MAX_BODY_BYTES = 256 * 1024;
const MAX_PROMPT_CHARS = 8_000;

export function jsonResponse(res: ServerResponse, status: number, body: unknown): boolean {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
  return true;
}

export function methodNotAllowed(res: ServerResponse, allowed: string): boolean {
  res.setHeader("allow", allowed);
  return jsonResponse(res, 405, { error: "method_not_allowed", allowed });
}

export function badRequest(res: ServerResponse, detail: string): boolean {
  return jsonResponse(res, 400, { error: "bad_request", detail });
}

export function notFound(res: ServerResponse, what: string): boolean {
  return jsonResponse(res, 404, { error: "not_found", detail: what });
}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
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
        // Empty body is allowed for POSTs that want all server defaults.
        resolve({} as T);
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

interface SubmitJobRequest {
  readonly prompt?: unknown;
  readonly outputRoot?: unknown;
  readonly engine?: unknown;
  readonly retryMax?: unknown;
  readonly jobTimeoutMs?: unknown;
  readonly allowNetwork?: unknown;
}

interface SubmitJobResponse {
  readonly job: JobSnapshot;
  readonly snapshotUrl: string;
  readonly eventsUrl: string;
  readonly cancelUrl: string;
}

// ---------------------------------------------------------------------------
// POST /remotion-ai/jobs
// ---------------------------------------------------------------------------

export const handleSubmit: RouteHandler = async (req, res, ctx) => {
  if (req.method !== "POST") {
    return methodNotAllowed(res, "POST");
  }
  let body: SubmitJobRequest;
  try {
    body = await readJsonBody<SubmitJobRequest>(req);
  } catch (err) {
    return badRequest(res, err instanceof Error ? err.message : String(err));
  }
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return badRequest(res, "prompt must be a non-empty string");
  }
  if (body.prompt.length > MAX_PROMPT_CHARS) {
    return badRequest(res, `prompt exceeds ${MAX_PROMPT_CHARS} chars`);
  }
  // outputRoot is OPTIONAL. When omitted the orchestrator falls back to
  // config.defaultOutputRoot (the managed library). Explicit values must
  // still be absolute and — after canonicalisation — clear the workspace
  // allowlist check.
  let outputRoot: string | undefined;
  if (body.outputRoot === undefined) {
    outputRoot = undefined;
  } else if (typeof body.outputRoot === "string" && body.outputRoot.length > 0) {
    if (!body.outputRoot.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(body.outputRoot)) {
      return badRequest(res, "outputRoot must be an absolute path");
    }
    outputRoot = body.outputRoot;
  } else {
    return badRequest(res, "outputRoot must be a non-empty absolute path when provided");
  }
  let engine: string | undefined;
  if (body.engine === undefined) {
    engine = undefined;
  } else if (typeof body.engine === "string") {
    engine = body.engine;
  } else {
    return badRequest(res, "engine must be a string");
  }
  if (engine !== undefined && engine !== "codex") {
    return badRequest(res, `engine must be "codex" (got "${engine}")`);
  }
  const retryMax = body.retryMax === undefined ? undefined : Number(body.retryMax);
  if (retryMax !== undefined && (!Number.isInteger(retryMax) || retryMax < 0 || retryMax > 10)) {
    return badRequest(res, "retryMax must be an integer between 0 and 10");
  }
  const jobTimeoutMs = body.jobTimeoutMs === undefined ? undefined : Number(body.jobTimeoutMs);
  if (jobTimeoutMs !== undefined && (!Number.isFinite(jobTimeoutMs) || jobTimeoutMs < 1000)) {
    return badRequest(res, "jobTimeoutMs must be >= 1000");
  }
  const allowNetwork = body.allowNetwork === undefined ? undefined : Boolean(body.allowNetwork);

  const submitted = ctx.orchestrator.submit({
    prompt: body.prompt.trim(),
    ...(outputRoot !== undefined ? { outputRoot } : {}),
    ...(engine ? { engine: engine as "codex" } : {}),
    ...(retryMax !== undefined ? { retryMax } : {}),
    ...(jobTimeoutMs !== undefined ? { jobTimeoutMs } : {}),
    ...(allowNetwork !== undefined ? { allowNetwork } : {}),
  });
  // Run the pipeline detached; HTTP response returns immediately.
  void submitted.waitForCompletion;

  const response: SubmitJobResponse = {
    job: submitted.snapshot,
    snapshotUrl: `/remotion-ai/jobs/${encodeURIComponent(submitted.snapshot.jobId)}`,
    eventsUrl: `/remotion-ai/jobs/${encodeURIComponent(submitted.snapshot.jobId)}/events`,
    cancelUrl: `/remotion-ai/jobs/${encodeURIComponent(submitted.snapshot.jobId)}/cancel`,
  };
  res.statusCode = 202;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("location", response.snapshotUrl);
  res.end(JSON.stringify(response));
  return true;
};

// ---------------------------------------------------------------------------
// GET /remotion-ai/jobs/:jobId          (snapshot)
// POST /remotion-ai/jobs/:jobId/cancel  (idempotent cancel)
// ---------------------------------------------------------------------------

export function makeJobLookupHandler(
  jobIdFromPath: (req: IncomingMessage) => string | null,
): RouteHandler {
  return async (req, res, ctx) => {
    const jobId = jobIdFromPath(req);
    if (!jobId) {
      return badRequest(res, "missing jobId");
    }

    if (req.method === "POST" && extractCancelFromPath(req)) {
      const cancelled = ctx.orchestrator.cancel(jobId);
      const job = ctx.jobs.get(jobId);
      if (!job) {
        return notFound(res, `job ${jobId}`);
      }
      return jsonResponse(res, 200, { cancelled, job });
    }

    if (req.method !== "GET") {
      return methodNotAllowed(res, "GET");
    }
    const job = ctx.jobs.get(jobId);
    if (!job) {
      return notFound(res, `job ${jobId}`);
    }
    return jsonResponse(res, 200, { job });
  };
}

// ---------------------------------------------------------------------------
// GET /remotion-ai/history?limit=N
// ---------------------------------------------------------------------------

export const handleHistory: RouteHandler = async (req, res, ctx) => {
  if (req.method !== "GET") {
    return methodNotAllowed(res, "GET");
  }
  const url = new URL(req.url ?? "/", "http://internal");
  const limitRaw = url.searchParams.get("limit");
  const parsed = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 20;
  return jsonResponse(res, 200, { jobs: ctx.jobs.list(limit) });
};

// ---------------------------------------------------------------------------
// GET /remotion-ai/library
//
// Disk-backed listing of every workspace under `config.defaultOutputRoot`.
// Live in-flight jobs are injected from `JobsStore` so the UI sees a
// unified list that includes the one the user just kicked off. Entries
// from the store "win" when jobIds overlap.
// ---------------------------------------------------------------------------

export interface LibraryResponse {
  readonly libraryRoot: string;
  readonly entries: ReadonlyArray<LibraryEntry | LiveLibraryEntry>;
}

/**
 * In-flight jobs that may not have a sidecar yet (workspace phase hasn't
 * run). Shaped so UI can treat them uniformly with disk entries.
 */
export interface LiveLibraryEntry {
  readonly jobId: string;
  readonly workspaceDir: string;
  readonly prompt: string;
  readonly promptPreview: string;
  readonly engine: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly entryPointAbsolute: string;
  readonly renderable: false;
  readonly sizeBytes: null;
  readonly live: true;
  readonly phase: Phase;
  readonly retryCount: number;
}

const TERMINAL_PHASES: ReadonlySet<Phase> = new Set(["done", "failed", "cancelled"]);

export const handleLibrary: RouteHandler = async (req, res, ctx) => {
  if (req.method !== "GET") {
    return methodNotAllowed(res, "GET");
  }
  // In-flight jobs from the live store. Excluded from the disk scan so we
  // don't double-count the one we're about to prepend.
  const live = ctx.jobs.list(200).filter((job) => !TERMINAL_PHASES.has(job.phase));
  const liveIds = new Set<string>(live.map((job) => job.jobId));
  const diskEntries = await listLibrary({
    libraryRoot: ctx.config.defaultOutputRoot,
    excludeJobIds: liveIds,
  });
  const liveEntries: LiveLibraryEntry[] = live.map((job) => ({
    jobId: job.jobId,
    workspaceDir: job.workspaceDir,
    prompt: job.promptPreview ?? "",
    promptPreview: job.promptPreview ?? "",
    engine: job.engine,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    entryPointAbsolute: job.workspaceDir ? `${job.workspaceDir}/src/index.ts` : "",
    renderable: false,
    sizeBytes: null,
    live: true,
    phase: job.phase,
    retryCount: job.retryCount,
  }));
  const merged: Array<LibraryEntry | LiveLibraryEntry> = [...liveEntries, ...diskEntries];
  const response: LibraryResponse = {
    libraryRoot: ctx.config.defaultOutputRoot,
    entries: merged,
  };
  return jsonResponse(res, 200, response);
};

// ---------------------------------------------------------------------------
// DELETE /remotion-ai/library/:jobId
// ---------------------------------------------------------------------------

export function makeLibraryDeleteHandler(
  jobIdFromPath: (req: IncomingMessage) => string | null,
): RouteHandler {
  return async (req, res, ctx) => {
    if (req.method !== "DELETE") {
      return methodNotAllowed(res, "DELETE");
    }
    const jobId = jobIdFromPath(req);
    if (!jobId) {
      return badRequest(res, "missing jobId in path");
    }
    // Refuse to delete an in-flight job; caller must cancel it first.
    const live = ctx.jobs.get(jobId);
    if (live && !TERMINAL_PHASES.has(live.phase)) {
      return jsonResponse(res, 409, {
        error: "job_in_flight",
        detail: "cancel the job before deleting it",
        phase: live.phase,
      });
    }
    const outcome = await deleteLibraryEntry({
      libraryRoot: ctx.config.defaultOutputRoot,
      jobId,
    });
    if (!outcome.ok) {
      const status =
        outcome.reason === "not-found"
          ? 404
          : outcome.reason === "invalid-job-id" || outcome.reason === "outside-library-root"
            ? 400
            : outcome.reason === "missing-sidecar"
              ? 409
              : 500;
      return jsonResponse(res, status, {
        error: outcome.reason,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      });
    }
    return jsonResponse(res, 200, { deleted: true, jobId });
  };
}

// ---------------------------------------------------------------------------
// Path helpers used by index.ts to plug into registerHttpRoute.
// ---------------------------------------------------------------------------

const JOB_PATH_RE = /\/remotion-ai\/jobs\/([^/]+)(?:\/(?:cancel|events))?\/?$/u;
const LIBRARY_ITEM_RE = /\/remotion-ai\/library\/([^/]+)\/?$/u;

export function extractJobIdFromPath(req: IncomingMessage): string | null {
  if (!req.url) {
    return null;
  }
  const url = new URL(req.url, "http://internal");
  const match = url.pathname.match(JOB_PATH_RE);
  if (!match) {
    return null;
  }
  return decodeURIComponent(match[1] ?? "");
}

export function extractCancelFromPath(req: IncomingMessage): boolean {
  if (!req.url) {
    return false;
  }
  const url = new URL(req.url, "http://internal");
  return /\/remotion-ai\/jobs\/[^/]+\/cancel\/?$/u.test(url.pathname);
}

export function extractEventsFromPath(req: IncomingMessage): boolean {
  if (!req.url) {
    return false;
  }
  const url = new URL(req.url, "http://internal");
  return /\/remotion-ai\/jobs\/[^/]+\/events\/?$/u.test(url.pathname);
}

/** Extract `:jobId` from `/remotion-ai/library/:jobId`. Returns null if
 *  the URL doesn't match the library-item shape. */
export function extractLibraryJobIdFromPath(req: IncomingMessage): string | null {
  if (!req.url) {
    return null;
  }
  const url = new URL(req.url, "http://internal");
  const match = url.pathname.match(LIBRARY_ITEM_RE);
  if (!match) {
    return null;
  }
  return decodeURIComponent(match[1] ?? "");
}

/** True when the request targets the library collection (`/remotion-ai/library`). */
export function isLibraryCollectionPath(req: IncomingMessage): boolean {
  if (!req.url) {
    return false;
  }
  const url = new URL(req.url, "http://internal");
  return /\/remotion-ai\/library\/?$/u.test(url.pathname);
}

// ---------------------------------------------------------------------------
// GET /remotion-ai/library/:jobId/output.mp4
//
// Streams the rendered mp4 back to the browser. Supports a single
// `Range: bytes=<start>-<end?>` header so the HTML `<video>` element can
// seek without downloading the whole file. We deliberately reject
// multipart range requests (Range: bytes=0-100,200-300) — they're not
// part of any browser's normal playback path and add a lot of edge
// cases for very little value.
// ---------------------------------------------------------------------------

const LIBRARY_VIDEO_RE = /\/remotion-ai\/library\/([^/]+)\/output\.mp4\/?$/u;

/** Extract `:jobId` from `/remotion-ai/library/:jobId/output.mp4`. */
export function extractLibraryVideoJobIdFromPath(req: IncomingMessage): string | null {
  if (!req.url) {
    return null;
  }
  const url = new URL(req.url, "http://internal");
  const match = url.pathname.match(LIBRARY_VIDEO_RE);
  if (!match) {
    return null;
  }
  return decodeURIComponent(match[1] ?? "");
}

/** True when the request targets the video streaming endpoint. */
export function isLibraryVideoPath(req: IncomingMessage): boolean {
  if (!req.url) {
    return false;
  }
  const url = new URL(req.url, "http://internal");
  return LIBRARY_VIDEO_RE.test(url.pathname);
}

interface ParsedRange {
  readonly start: number;
  readonly end: number; // inclusive
}

/**
 * Parse `Range: bytes=<start>-<end?>`. Returns `null` for any value we
 * don't want to handle: missing, multipart, suffix-only (`bytes=-500`),
 * or out-of-range. The caller then responds 200 (full body) or 416
 * accordingly.
 */
function parseSingleByteRange(header: string | undefined, size: number): ParsedRange | null {
  if (!header || !header.startsWith("bytes=")) {
    return null;
  }
  const spec = header.slice("bytes=".length).trim();
  if (spec.includes(",")) {
    return null; // multipart — unsupported on purpose
  }
  const [startStr, endStr] = spec.split("-");
  if (startStr === undefined || startStr === "") {
    return null; // "bytes=-500" suffix form; not worth the complexity
  }
  const start = Number(startStr);
  if (!Number.isFinite(start) || start < 0 || start >= size) {
    return null;
  }
  let end = endStr === undefined || endStr === "" ? size - 1 : Number(endStr);
  if (!Number.isFinite(end) || end < start) {
    return null;
  }
  if (end >= size) {
    end = size - 1;
  }
  return { start, end };
}

export const handleLibraryVideo: RouteHandler = async (req, res, ctx) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return methodNotAllowed(res, "GET");
  }
  const jobId = extractLibraryVideoJobIdFromPath(req);
  if (!jobId) {
    return badRequest(res, "missing jobId");
  }
  const resolved = await resolveLibraryVideo({
    libraryRoot: ctx.config.defaultOutputRoot,
    jobId,
  });
  if (!resolved) {
    return notFound(res, `no rendered video for job ${jobId}`);
  }

  const totalSize = resolved.sizeBytes;
  const range = parseSingleByteRange(req.headers.range, totalSize);

  // Headers shared by both full-body (200) and range (206) responses.
  res.setHeader("content-type", "video/mp4");
  res.setHeader("accept-ranges", "bytes");
  // Cache lightly: the video file is content-addressed by jobId. Frequent
  // re-fetches (e.g. user reloads the Library page) are cheap. We use a
  // short cache lifetime + must-revalidate so deletes propagate.
  res.setHeader("cache-control", "private, max-age=60, must-revalidate");
  // Defend against the gateway's default proxy paths sniffing the body
  // for HTML — these files are pure binary and should not be touched.
  res.setHeader("x-content-type-options", "nosniff");

  if (req.method === "HEAD") {
    res.setHeader("content-length", String(totalSize));
    res.statusCode = 200;
    res.end();
    return true;
  }

  if (range) {
    const length = range.end - range.start + 1;
    res.statusCode = 206;
    res.setHeader("content-length", String(length));
    res.setHeader("content-range", `bytes ${range.start}-${range.end}/${totalSize}`);
    const stream = createReadStream(resolved.absolutePath, {
      start: range.start,
      end: range.end,
    });
    stream.on("error", (err) => {
      ctx.logger.warn(
        `remotion-ai library video stream failed jobId=${jobId} error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
      );
      // Best-effort: if headers haven't gone out yet (rare), report 500.
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
    return true;
  }

  // Full body.
  res.statusCode = 200;
  res.setHeader("content-length", String(totalSize));
  const stream = createReadStream(resolved.absolutePath);
  stream.on("error", (err) => {
    ctx.logger.warn(
      `remotion-ai library video stream failed jobId=${jobId} error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
    );
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end();
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
  return true;
};
