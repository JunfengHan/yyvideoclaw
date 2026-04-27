import {
  assertOkOrThrowHttpError,
  fetchWithTimeout,
  normalizeBaseUrl,
  postJsonRequest,
} from "openclaw/plugin-sdk/provider-http";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationProviderCapabilities,
  VideoGenerationProviderConfiguredContext,
  VideoGenerationRequest,
  VideoGenerationResult,
} from "openclaw/plugin-sdk/video-generation";

/**
 * HTTP bridge to a yy-Pixelle-Video service. yy-Pixelle-Video is a topic→full
 * short video engine (text-only, end-to-end), so this provider only implements
 * the `generate` mode and explicitly declines image/video-to-video modes.
 */

const PLUGIN_ID = "yy-pixelle-video";
const PROVIDER_ID = "yy-pixelle-video";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 50 * 60 * 1_000; // 50 minutes
const DEFAULT_MODEL = "pixelle-standard";

type ProviderConfig = Record<string, unknown>;

type PixelleTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

type PixelleTaskResult = {
  video_url?: unknown;
  duration?: unknown;
  file_size?: unknown;
};

type PixelleTaskResponse = {
  task_id?: unknown;
  status?: unknown;
  result?: unknown;
  error?: unknown;
};

type PixelleAsyncSubmitResponse = {
  success?: unknown;
  message?: unknown;
  task_id?: unknown;
};

const CAPABILITIES: VideoGenerationProviderCapabilities = {
  // Only the generate mode is supported (text/topic → full short video).
  maxVideos: 1,
  aspectRatios: ["9:16", "16:9", "1:1"],
  supportsAspectRatio: true,
  supportsAudio: true,
  supportsWatermark: false,
  generate: {
    maxVideos: 1,
    aspectRatios: ["9:16", "16:9", "1:1"],
    supportsAspectRatio: true,
  },
  imageToVideo: { enabled: false },
  videoToVideo: { enabled: false },
};

export function getYyPixelleVideoConfig(cfg?: {
  models?: { providers?: Record<string, unknown> };
}): ProviderConfig {
  const raw = cfg?.models?.providers?.[PLUGIN_ID];
  return isRecord(raw) ? raw : {};
}

function resolveEndpoint(config: ProviderConfig): string | undefined {
  const endpoint = normalizeOptionalString(config.endpoint);
  if (!endpoint) {
    return undefined;
  }
  const normalized = normalizeBaseUrl(endpoint) ?? endpoint;
  return normalized.replace(/\/+$/u, "");
}

function resolveApiKey(config: ProviderConfig): string | undefined {
  return normalizeOptionalString(config.apiKey);
}

function resolveInteger(config: ProviderConfig, key: string): number | undefined {
  const value = config[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function resolveBoolean(config: ProviderConfig, key: string): boolean | undefined {
  const value = config[key];
  return typeof value === "boolean" ? value : undefined;
}

function mapAspectRatioToFrameTemplate(aspect?: string): string | undefined {
  switch (aspect?.trim()) {
    case "9:16":
      return "1080x1920/image_default.html";
    case "16:9":
      return "1920x1080/image_full.html";
    case "1:1":
      return "1080x1080/image_minimal_framed.html";
    default:
      return undefined;
  }
}

function buildAuthHeaders(apiKey?: string): Headers {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function extractTaskId(body: PixelleAsyncSubmitResponse): string {
  const taskId = normalizeOptionalString(body.task_id);
  if (!taskId) {
    const message = normalizeOptionalString(body.message);
    throw new Error(
      `yy-Pixelle-Video async submit returned no task_id${message ? ` (${message})` : ""}.`,
    );
  }
  return taskId;
}

function extractTaskStatus(body: PixelleTaskResponse): PixelleTaskStatus {
  const status = normalizeOptionalString(body.status);
  if (
    status === "pending" ||
    status === "running" ||
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    return status;
  }
  throw new Error(`yy-Pixelle-Video returned unexpected task status "${status ?? "<missing>"}".`);
}

function extractTaskResult(body: PixelleTaskResponse): PixelleTaskResult {
  const raw = body.result;
  return isRecord(raw) ? (raw as PixelleTaskResult) : {};
}

async function readJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error(`${label}: failed to parse JSON response body.`, { cause: cause as Error });
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

type PollTaskParams = {
  baseUrl: string;
  headers: Headers;
  taskId: string;
  pollIntervalMs: number;
  deadline: number;
  allowPrivateNetwork: boolean;
  fetchFn: typeof fetch;
};

async function pollUntilTerminal(params: PollTaskParams): Promise<PixelleTaskResponse> {
  const url = `${params.baseUrl}/api/tasks/${encodeURIComponent(params.taskId)}`;
  for (;;) {
    if (Date.now() > params.deadline) {
      throw new Error(
        `yy-Pixelle-Video task ${params.taskId} timed out (no terminal status within the configured window).`,
      );
    }
    const res = await fetchWithTimeout(
      url,
      { method: "GET", headers: params.headers },
      Math.max(5_000, Math.min(60_000, params.pollIntervalMs * 2)),
      params.fetchFn,
    );
    await assertOkOrThrowHttpError(res, "yy-Pixelle-Video task polling");
    const body = await readJson<PixelleTaskResponse>(res, "yy-Pixelle-Video task polling");
    const status = extractTaskStatus(body);
    if (status === "completed" || status === "failed" || status === "cancelled") {
      return body;
    }
    await sleep(params.pollIntervalMs);
  }
}

async function downloadGeneratedVideo(params: {
  videoUrl: string;
  headers: Headers;
  timeoutMs: number;
  allowPrivateNetwork: boolean;
  fetchFn: typeof fetch;
}): Promise<Buffer> {
  const res = await fetchWithTimeout(
    params.videoUrl,
    { method: "GET", headers: params.headers },
    params.timeoutMs,
    params.fetchFn,
  );
  await assertOkOrThrowHttpError(res, "yy-Pixelle-Video video download");
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export function buildYyPixelleVideoGenerationProvider(): VideoGenerationProvider {
  const fetchFn = fetch;

  return {
    id: PROVIDER_ID,
    label: "yy-Pixelle-Video",
    defaultModel: DEFAULT_MODEL,
    capabilities: CAPABILITIES,
    isConfigured: (ctx: VideoGenerationProviderConfiguredContext) => {
      const config = getYyPixelleVideoConfig(ctx.cfg);
      const endpoint = resolveEndpoint(config);
      return typeof endpoint === "string" && isValidHttpUrl(endpoint);
    },
    async generateVideo(req: VideoGenerationRequest): Promise<VideoGenerationResult> {
      const config = getYyPixelleVideoConfig(req.cfg);
      const endpoint = resolveEndpoint(config);
      if (!endpoint || !isValidHttpUrl(endpoint)) {
        throw new Error(
          `yy-Pixelle-Video endpoint is missing or invalid. Set models.providers["${PLUGIN_ID}"].endpoint to the service base URL (e.g. http://127.0.0.1:8000).`,
        );
      }

      const apiKey = resolveApiKey(config);
      const pollIntervalMs = resolveInteger(config, "pollIntervalMs") ?? DEFAULT_POLL_INTERVAL_MS;
      const timeoutMs = resolveInteger(config, "timeoutMs") ?? req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const allowPrivateNetwork =
        resolveBoolean(config, "allowPrivateNetwork") ??
        (() => {
          try {
            const parsed = new URL(endpoint);
            return parsed.hostname === "localhost" || parsed.hostname.startsWith("127.");
          } catch {
            return false;
          }
        })();

      const frameTemplate =
        mapAspectRatioToFrameTemplate(req.aspectRatio) ?? "1080x1920/image_default.html";

      const submitBody: Record<string, unknown> = {
        text: req.prompt,
        mode: "generate",
        frame_template: frameTemplate,
      };
      if (typeof req.durationSeconds === "number" && req.durationSeconds > 0) {
        // yy-Pixelle-Video derives total duration from scene count and narration
        // length; we do not pass durationSeconds through to avoid schema errors.
      }

      const authHeaders = buildAuthHeaders(apiKey);

      // 1) Submit task
      const submitRes = await postJsonRequest({
        url: `${endpoint}/api/video/generate/async`,
        headers: authHeaders,
        body: submitBody,
        timeoutMs: 30_000,
        fetchFn,
        allowPrivateNetwork,
      });
      await assertOkOrThrowHttpError(submitRes, "yy-Pixelle-Video async submit");
      const submitBodyJson = await readJson<PixelleAsyncSubmitResponse>(
        submitRes,
        "yy-Pixelle-Video async submit",
      );
      const taskId = extractTaskId(submitBodyJson);

      // 2) Poll until terminal
      const deadline = Date.now() + timeoutMs;
      const taskBody = await pollUntilTerminal({
        baseUrl: endpoint,
        headers: authHeaders,
        taskId,
        pollIntervalMs,
        deadline,
        allowPrivateNetwork,
        fetchFn,
      });
      const status = extractTaskStatus(taskBody);

      if (status === "failed" || status === "cancelled") {
        const errorDetail =
          normalizeOptionalString(taskBody.error) ??
          `yy-Pixelle-Video task ${taskId} ended with status "${status}".`;
        throw new Error(errorDetail);
      }

      // 3) Download resulting MP4
      const result = extractTaskResult(taskBody);
      const videoUrl = normalizeOptionalString(result.video_url);
      if (!videoUrl) {
        throw new Error(
          `yy-Pixelle-Video task ${taskId} completed but response is missing result.video_url.`,
        );
      }
      const duration = typeof result.duration === "number" ? result.duration : undefined;
      const buffer = await downloadGeneratedVideo({
        videoUrl,
        headers: authHeaders,
        timeoutMs: Math.min(timeoutMs, 10 * 60_000),
        allowPrivateNetwork,
        fetchFn,
      });

      const asset: GeneratedVideoAsset = {
        buffer,
        mimeType: "video/mp4",
        fileName: `${taskId}.mp4`,
        metadata: {
          taskId,
          sourceUrl: videoUrl,
          ...(duration != null ? { durationSeconds: duration } : {}),
          ...(typeof result.file_size === "number" ? { fileSize: result.file_size } : {}),
        },
      };

      return {
        videos: [asset],
        model: req.model?.trim() || DEFAULT_MODEL,
        metadata: {
          taskId,
          frameTemplate,
          ...(duration != null ? { durationSeconds: duration } : {}),
        },
      };
    },
  };
}
