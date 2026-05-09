// GET /remotion/jobs/:jobId/artifact
//
// Streams the produced mp4/png back to the UI. Supports HTTP Range requests
// because Safari/iOS WebKit refuses to play `<video>` sources that don't
// honour `Accept-Ranges: bytes`. Without proper Range handling the preview
// pane is broken on the most popular Apple platforms.
//
// Behavior:
//   - 404 if the jobId is unknown.
//   - 409 ("not_done") if the job is still queued / running / cancelled / errored.
//   - 200 + full body when no Range header is present.
//   - 206 Partial Content when a satisfiable byte range is requested.
//   - 416 Range Not Satisfiable for out-of-bounds ranges.
//
// We deliberately serve from the durable `outputPath` (under
// `<outputDir>/<jobId>/out.<ext>`), NOT from the ~/.openclaw/media/outbound/
// copy. The media library copy is governed by separate retention/GC; the
// preview pane wants a stable, plugin-owned source.
//
// Security: outputPath is constructed by the plugin from a UUID jobId
// inside the configured outputDir. The job lookup keys are jobId-scoped,
// so an attacker cannot make this handler stream an arbitrary path.

import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { jsonResponse, methodNotAllowed, notFound, type RouteHandler } from "./routes.js";

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Parse a single byte-range header. Multi-range requests are not supported —
 * Webkit/Chrome only ever send a single range for `<video>` playback, and
 * implementing multipart/byteranges adds non-trivial framing for no gain.
 *
 * Returns:
 *   - { start, end } when a satisfiable range is parseable.
 *   - "unsatisfiable" when the header is present but out of bounds.
 *   - "absent" when no Range header was sent.
 *   - "malformed" when the header exists but cannot be parsed → treat as absent
 *     (per RFC 9110 §14.1.2 servers MAY ignore unparseable Range headers).
 */
export type RangeParseResult =
  | { kind: "ok"; start: number; end: number }
  | { kind: "absent" }
  | { kind: "unsatisfiable" }
  | { kind: "malformed" };

export function parseRangeHeader(header: string | undefined, totalSize: number): RangeParseResult {
  if (header === undefined || header === "") {
    return { kind: "absent" };
  }
  if (totalSize === 0) {
    return { kind: "unsatisfiable" };
  }
  // Only support `bytes=...` units — the only unit the web platform sends.
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match) {
    return { kind: "malformed" };
  }
  const startStr = match[1] ?? "";
  const endStr = match[2] ?? "";
  if (startStr === "" && endStr === "") {
    return { kind: "malformed" };
  }

  let start: number;
  let end: number;
  if (startStr === "") {
    // Suffix range: "bytes=-N" → last N bytes
    const suffixLen = Number.parseInt(endStr, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) {
      return { kind: "malformed" };
    }
    start = Math.max(0, totalSize - suffixLen);
    end = totalSize - 1;
  } else {
    start = Number.parseInt(startStr, 10);
    if (!Number.isFinite(start)) {
      return { kind: "malformed" };
    }
    end = endStr === "" ? totalSize - 1 : Number.parseInt(endStr, 10);
    if (!Number.isFinite(end)) {
      return { kind: "malformed" };
    }
  }
  if (start < 0 || start >= totalSize || end >= totalSize || start > end) {
    return { kind: "unsatisfiable" };
  }
  return { kind: "ok", start, end };
}

/**
 * Extract jobId from `/remotion/jobs/<jobId>/artifact`. Returns null on
 * mismatch (the prefix-mounted handler may receive other shapes).
 */
export function extractArtifactJobId(req: IncomingMessage): string | null {
  if (!req.url) {
    return null;
  }
  const url = new URL(req.url, "http://internal");
  const match = url.pathname.match(/\/remotion\/jobs\/([^/]+)\/artifact\/?$/u);
  if (!match) {
    return null;
  }
  return decodeURIComponent(match[1] ?? "");
}

export const handleArtifactStream: RouteHandler = async (req, res, ctx) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return methodNotAllowed(res, "GET, HEAD");
  }
  const jobId = extractArtifactJobId(req);
  if (!jobId) {
    return notFound(res, "artifact path");
  }

  const job = ctx.jobs.get(jobId);
  if (!job) {
    return notFound(res, `job ${jobId}`);
  }
  if (job.status !== "done" || !job.outputPath) {
    return jsonResponse(res, 409, { error: "not_done", status: job.status });
  }

  let stat;
  try {
    stat = await fs.stat(job.outputPath);
  } catch {
    return jsonResponse(res, 410, { error: "artifact_missing" });
  }
  if (!stat.isFile()) {
    return jsonResponse(res, 410, { error: "artifact_missing" });
  }
  const totalSize = stat.size;
  const contentType = contentTypeFor(job.outputPath);

  const rangeHeader = req.headers["range"];
  const range = parseRangeHeader(
    typeof rangeHeader === "string" ? rangeHeader : undefined,
    totalSize,
  );

  if (range.kind === "unsatisfiable") {
    res.statusCode = 416;
    res.setHeader("content-range", `bytes */${totalSize}`);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "range_not_satisfiable" }));
    return true;
  }

  // Set common headers up-front. Accept-Ranges is critical for `<video>`
  // playback in Webkit.
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("content-type", contentType);
  // Keep the artifact non-cacheable per request — re-renders may overwrite
  // it (different inputProps, same composition).
  res.setHeader("cache-control", "no-store");
  // Hint inline display rather than triggering a download dialog.
  res.setHeader("content-disposition", `inline; filename="${path.basename(job.outputPath)}"`);

  if (range.kind === "ok") {
    const { start, end } = range;
    const length = end - start + 1;
    res.statusCode = 206;
    res.setHeader("content-range", `bytes ${start}-${end}/${totalSize}`);
    res.setHeader("content-length", String(length));
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    return await streamRangeToResponse(job.outputPath, start, end, res);
  }

  // Full-body response (no Range header or malformed → treat as full).
  res.statusCode = 200;
  res.setHeader("content-length", String(totalSize));
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  return await streamFullToResponse(job.outputPath, res);
};

async function streamRangeToResponse(
  outputPath: string,
  start: number,
  end: number,
  res: ServerResponse,
): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const stream = createReadStream(outputPath, { start, end });
    stream.on("error", reject);
    stream.on("end", () => resolve(true));
    stream.pipe(res);
  });
}

async function streamFullToResponse(outputPath: string, res: ServerResponse): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const stream = createReadStream(outputPath);
    stream.on("error", reject);
    stream.on("end", () => resolve(true));
    stream.pipe(res);
  });
}
