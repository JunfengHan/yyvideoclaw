// Remotion plugin entry.
//
// Phase 1 (POC): three agent tools that delegate to an isolated render worker.
// Phase 2: HTTP routes consumed by the Control UI's "Remotion Studio" tab.
//
// Both surfaces share a single `RenderQueue` (concurrency=1) and a single
// `JobsStore`, so an in-flight tool call and an in-flight HTTP render
// cannot bypass each other's serialisation guarantee.
//
// Security boundaries are enforced by:
//   - src/template-resolver.ts (allowlist + realpath)
//   - src/render-queue.ts      (worker spawn, env scrub, timeout / SIGKILL)
//   - src/render-worker.ts     (sandboxed Remotion bundler/renderer)

import type { IncomingMessage, ServerResponse } from "node:http";
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { resolveRemotionConfig, RemotionConfigError } from "./src/config.js";
import { RenderQueue } from "./src/render-queue.js";
import { handleArtifactStream, extractArtifactJobId } from "./src/server/artifact-stream.js";
import { JobsStore } from "./src/server/jobs-store.js";
import {
  extractJobIdFromPath,
  handleHistory,
  handleRenderSubmit,
  handleStatus,
  handleTemplates,
  makeJobLookupHandler,
  type RouteContext,
} from "./src/server/routes.js";
import { createRemotionTools } from "./src/tools.js";

export default definePluginEntry({
  id: "remotion",
  name: "Remotion Plugin",
  description:
    "Render videos and stills with Remotion (@remotion/bundler + @remotion/renderer) through agent tools and the Remotion Studio Control UI tab.",
  register(api) {
    let resolvedConfig;
    try {
      resolvedConfig = resolveRemotionConfig(api.pluginConfig);
    } catch (err) {
      if (err instanceof RemotionConfigError) {
        // Surface the misconfiguration to the operator and skip every
        // surface (tools AND routes). It's safer than registering things
        // that fail at call time with confusing error messages.
        api.logger.error("remotion plugin config invalid; skipping tool + route registration", {
          error: err.message,
        });
        return;
      }
      throw err;
    }

    // Single shared queue + jobs store across tools and HTTP routes. The
    // queue is concurrency=1 by design; the jobs store is a bounded LRU.
    const queue = new RenderQueue({ jobTimeoutMs: resolvedConfig.jobTimeoutMs });
    const jobs = new JobsStore();

    const tools = createRemotionTools({
      config: resolvedConfig,
      logger: api.logger,
      queue,
    });
    for (const tool of tools) {
      api.registerTool(tool as AnyAgentTool);
    }

    // -----------------------------------------------------------------
    // HTTP routes (Phase 2). All routes are gateway-authenticated; the
    // plugin host enforces the bearer token before our handlers run.
    // -----------------------------------------------------------------

    const ctx: RouteContext = {
      config: resolvedConfig,
      queue,
      jobs,
      logger: api.logger,
    };
    const wrap = (
      handler: (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => Promise<boolean>,
    ) => {
      return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
        return handler(req, res, ctx);
      };
    };

    api.registerHttpRoute({
      path: "/remotion/status",
      match: "exact",
      auth: "gateway",
      handler: wrap(handleStatus),
    });
    api.registerHttpRoute({
      path: "/remotion/templates",
      match: "exact",
      auth: "gateway",
      handler: wrap(handleTemplates),
    });
    api.registerHttpRoute({
      path: "/remotion/render",
      match: "exact",
      auth: "gateway",
      handler: wrap(handleRenderSubmit),
    });
    api.registerHttpRoute({
      path: "/remotion/history",
      match: "exact",
      auth: "gateway",
      handler: wrap(handleHistory),
    });
    // Job lookup is mounted on the prefix `/remotion/jobs/`. Two URL shapes
    // are routed under this prefix:
    //   GET /remotion/jobs/:jobId            → snapshot polling (JSON)
    //   GET /remotion/jobs/:jobId/artifact   → bytes (range-capable)
    // We dispatch by inspecting the path inside the wrap.
    const lookupHandler = makeJobLookupHandler(extractJobIdFromPath);
    api.registerHttpRoute({
      path: "/remotion/jobs/",
      match: "prefix",
      auth: "gateway",
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (extractArtifactJobId(req) !== null) {
          return handleArtifactStream(req, res, ctx);
        }
        return lookupHandler(req, res, ctx);
      },
    });
  },
});
