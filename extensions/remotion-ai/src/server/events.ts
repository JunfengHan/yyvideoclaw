// extensions/remotion-ai/src/server/events.ts
//
// SSE (Server-Sent Events) handler for `GET /remotion-ai/jobs/:jobId/events`.
// Subscribes to the JobsStore's per-job events, streams them to the client,
// and disconnects when the job reaches a terminal phase. Connection-level
// keep-alives every 25 s so dev proxies (and the macOS gateway tunnel) do
// not drop idle streams.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { JobsStore } from "../jobs-store.js";
import type { JobEvent, Phase } from "../types.js";
import { extractJobIdFromPath, type RouteContext, type RouteHandler } from "./routes.js";

const KEEPALIVE_INTERVAL_MS = 25_000;
const TERMINAL_PHASES = new Set<Phase>(["done", "failed", "cancelled"]);

function setSseHeaders(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  if (typeof (res as { flushHeaders?: () => void }).flushHeaders === "function") {
    (res as { flushHeaders: () => void }).flushHeaders();
  }
}

function writeSseEvent(res: ServerResponse, event: JobEvent): boolean {
  // Each event uses `event: <type>\ndata: <json>\n\n` so EventSource clients
  // can dispatch by `event.type` while still receiving the JSON payload.
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  return res.write(payload);
}

function writeKeepalive(res: ServerResponse): boolean {
  // SSE comments — clients ignore them but proxies treat the bytes as live
  // traffic.
  return res.write(`: keepalive ${Date.now()}\n\n`);
}

export const handleEventsStream: RouteHandler = async (req, res, ctx) => {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("allow", "GET");
    res.end();
    return true;
  }
  const jobId = extractJobIdFromPath(req);
  if (!jobId) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "bad_request", detail: "missing jobId" }));
    return true;
  }
  const job = ctx.jobs.get(jobId);
  if (!job) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "not_found", detail: `job ${jobId}` }));
    return true;
  }

  setSseHeaders(res);

  // Send the current snapshot as a synthetic phase event so reconnects
  // immediately know where the job stands.
  const snapshotEvent: JobEvent = {
    type: "phase",
    jobId,
    phase: job.phase,
    at: job.updatedAt,
  };
  writeSseEvent(res, snapshotEvent);

  await streamUntilTerminal({
    res,
    req,
    jobs: ctx.jobs,
    jobId,
    initialPhase: job.phase,
  });
  return true;
};

interface StreamParams {
  readonly res: ServerResponse;
  readonly req: IncomingMessage;
  readonly jobs: JobsStore;
  readonly jobId: string;
  readonly initialPhase: Phase;
}

async function streamUntilTerminal(params: StreamParams): Promise<void> {
  // If the job is already terminal at connect time we still want to drain
  // the replay buffer (delivered synchronously by `subscribe`) so the UI
  // gets the final outcome, then close immediately.
  let alreadyTerminal = TERMINAL_PHASES.has(params.initialPhase);

  return new Promise<void>((resolve) => {
    let resolved = false;
    const finish = (): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      try {
        params.res.end();
      } catch {
        // Already ended.
      }
      cleanup();
      resolve();
    };

    const onEvent = (event: JobEvent): void => {
      if (resolved) {
        return;
      }
      const ok = writeSseEvent(params.res, event);
      if (!ok) {
        // Backpressure: stop writing until drained.
      }
      if (event.type === "phase" && TERMINAL_PHASES.has(event.phase)) {
        // Settle after the terminal phase is delivered.
        finish();
      }
    };

    const dispose = params.jobs.subscribe(params.jobId, onEvent);

    const keepalive = setInterval(() => {
      if (!writeKeepalive(params.res)) {
        // Backpressure or disconnect — stop trying.
      }
    }, KEEPALIVE_INTERVAL_MS);
    keepalive.unref?.();

    const onClose = (): void => {
      finish();
    };
    params.req.on("close", onClose);
    params.res.on("close", onClose);
    params.res.on("error", onClose);

    function cleanup(): void {
      clearInterval(keepalive);
      dispose();
      params.req.off("close", onClose);
      params.res.off("close", onClose);
      params.res.off("error", onClose);
    }

    if (alreadyTerminal) {
      finish();
    }
    void alreadyTerminal;
  });
}

export type { RouteContext };
