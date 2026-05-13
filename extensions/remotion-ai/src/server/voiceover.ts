import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ResolvedRemotionAiConfig } from "../config.js";
import type { RouteContext, RouteHandler } from "./routes.js";
import { badRequest, jsonResponse, methodNotAllowed, readJsonBody } from "./routes.js";

const MAX_CUES = 80;
const MAX_CUE_TEXT_CHARS = 1_200;
const MAX_TOTAL_TEXT_CHARS = 12_000;
const DEFAULT_FPS = 30;
const JOB_ID_RE = /^[a-zA-Z0-9_-]{6,64}$/u;

type JsonRecord = Record<string, unknown>;

type VoiceoverRequest = {
  readonly jobId?: unknown;
  readonly workspaceDir?: unknown;
  readonly voiceoverId?: unknown;
  readonly fps?: unknown;
  readonly text?: unknown;
  readonly subtitles?: unknown;
  readonly tts?: unknown;
  readonly provider?: unknown;
  readonly providerOverrides?: unknown;
  readonly disableFallback?: unknown;
  readonly timeoutMs?: unknown;
};

type CueInput = {
  readonly id?: unknown;
  readonly text?: unknown;
  readonly startFrame?: unknown;
  readonly endFrame?: unknown;
  readonly startMs?: unknown;
  readonly endMs?: unknown;
  readonly durationMs?: unknown;
};

type NormalizedCue = {
  readonly id: string;
  readonly text: string;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly durationInFrames: number;
  readonly startMs: number;
  readonly endMs: number;
};

type ManifestCue = NormalizedCue & {
  readonly audioFile: string;
  readonly staticFile: string | null;
  readonly provider: string | null;
  readonly outputFormat: string | null;
  readonly voiceCompatible: boolean | null;
};

type VoiceoverManifest = {
  readonly voiceoverId: string;
  readonly fps: number;
  readonly durationInFrames: number;
  readonly cues: readonly ManifestCue[];
};

class VoiceoverHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VoiceoverHttpError";
  }
}

export const handleVoiceover: RouteHandler = async (req, res, ctx) => {
  if (req.method !== "POST") {
    return methodNotAllowed(res, "POST");
  }

  let targetDir: string | undefined;
  try {
    const body = await readJsonBody<VoiceoverRequest>(req);
    const fps = normalizeFps(body.fps);
    const cues = normalizeCues(body, fps);
    const voiceoverId = normalizeVoiceoverId(body.voiceoverId);
    const target = await resolveVoiceoverTarget(body, ctx, voiceoverId);
    targetDir = target.dir;

    await fs.rm(target.dir, { recursive: true, force: true });
    await fs.mkdir(target.dir, { recursive: true });

    const ttsOptions = normalizeTtsOptions(body);
    const generated: ManifestCue[] = [];
    for (const [index, cue] of cues.entries()) {
      const result = await ctx.runtime.tts.textToSpeech({
        text: cue.text,
        cfg: ctx.coreConfig,
        ...(ttsOptions.overrides ? { overrides: ttsOptions.overrides } : {}),
        ...(ttsOptions.disableFallback !== undefined
          ? { disableFallback: ttsOptions.disableFallback }
          : ttsOptions.overrides?.provider
            ? { disableFallback: true }
            : {}),
        ...(ttsOptions.timeoutMs !== undefined ? { timeoutMs: ttsOptions.timeoutMs } : {}),
      });
      if (!result.success || !result.audioPath) {
        throw new VoiceoverHttpError(503, "tts_failed", result.error ?? "TTS conversion failed");
      }
      const extension = normalizeAudioExtension(path.extname(result.audioPath));
      const fileName = `${String(index + 1).padStart(3, "0")}-${safeSegment(cue.id)}${extension}`;
      const dest = path.join(target.dir, fileName);
      await fs.copyFile(result.audioPath, dest);
      generated.push({
        ...cue,
        audioFile: dest,
        staticFile: target.staticFileBase ? `${target.staticFileBase}/${fileName}` : null,
        provider: result.provider ?? null,
        outputFormat: result.outputFormat ?? null,
        voiceCompatible: result.voiceCompatible ?? null,
      });
    }

    const manifest: VoiceoverManifest = {
      voiceoverId,
      fps,
      durationInFrames: Math.max(...generated.map((cue) => cue.endFrame), 0),
      cues: generated,
    };
    const manifestPath = path.join(target.dir, "manifest.json");
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const generatedModulePath = target.workspaceDir
      ? await writeGeneratedModule(target.workspaceDir, manifest)
      : undefined;

    return jsonResponse(res, 201, {
      voiceoverId,
      workspaceDir: target.workspaceDir ?? null,
      publicDir: target.dir,
      manifestPath,
      generatedModulePath: generatedModulePath ?? null,
      staticFileBase: target.staticFileBase,
      durationInFrames: manifest.durationInFrames,
      fps,
      cues: generated,
    });
  } catch (err) {
    if (targetDir && err instanceof VoiceoverHttpError && err.status >= 500) {
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (err instanceof VoiceoverHttpError) {
      return jsonResponse(res, err.status, { error: err.code, detail: err.message });
    }
    return badRequest(res, err instanceof Error ? err.message : String(err));
  }
};

function normalizeFps(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_FPS;
  }
  const fps = Number(value);
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) {
    throw new VoiceoverHttpError(400, "invalid_fps", "fps must be a number between 1 and 240");
  }
  return fps;
}

function normalizeCues(body: VoiceoverRequest, fps: number): NormalizedCue[] {
  const rawSubtitles = Array.isArray(body.subtitles) ? body.subtitles : undefined;
  const cuesInput = rawSubtitles ?? buildSingleCueInput(body.text);
  if (!cuesInput || cuesInput.length === 0) {
    throw new VoiceoverHttpError(400, "missing_subtitles", "subtitles or text is required");
  }
  if (cuesInput.length > MAX_CUES) {
    throw new VoiceoverHttpError(
      400,
      "too_many_subtitles",
      `subtitles is limited to ${MAX_CUES} cues`,
    );
  }

  let nextFrame = 0;
  let totalChars = 0;
  const cues = cuesInput.map((entry, index) => {
    const raw = asRecord(entry, `subtitles[${index}]`);
    const cue = normalizeCue(raw, index, fps, nextFrame);
    nextFrame = Math.max(nextFrame, cue.endFrame);
    totalChars += cue.text.length;
    if (totalChars > MAX_TOTAL_TEXT_CHARS) {
      throw new VoiceoverHttpError(
        400,
        "subtitles_too_long",
        `subtitle text exceeds ${MAX_TOTAL_TEXT_CHARS} chars`,
      );
    }
    return cue;
  });
  return cues.sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
}

function buildSingleCueInput(text: unknown): CueInput[] | undefined {
  if (typeof text !== "string" || text.trim().length === 0) {
    return undefined;
  }
  return [{ text }];
}

function normalizeCue(
  raw: JsonRecord,
  index: number,
  fps: number,
  fallbackStartFrame: number,
): NormalizedCue {
  const text = normalizeCueText(raw.text, index);
  const startFrame =
    readFrame(raw.startFrame) ?? msToFrame(readNumber(raw.startMs), fps) ?? fallbackStartFrame;
  const explicitEndFrame = readFrame(raw.endFrame) ?? msToFrame(readNumber(raw.endMs), fps);
  const durationFrame = msToFrame(readNumber(raw.durationMs), fps);
  const endFrame =
    explicitEndFrame ??
    (durationFrame ? startFrame + durationFrame : startFrame + estimateCueFrames(text, fps));
  if (endFrame <= startFrame) {
    throw new VoiceoverHttpError(
      400,
      "invalid_cue_timing",
      `subtitles[${index}] end must be after start`,
    );
  }
  return {
    id: normalizeCueId(raw.id, index),
    text,
    startFrame,
    endFrame,
    durationInFrames: endFrame - startFrame,
    startMs: Math.round((startFrame / fps) * 1000),
    endMs: Math.round((endFrame / fps) * 1000),
  };
}

function normalizeCueText(value: unknown, index: number): string {
  if (typeof value !== "string") {
    throw new VoiceoverHttpError(
      400,
      "invalid_cue_text",
      `subtitles[${index}].text must be a string`,
    );
  }
  const text = value.trim();
  if (!text) {
    throw new VoiceoverHttpError(
      400,
      "invalid_cue_text",
      `subtitles[${index}].text must not be empty`,
    );
  }
  if (text.length > MAX_CUE_TEXT_CHARS) {
    throw new VoiceoverHttpError(
      400,
      "cue_text_too_long",
      `subtitles[${index}].text exceeds ${MAX_CUE_TEXT_CHARS} chars`,
    );
  }
  return text;
}

function normalizeCueId(value: unknown, index: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return `cue-${String(index + 1).padStart(3, "0")}`;
  }
  return safeSegment(value.trim()).slice(0, 64) || `cue-${String(index + 1).padStart(3, "0")}`;
}

function estimateCueFrames(text: string, fps: number): number {
  const seconds = Math.max(0.8, Math.min(12, text.length / 5.5));
  return Math.ceil(seconds * fps);
}

function msToFrame(ms: number | undefined, fps: number): number | undefined {
  return ms === undefined ? undefined : Math.round((ms / 1000) * fps);
}

function readFrame(value: unknown): number | undefined {
  const number = readNumber(value);
  if (number === undefined) {
    return undefined;
  }
  if (!Number.isInteger(number) || number < 0) {
    throw new VoiceoverHttpError(
      400,
      "invalid_frame",
      "frame values must be non-negative integers",
    );
  }
  return number;
}

function readNumber(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new VoiceoverHttpError(
      400,
      "invalid_number",
      "timing values must be non-negative numbers",
    );
  }
  return number;
}

function normalizeVoiceoverId(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    const safe = safeSegment(value.trim()).slice(0, 64);
    if (safe) {
      return safe;
    }
  }
  return randomUUID();
}

type VoiceoverTarget = {
  readonly workspaceDir: string | null;
  readonly dir: string;
  readonly staticFileBase: string | null;
};

async function resolveVoiceoverTarget(
  body: VoiceoverRequest,
  ctx: RouteContext,
  voiceoverId: string,
): Promise<VoiceoverTarget> {
  const workspaceDir = await resolveRequestedWorkspace(body, ctx);
  if (workspaceDir) {
    return {
      workspaceDir,
      dir: path.join(workspaceDir, "public", "voiceover", voiceoverId),
      staticFileBase: `voiceover/${voiceoverId}`,
    };
  }
  await fs.mkdir(ctx.config.defaultOutputRoot, { recursive: true });
  const root = await fs.realpath(ctx.config.defaultOutputRoot);
  return {
    workspaceDir: null,
    dir: path.join(root, "_voiceovers", voiceoverId),
    staticFileBase: null,
  };
}

async function resolveRequestedWorkspace(
  body: VoiceoverRequest,
  ctx: RouteContext,
): Promise<string | null> {
  const jobId = normalizeOptionalString(body.jobId);
  const workspaceFromJob = jobId ? resolveJobWorkspace(jobId, ctx) : undefined;
  const workspaceRaw = workspaceFromJob ?? normalizeOptionalString(body.workspaceDir);
  if (!workspaceRaw) {
    return null;
  }
  if (!path.isAbsolute(workspaceRaw)) {
    throw new VoiceoverHttpError(400, "invalid_workspace", "workspaceDir must be an absolute path");
  }
  let realWorkspace: string;
  try {
    realWorkspace = await fs.realpath(workspaceRaw);
  } catch (err) {
    throw new VoiceoverHttpError(
      404,
      "workspace_not_found",
      `workspaceDir not found: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const allowedRoots = await resolveAllowedRoots(ctx.config);
  if (!allowedRoots.some((root) => isWithin(root, realWorkspace))) {
    throw new VoiceoverHttpError(
      403,
      "workspace_not_allowed",
      "workspaceDir is outside remotion-ai output roots",
    );
  }
  return realWorkspace;
}

function resolveJobWorkspace(jobId: string, ctx: RouteContext): string {
  if (!JOB_ID_RE.test(jobId)) {
    throw new VoiceoverHttpError(400, "invalid_job_id", "jobId must be 6-64 URL-safe characters");
  }
  return ctx.jobs.get(jobId)?.workspaceDir || path.join(ctx.config.defaultOutputRoot, jobId);
}

async function resolveAllowedRoots(config: ResolvedRemotionAiConfig): Promise<string[]> {
  const roots: string[] = [];
  await fs.mkdir(config.defaultOutputRoot, { recursive: true });
  roots.push(await fs.realpath(config.defaultOutputRoot));
  for (const entry of config.outputRootAllowlist ?? []) {
    try {
      roots.push(await fs.realpath(entry));
    } catch {
      // Missing allowlist roots are ignored, matching workspace creation.
    }
  }
  return roots;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

type TtsOptions = {
  readonly overrides?: {
    readonly provider?: string;
    readonly providerOverrides?: Record<string, Record<string, unknown>>;
  };
  readonly disableFallback?: boolean;
  readonly timeoutMs?: number;
};

function normalizeTtsOptions(body: VoiceoverRequest): TtsOptions {
  const tts = asOptionalRecord(body.tts, "tts") ?? {};
  const provider = normalizeOptionalString(tts.provider) ?? normalizeOptionalString(body.provider);
  const providerOverrides = normalizeProviderOverrides(
    tts.providerOverrides ?? body.providerOverrides,
  );
  const disableFallback = readOptionalBoolean(tts.disableFallback ?? body.disableFallback);
  const timeoutMs = readOptionalPositiveInteger(tts.timeoutMs ?? body.timeoutMs, "timeoutMs");
  const overrides =
    provider || providerOverrides
      ? { ...(provider ? { provider } : {}), ...(providerOverrides ? { providerOverrides } : {}) }
      : undefined;
  return {
    ...(overrides ? { overrides } : {}),
    ...(disableFallback !== undefined ? { disableFallback } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function normalizeProviderOverrides(
  value: unknown,
): Record<string, Record<string, unknown>> | undefined {
  const raw = asOptionalRecord(value, "providerOverrides");
  if (!raw) {
    return undefined;
  }
  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [provider, overrides] of Object.entries(raw)) {
    const providerId = provider.trim();
    if (!providerId) {
      continue;
    }
    const overrideRecord = asOptionalRecord(overrides, `providerOverrides.${providerId}`);
    if (!overrideRecord) {
      throw new VoiceoverHttpError(
        400,
        "invalid_provider_overrides",
        "providerOverrides values must be objects",
      );
    }
    normalized[providerId] = overrideRecord;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new VoiceoverHttpError(400, "invalid_boolean", "disableFallback must be a boolean");
  }
  return value;
}

function readOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new VoiceoverHttpError(400, "invalid_number", `${field} must be a positive integer`);
  }
  return parsed;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asRecord(value: unknown, field: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VoiceoverHttpError(400, "invalid_subtitle", `${field} must be an object`);
  }
  return value as JsonRecord;
}

function asOptionalRecord(value: unknown, field: string): JsonRecord | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VoiceoverHttpError(400, "invalid_object", `${field} must be an object`);
  }
  return value as JsonRecord;
}

function normalizeAudioExtension(extension: string): string {
  const lower = extension.toLowerCase();
  return /^\.[a-z0-9]{1,8}$/u.test(lower) ? lower : ".mp3";
}

function safeSegment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
}

async function writeGeneratedModule(
  workspaceDir: string,
  manifest: VoiceoverManifest,
): Promise<string | undefined> {
  const srcDir = path.join(workspaceDir, "src");
  try {
    const stat = await fs.stat(srcDir);
    if (!stat.isDirectory()) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const generatedDir = path.join(srcDir, "generated");
  await fs.mkdir(generatedDir, { recursive: true });
  const modulePath = path.join(generatedDir, "voiceover.ts");
  const publicCues = manifest.cues.map((cue) => ({
    id: cue.id,
    text: cue.text,
    startFrame: cue.startFrame,
    endFrame: cue.endFrame,
    durationInFrames: cue.durationInFrames,
    startMs: cue.startMs,
    endMs: cue.endMs,
    staticFile: cue.staticFile,
  }));
  const content = [
    "// Generated by the remotion-ai voiceover API.",
    `export const voiceoverId = ${JSON.stringify(manifest.voiceoverId)};`,
    `export const voiceoverFps = ${JSON.stringify(manifest.fps)};`,
    `export const voiceoverDurationInFrames = ${JSON.stringify(manifest.durationInFrames)};`,
    `export const voiceoverCues = ${JSON.stringify(publicCues, null, 2)} as const;`,
    "",
  ].join("\n");
  await fs.writeFile(modulePath, content, "utf8");
  return modulePath;
}
