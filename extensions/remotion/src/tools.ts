// Remotion plugin tools.
//
// Exposes three agent tools — list / render-video / render-still — each
// backed by the RenderQueue and gated by the template-resolver allowlist.
//
// Tool contract follows the pattern used by `extensions/tavily/src/tavily-search-tool.ts`:
// a plain object with `name`, `label`, `description`, `parameters` (TypeBox
// schema), and `execute(toolCallId, rawParams)`.

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { Type, type Static } from "typebox";
import { logJobFailure, logJobFinish, logJobStart, summarizeInputProps } from "./logging.js";
import { allocateJobOutput, cleanupJobDir, verifyAndMeasure } from "./output-manager.js";
import { RenderQueue } from "./render-queue.js";
import { resolveTemplateEntryPoint, TemplateResolutionError } from "./template-resolver.js";
import type { RenderJobRequest, RemotionPluginConfig } from "./types.js";

// ---------------------------------------------------------------------------
// TypeBox schemas
// ---------------------------------------------------------------------------

const ListSchema = Type.Object(
  {
    entryPoint: Type.String({
      description:
        "Absolute path to the Remotion project entry file. Must resolve inside a configured templateRoots directory.",
    }),
  },
  { additionalProperties: false },
);

const RenderVideoSchema = Type.Object(
  {
    entryPoint: Type.String({
      description:
        "Absolute path to the Remotion project entry file. Must resolve inside a configured templateRoots directory.",
    }),
    compositionId: Type.String({
      description: "The id of the <Composition> to render.",
    }),
    inputProps: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          "Serialisable input props passed to the composition. Sensitive values should NOT be included here — only key names and byte size are logged, but props still reach the render subprocess.",
      }),
    ),
    codec: Type.Optional(
      Type.Union(
        [Type.Literal("h264"), Type.Literal("h265"), Type.Literal("vp8"), Type.Literal("vp9")],
        { description: "Output codec. Defaults to h264 (mp4)." },
      ),
    ),
  },
  { additionalProperties: false },
);

const RenderStillSchema = Type.Object(
  {
    entryPoint: Type.String({
      description:
        "Absolute path to the Remotion project entry file. Must resolve inside a configured templateRoots directory.",
    }),
    compositionId: Type.String({ description: "The id of the <Composition> to render." }),
    inputProps: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    frame: Type.Optional(
      Type.Number({
        minimum: 0,
        description: "Frame index to render. Defaults to 0.",
      }),
    ),
    imageFormat: Type.Optional(
      Type.Union([Type.Literal("png"), Type.Literal("jpeg")], {
        description: "Image format for the still. Defaults to png.",
      }),
    ),
  },
  { additionalProperties: false },
);

type ListInput = Static<typeof ListSchema>;
type RenderVideoInput = Static<typeof RenderVideoSchema>;
type RenderStillInput = Static<typeof RenderStillSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required and must be a non-empty string`);
  }
  return value;
}

function optionalRecord(
  raw: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = raw[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function optionalNumber(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number`);
  }
  return value;
}

function jsonResult(payload: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function errorResult(err: unknown): { content: [{ type: "text"; text: string }]; isError: true } {
  const message =
    err instanceof TemplateResolutionError
      ? `template rejected (${err.code}): ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export interface CreateToolsArgs {
  config: RemotionPluginConfig;
  logger: PluginLogger;
  /** Injected for tests; production code defaults to a shared RenderQueue. */
  queue?: RenderQueue;
}

export function createRemotionTools(args: CreateToolsArgs): unknown[] {
  const { config, logger } = args;
  const queue =
    args.queue ??
    new RenderQueue({
      jobTimeoutMs: config.jobTimeoutMs,
    });

  const runtimeOptions = {
    cacheDir: config.cacheDir,
    allowNetwork: config.allowNetwork,
    ...(config.chromiumExecutablePath ? { browserExecutable: config.chromiumExecutablePath } : {}),
  };

  const listTool = {
    name: "remotion_list_compositions",
    label: "Remotion List Compositions",
    description:
      "List the <Composition>s defined by a Remotion project. The entryPoint must be an absolute path inside a configured templateRoots directory.",
    parameters: ListSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      let entryPoint: string;
      try {
        entryPoint = requireString(rawParams, "entryPoint") satisfies ListInput["entryPoint"];
      } catch (err) {
        return errorResult(err);
      }
      try {
        const resolved = await resolveTemplateEntryPoint({
          entryPoint,
          templateRoots: config.templateRoots,
        });
        logJobStart(logger, { jobId: "list", kind: "list", entryPoint: resolved });
        const startedAt = Date.now();
        const compositions = await queue.enqueueList({
          entryPoint: resolved,
          ...runtimeOptions,
        });
        logJobFinish(logger, { jobId: "list", durationMs: Date.now() - startedAt });
        return jsonResult({ compositions });
      } catch (err) {
        logJobFailure(logger, { jobId: "list", durationMs: 0, error: err });
        return errorResult(err);
      }
    },
  };

  const renderVideoTool = {
    name: "remotion_render_video",
    label: "Remotion Render Video",
    description:
      "Render a Remotion <Composition> to an MP4 file. Returns the absolute output path and a file:// URL. Runs serially (concurrency=1) with a hard timeout.",
    parameters: RenderVideoSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      // Parse args inside the try/catch so that *every* failure path —
      // including "missing required field" — surfaces as a structured
      // isError result rather than a thrown exception. Agents handle the
      // former gracefully; the latter aborts the tool call.
      let entryPoint: string;
      let compositionId: string;
      let inputProps: Record<string, unknown>;
      let codec: RenderJobRequest["codec"];
      try {
        entryPoint = requireString(
          rawParams,
          "entryPoint",
        ) satisfies RenderVideoInput["entryPoint"];
        compositionId = requireString(rawParams, "compositionId");
        inputProps = optionalRecord(rawParams, "inputProps") ?? {};
        codec = (optionalString(rawParams, "codec") ?? "h264") as RenderJobRequest["codec"];
      } catch (err) {
        return errorResult(err);
      }
      const allocation = await allocateJobOutput(config, "mp4");
      const propsSummary = summarizeInputProps(inputProps);
      try {
        const resolved = await resolveTemplateEntryPoint({
          entryPoint,
          templateRoots: config.templateRoots,
        });
        logJobStart(logger, {
          jobId: allocation.jobId,
          kind: "video",
          entryPoint: resolved,
          compositionId,
          propsSummary,
        });
        const startedAt = Date.now();
        const job: RenderJobRequest = {
          jobId: allocation.jobId,
          entryPoint: resolved,
          compositionId,
          inputProps,
          kind: "video",
          codec,
          imageFormat: "png",
        };
        await queue.enqueueRender({
          job,
          outputPath: allocation.outputPath,
          ...runtimeOptions,
        });
        const sizeBytes = await verifyAndMeasure(allocation.outputPath, config.maxOutputBytes);
        const durationMs = Date.now() - startedAt;
        logJobFinish(logger, {
          jobId: allocation.jobId,
          durationMs,
          outputPath: allocation.outputPath,
          sizeBytes,
        });
        return jsonResult({
          jobId: allocation.jobId,
          outputPath: allocation.outputPath,
          fileUrl: allocation.fileUrl,
          sizeBytes,
          durationMs,
        });
      } catch (err) {
        logJobFailure(logger, { jobId: allocation.jobId, durationMs: 0, error: err });
        await cleanupJobDir(allocation.jobDir);
        return errorResult(err);
      }
    },
  };

  const renderStillTool = {
    name: "remotion_render_still",
    label: "Remotion Render Still",
    description:
      "Render a single frame of a Remotion <Composition> to a PNG or JPEG. Useful for quickly validating a template without paying full render cost.",
    parameters: RenderStillSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      // See `renderVideoTool` for why arg parsing lives inside the try/catch.
      let entryPoint: string;
      let compositionId: string;
      let inputProps: Record<string, unknown>;
      let imageFormat: "png" | "jpeg";
      let frame: number | undefined;
      try {
        entryPoint = requireString(
          rawParams,
          "entryPoint",
        ) satisfies RenderStillInput["entryPoint"];
        compositionId = requireString(rawParams, "compositionId");
        inputProps = optionalRecord(rawParams, "inputProps") ?? {};
        imageFormat = (optionalString(rawParams, "imageFormat") ?? "png") as "png" | "jpeg";
        frame = optionalNumber(rawParams, "frame");
      } catch (err) {
        return errorResult(err);
      }
      const allocation = await allocateJobOutput(config, imageFormat === "png" ? "png" : "jpeg");
      const propsSummary = summarizeInputProps(inputProps);
      try {
        const resolved = await resolveTemplateEntryPoint({
          entryPoint,
          templateRoots: config.templateRoots,
        });
        logJobStart(logger, {
          jobId: allocation.jobId,
          kind: "still",
          entryPoint: resolved,
          compositionId,
          propsSummary,
        });
        const startedAt = Date.now();
        const job: RenderJobRequest = {
          jobId: allocation.jobId,
          entryPoint: resolved,
          compositionId,
          inputProps,
          kind: "still",
          codec: "h264",
          imageFormat,
          ...(frame !== undefined ? { frame } : {}),
        };
        await queue.enqueueRender({
          job,
          outputPath: allocation.outputPath,
          ...runtimeOptions,
        });
        const sizeBytes = await verifyAndMeasure(allocation.outputPath, config.maxOutputBytes);
        const durationMs = Date.now() - startedAt;
        logJobFinish(logger, {
          jobId: allocation.jobId,
          durationMs,
          outputPath: allocation.outputPath,
          sizeBytes,
        });
        return jsonResult({
          jobId: allocation.jobId,
          outputPath: allocation.outputPath,
          fileUrl: allocation.fileUrl,
          sizeBytes,
          durationMs,
        });
      } catch (err) {
        logJobFailure(logger, { jobId: allocation.jobId, durationMs: 0, error: err });
        await cleanupJobDir(allocation.jobDir);
        return errorResult(err);
      }
    },
  };

  return [listTool, renderVideoTool, renderStillTool];
}
