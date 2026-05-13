// Remotion AI Create plugin entry.
//
// Responsibilities (M1):
//   - Orchestrate an isolated AI workspace under a user-visible directory.
//   - Drive a coding agent (M1: Codex app-server via @openclaw/codex/api.js)
//     to author a Remotion project.
//   - Validate the result by spawning an isolated render worker that runs
//     bundle + selectComposition + render-still (1 frame). On failure, feed
//     the digest back into the same agent session; retry up to `retryMax`.
//   - Expose HTTP routes (/remotion-ai/*) consumed by the Remotion Studio
//     AI Create panel.
//
// Cross-extension boundary (see AGENTS.md):
//   - Talk to Codex ONLY through `@openclaw/codex/api.js`. Never deep-import
//     `extensions/codex/src/**`.
//   - Do NOT call the remotion plugin's `/remotion/*` routes for validation —
//     AI workspaces live outside the user's `templateRoots` by design.
//     The `ai-render-worker.ts` subprocess is the isolated validation seam.

import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { removeOpenRouterConfig } from "./src/codex-config-toml.js";
import { resolveRemotionAiConfig, RemotionAiConfigError } from "./src/config.js";
import { EngineRegistry } from "./src/engine/engine-registry.js";
import { JobsStore } from "./src/jobs-store.js";
import { Orchestrator } from "./src/orchestrator.js";
import {
  makeAuthByokHandler,
  makeAuthLoginHandler,
  makeAuthLogoutHandler,
  makeAuthOpenRouterModelsHandler,
  makeAuthStatusHandler,
  makeAuthUsageHandler,
} from "./src/server/auth-routes.js";
import { handleEventsStream } from "./src/server/events.js";
import {
  extractCancelFromPath,
  extractEventsFromPath,
  extractJobIdFromPath,
  extractLibraryJobIdFromPath,
  handleHistory,
  handleLibrary,
  handleLibraryVideo,
  handleSubmit,
  isLibraryCollectionPath,
  isLibraryVideoPath,
  makeJobLookupHandler,
  makeLibraryDeleteHandler,
  methodNotAllowed,
  type RouteContext,
} from "./src/server/routes.js";
import { handleVoiceover } from "./src/server/voiceover.js";

export default definePluginEntry({
  id: "remotion-ai",
  name: "Remotion AI Create",
  description:
    "Generate a fully working Remotion project from a prompt by driving Codex (M1) in an isolated workspace and auto-validating with bundle + selectComposition + render-still.",
  register(api) {
    let resolvedConfig;
    try {
      resolvedConfig = resolveRemotionAiConfig(api.pluginConfig);
    } catch (err) {
      if (err instanceof RemotionAiConfigError) {
        api.logger.error(
          `remotion-ai plugin config invalid; skipping route registration: ${err.message}`,
        );
        return;
      }
      throw err;
    }

    const jobs = new JobsStore();
    const engines = new EngineRegistry({ codex: { pluginConfig: api.pluginConfig } });
    const orchestrator = new Orchestrator({
      config: resolvedConfig,
      logger: api.logger,
      jobs,
      engines,
      // Self-heal stale `[model_providers.openrouter]` blocks in
      // ~/.codex/config.toml — see orchestrator.ts for why this runs
      // before every job. Tests use `undefined` so this defaults to a
      // noop and doesn't touch the developer's real codex config.
      removeOpenRouterConfig: () => removeOpenRouterConfig(),
    });

    // Pre-create the managed library root so the first GET /remotion-ai/library
    // doesn't race the first POST /remotion-ai/jobs. Best-effort: a mkdir
    // failure here is logged but not fatal — workspace.ts will retry per
    // job when outputRoot is used.
    void fs.mkdir(resolvedConfig.defaultOutputRoot, { recursive: true }).catch((err) => {
      api.logger.warn(
        `remotion-ai could not pre-create defaultOutputRoot=${JSON.stringify(
          resolvedConfig.defaultOutputRoot,
        )} error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
      );
    });

    const ctx: RouteContext = {
      config: resolvedConfig,
      coreConfig: api.config,
      runtime: { tts: api.runtime.tts },
      jobs,
      orchestrator,
      logger: api.logger,
    };

    const wrap = (
      handler: (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => Promise<boolean>,
    ): ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>) => {
      return async (req, res) => handler(req, res, ctx);
    };

    api.registerHttpRoute({
      path: "/remotion-ai/jobs",
      match: "exact",
      auth: "gateway",
      handler: wrap(handleSubmit),
    });
    api.registerHttpRoute({
      path: "/remotion-ai/history",
      match: "exact",
      auth: "gateway",
      handler: wrap(handleHistory),
    });
    api.registerHttpRoute({
      path: "/remotion-ai/library",
      match: "exact",
      auth: "gateway",
      handler: wrap(handleLibrary),
    });
    api.registerHttpRoute({
      path: "/remotion-ai/voiceover",
      match: "exact",
      auth: "gateway",
      handler: wrap(handleVoiceover),
    });
    // ---- Auth routes (hosted vs byok) ----
    // Each handler is a closure produced by `makeAuth*Handler` so
    // tests/dev environments can swap in stubs without spawning a real
    // process. They share the gateway's bearer-auth middleware just like
    // the rest of the plugin.
    const authLoginHandler = makeAuthLoginHandler();
    const authLogoutHandler = makeAuthLogoutHandler();
    const authByokHandler = makeAuthByokHandler();
    const authStatusHandler = makeAuthStatusHandler();
    const authUsageHandler = makeAuthUsageHandler();
    const authOpenRouterModelsHandler = makeAuthOpenRouterModelsHandler();
    api.registerHttpRoute({
      path: "/remotion-ai/auth/login",
      match: "exact",
      auth: "gateway",
      handler: wrap(authLoginHandler),
    });
    api.registerHttpRoute({
      path: "/remotion-ai/auth/logout",
      match: "exact",
      auth: "gateway",
      handler: wrap(authLogoutHandler),
    });
    api.registerHttpRoute({
      path: "/remotion-ai/auth/byok",
      match: "exact",
      auth: "gateway",
      handler: wrap(authByokHandler),
    });
    api.registerHttpRoute({
      path: "/remotion-ai/auth/status",
      match: "exact",
      auth: "gateway",
      handler: wrap(authStatusHandler),
    });
    api.registerHttpRoute({
      path: "/remotion-ai/auth/usage",
      match: "exact",
      auth: "gateway",
      handler: wrap(authUsageHandler),
    });
    api.registerHttpRoute({
      path: "/remotion-ai/auth/openrouter/models",
      match: "exact",
      auth: "gateway",
      handler: wrap(authOpenRouterModelsHandler),
    });
    // Two URL shapes share the `/remotion-ai/jobs/` prefix:
    //   GET    /remotion-ai/jobs/:id              → snapshot
    //   POST   /remotion-ai/jobs/:id/cancel       → cancel
    //   GET    /remotion-ai/jobs/:id/events       → SSE
    // Dispatch by inspecting the path.
    const lookupHandler = makeJobLookupHandler(extractJobIdFromPath);
    api.registerHttpRoute({
      path: "/remotion-ai/jobs/",
      match: "prefix",
      auth: "gateway",
      handler: async (req, res) => {
        if (extractEventsFromPath(req)) {
          return handleEventsStream(req, res, ctx);
        }
        if (extractCancelFromPath(req)) {
          return lookupHandler(req, res, ctx);
        }
        return lookupHandler(req, res, ctx);
      },
    });
    // DELETE /remotion-ai/library/:jobId — library item removal.
    // We register this AFTER the collection exact handler so `/library` (no
    // trailing path segment) routes to handleLibrary; the prefix only
    // matches item-shaped paths.
    //
    // GET /remotion-ai/library/:jobId/output.mp4 — video streaming. This
    // is checked FIRST because the path /library/:id/output.mp4 also
    // starts with /library/, so without the early-return the request
    // would otherwise be routed to the delete handler and immediately
    // rejected as "invalid jobId" (the regex won't accept "output.mp4").
    const libraryDeleteHandler = makeLibraryDeleteHandler(extractLibraryJobIdFromPath);
    api.registerHttpRoute({
      path: "/remotion-ai/library/",
      match: "prefix",
      auth: "gateway",
      handler: async (req, res) => {
        if (isLibraryVideoPath(req)) {
          return handleLibraryVideo(req, res, ctx);
        }
        if (isLibraryCollectionPath(req)) {
          // `/remotion-ai/library/` trailing slash — keep GET pointed at the
          // collection handler for clients that normalise URLs with a trailing
          // slash. DELETE on the collection is not allowed.
          if (req.method === "DELETE") {
            return methodNotAllowed(res, "GET");
          }
          return handleLibrary(req, res, ctx);
        }
        return libraryDeleteHandler(req, res, ctx);
      },
    });

    api.logger.info(
      `remotion-ai plugin registered engine=${resolvedConfig.engine} retryMax=${resolvedConfig.retryMax} jobTimeoutMs=${resolvedConfig.jobTimeoutMs} skillsBundled=${resolvedConfig.skillsBundled}`,
    );
  },
});
