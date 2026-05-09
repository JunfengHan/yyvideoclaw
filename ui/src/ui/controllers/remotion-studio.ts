// Remotion Studio controller.
//
// Single bridge between the `<remotion-studio-view>` Lit render and the
// `extensions/remotion/` plugin's `/remotion/*` HTTP routes. Mirrors the
// shape of `./video-studio.ts` (status snapshot polling + write verbs)
// but trimmed because Remotion has no installer/supervisor — the plugin
// manages templates entirely on its own.
//
// What lives in this file:
//   - HTTP wire types (mirror server-side TemplatesResponse, JobSnapshot, etc.).
//   - `RemotionStudioControllerState` — the slice of AppViewState this
//     controller owns.
//   - `loadRemotionStudioStatus`, `loadRemotionTemplates`, `submitRemotionRender`,
//     `pollRemotionJob`, `loadRemotionHistory`, `cancelRemotionJob`.
//   - `buildRemotionArtifactUrl` — composes a same-origin URL the `<video>`
//     tag can play. The artifact route is gateway-authenticated, so the URL
//     here goes via fetch+blob in the view (auth header can't ride a plain
//     <video src=…>). The view layer decides how to consume the URL.
//
// Why duplicate the auth+fetch helpers from `video-studio.ts`:
//   the helper is small enough (≈40 LOC) that copying it is cheaper than
//   adding a shared abstraction with two callers, and it keeps the two
//   controllers independently evolvable. See the equivalent comment in
//   `video-studio.ts:121` for the same rationale.

import { resolveControlUiAuthCandidates } from "../control-ui-auth.ts";
import { normalizeBasePath } from "../navigation.ts";

// ---------------------------------------------------------------------------
// Wire types — kept in sync with extensions/remotion/src/server/routes.ts.
// ---------------------------------------------------------------------------

export type RemotionStatusWire = {
  readonly enabled: true;
  readonly templateRoots: readonly string[];
  readonly outputDir: string;
  readonly jobsActive: number;
  readonly jobsTotal: number;
};

export type RemotionStudioCompositionMetadata = {
  readonly label?: string;
  readonly description?: string;
  readonly inputPropsSchema?: Record<string, unknown>;
};

export type RemotionTemplateCompositionWire = {
  readonly compositionId: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationInFrames: number;
  readonly metadata?: RemotionStudioCompositionMetadata;
};

export type RemotionTemplateWire = {
  readonly entryPoint: string;
  readonly compositions: readonly RemotionTemplateCompositionWire[];
  readonly metadataAvailable: boolean;
};

export type RemotionTemplatesResponseWire = {
  readonly templates: readonly RemotionTemplateWire[];
  readonly errors: ReadonlyArray<{ readonly entryPoint: string; readonly reason: string }>;
};

export type RemotionRenderRequestBody = {
  readonly kind: "video" | "still";
  readonly entryPoint: string;
  readonly compositionId: string;
  readonly inputProps?: Record<string, unknown>;
  readonly codec?: "h264" | "h265" | "vp8" | "vp9";
  readonly imageFormat?: "png" | "jpeg";
  readonly frame?: number;
};

export type RemotionJobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export type RemotionJobSnapshotWire = {
  readonly jobId: string;
  readonly kind: "video" | "still" | "list";
  readonly status: RemotionJobStatus;
  readonly enqueuedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly outputPath?: string;
  readonly mediaLibraryPath?: string;
  readonly sizeBytes?: number;
  readonly error?: string;
  readonly request: {
    readonly entryPoint: string;
    readonly compositionId?: string;
    readonly inputPropsSummary?: { readonly keys: readonly string[]; readonly sizeBytes: number };
  };
};

export type RemotionJobResponseWire = {
  readonly job: RemotionJobSnapshotWire;
  readonly artifactUrl: string | null;
};

export type RemotionHistoryResponseWire = {
  readonly jobs: ReadonlyArray<RemotionJobResponseWire>;
};

// ---------------------------------------------------------------------------
// State slice consumed by app-view-state.ts.
// ---------------------------------------------------------------------------

export type RemotionStudioDraft = {
  readonly entryPoint: string | null;
  readonly compositionId: string | null;
  readonly kind: "video" | "still";
  readonly imageFormat: "png" | "jpeg";
  readonly codec: "h264" | "h265" | "vp8" | "vp9";
  readonly frame: number | null;
  /** Free-form JSON textarea contents (the source of truth for inputProps). */
  readonly inputPropsJson: string;
  /** "form" mode renders a structured form when the schema is supported. */
  readonly mode: "json" | "form";
};

export const DEFAULT_REMOTION_STUDIO_DRAFT: RemotionStudioDraft = Object.freeze({
  entryPoint: null,
  compositionId: null,
  kind: "video" as const,
  imageFormat: "png" as const,
  codec: "h264" as const,
  frame: null,
  inputPropsJson: "{}",
  mode: "form" as const,
});

export type RemotionStudioControllerState = {
  remotionStatus: RemotionStatusWire | null;
  remotionStatusError: string | null;
  remotionTemplates: readonly RemotionTemplateWire[];
  remotionTemplatesErrors: ReadonlyArray<{ entryPoint: string; reason: string }>;
  remotionTemplatesLoading: boolean;
  remotionTemplatesError: string | null;
  remotionDraft: RemotionStudioDraft;
  remotionCurrentJob: RemotionJobResponseWire | null;
  remotionSubmitting: boolean;
  remotionSubmitError: string | null;
  remotionHistory: readonly RemotionJobResponseWire[];
  /** Active polling intervals, by jobId. Only one ever runs at a time per job. */
  remotionPollHandles: Map<string, ReturnType<typeof setInterval>>;
};

export function defaultRemotionStudioState(): RemotionStudioControllerState {
  return {
    remotionStatus: null,
    remotionStatusError: null,
    remotionTemplates: [],
    remotionTemplatesErrors: [],
    remotionTemplatesLoading: false,
    remotionTemplatesError: null,
    remotionDraft: DEFAULT_REMOTION_STUDIO_DRAFT,
    remotionCurrentJob: null,
    remotionSubmitting: false,
    remotionSubmitError: null,
    remotionHistory: [],
    remotionPollHandles: new Map(),
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing — same pattern as video-studio.ts.
// ---------------------------------------------------------------------------

export type RemotionHttpDeps = {
  readonly basePath: string;
  readonly hello?: { auth?: { deviceToken?: string | null } | null } | null;
  readonly settings?: { token?: string | null } | null;
  readonly password?: string | null;
  /** Inject-able for tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof globalThis.fetch;
};

async function callRemotionRoute<T>(
  deps: RemotionHttpDeps,
  subpath: `/${string}`,
  init: RequestInit = {},
): Promise<T> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const basePath = normalizeBasePath(deps.basePath ?? "");
  const url = basePath ? `${basePath}${subpath}` : subpath;
  const candidates = resolveControlUiAuthCandidates(deps);
  const attempts = candidates.length > 0 ? candidates : [""];
  let lastError: unknown = null;
  for (const candidate of attempts) {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    };
    if (candidate) {
      headers.Authorization = `Bearer ${candidate}`;
    }
    try {
      const res = await fetchImpl(url, { ...init, headers, credentials: "same-origin" });
      if (res.ok) {
        return (await res.json()) as T;
      }
      if (res.status !== 401 && res.status !== 403) {
        const text = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
      }
      lastError = new Error(`${res.status} ${res.statusText}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(typeof lastError === "string" ? lastError : "remotion route failed");
}

// ---------------------------------------------------------------------------
// Public verbs.
// ---------------------------------------------------------------------------

export async function loadRemotionStatus(deps: RemotionHttpDeps): Promise<RemotionStatusWire> {
  return await callRemotionRoute<RemotionStatusWire>(deps, "/remotion/status");
}

export async function loadRemotionTemplates(
  deps: RemotionHttpDeps,
): Promise<RemotionTemplatesResponseWire> {
  return await callRemotionRoute<RemotionTemplatesResponseWire>(deps, "/remotion/templates");
}

export async function submitRemotionRender(
  deps: RemotionHttpDeps,
  body: RemotionRenderRequestBody,
): Promise<RemotionJobResponseWire> {
  return await callRemotionRoute<RemotionJobResponseWire>(deps, "/remotion/render", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function pollRemotionJob(
  deps: RemotionHttpDeps,
  jobId: string,
): Promise<RemotionJobResponseWire> {
  return await callRemotionRoute<RemotionJobResponseWire>(
    deps,
    `/remotion/jobs/${encodeURIComponent(jobId)}` as `/${string}`,
  );
}

export async function loadRemotionHistory(
  deps: RemotionHttpDeps,
  limit = 20,
): Promise<RemotionHistoryResponseWire> {
  return await callRemotionRoute<RemotionHistoryResponseWire>(
    deps,
    `/remotion/history?limit=${limit}` as `/${string}`,
  );
}

/**
 * Build the URL the `<video>` tag will use. The plugin's artifact route is
 * gateway-authenticated; for a plain `<video src=…>` we cannot ride the
 * Authorization header. Three workarounds the view can pick:
 *
 *   (a) Fetch the artifact via authenticated fetch → Blob → object URL.
 *       Works everywhere but uses memory proportional to file size.
 *   (b) Show a "click to download / open externally" link.
 *   (c) Use a signed-URL handshake (not implemented; would require a new
 *       `/remotion/jobs/:id/signed-artifact-url` route).
 *
 * For v1 we go with (a) in the view layer. This helper only composes the
 * URL; auth and blob conversion happen at the call site (so we don't hold
 * the buffer in controller state across re-renders).
 */
export function buildRemotionArtifactUrl(deps: RemotionHttpDeps, jobId: string): string {
  const basePath = normalizeBasePath(deps.basePath ?? "");
  const sub = `/remotion/jobs/${encodeURIComponent(jobId)}/artifact`;
  return basePath ? `${basePath}${sub}` : sub;
}

/**
 * Fetch the artifact bytes through the authenticated route. Returns a Blob
 * the view can wrap in URL.createObjectURL().
 */
export async function fetchRemotionArtifactBlob(
  deps: RemotionHttpDeps,
  jobId: string,
): Promise<Blob> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const url = buildRemotionArtifactUrl(deps, jobId);
  const candidates = resolveControlUiAuthCandidates(deps);
  const attempts = candidates.length > 0 ? candidates : [""];
  let lastError: unknown = null;
  for (const candidate of attempts) {
    const headers: Record<string, string> = {};
    if (candidate) {
      headers.Authorization = `Bearer ${candidate}`;
    }
    try {
      const res = await fetchImpl(url, { headers, credentials: "same-origin" });
      if (res.ok) {
        return await res.blob();
      }
      if (res.status !== 401 && res.status !== 403) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      lastError = new Error(`${res.status} ${res.statusText}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("failed to fetch artifact");
}

// ---------------------------------------------------------------------------
// Polling.
// ---------------------------------------------------------------------------

export interface JobPollHandlers {
  /** Called whenever the job snapshot changes. */
  onUpdate: (job: RemotionJobResponseWire) => void;
  /** Called once when the job reaches a terminal state. */
  onTerminal?: (job: RemotionJobResponseWire) => void;
}

/**
 * Start polling a single job until it reaches a terminal status. The caller
 * should keep the returned handle so they can `clearInterval` if the user
 * navigates away. We do NOT call `clearInterval` automatically on terminal
 * because tests want to assert the final tick was delivered.
 */
export function startRemotionJobPolling(
  deps: RemotionHttpDeps,
  jobId: string,
  handlers: JobPollHandlers,
  intervalMs = 500,
): ReturnType<typeof setInterval> {
  let inFlight = false;
  let stopped = false;
  const tick = async () => {
    if (inFlight || stopped) {
      return;
    }
    inFlight = true;
    try {
      const snapshot = await pollRemotionJob(deps, jobId);
      if (stopped) {
        return;
      }
      handlers.onUpdate(snapshot);
      if (
        snapshot.job.status === "done" ||
        snapshot.job.status === "error" ||
        snapshot.job.status === "cancelled"
      ) {
        stopped = true;
        clearInterval(handle);
        handlers.onTerminal?.(snapshot);
      }
    } finally {
      inFlight = false;
    }
  };
  // Immediate first tick (don't make the user wait `intervalMs` for the first
  // status flip).
  void tick();
  const handle = setInterval(() => void tick(), intervalMs);
  return handle;
}

export function stopRemotionJobPolling(state: RemotionStudioControllerState, jobId: string): void {
  const handle = state.remotionPollHandles.get(jobId);
  if (handle) {
    clearInterval(handle);
    state.remotionPollHandles.delete(jobId);
  }
}

export function stopAllRemotionPolling(state: RemotionStudioControllerState): void {
  for (const handle of state.remotionPollHandles.values()) {
    clearInterval(handle);
  }
  state.remotionPollHandles.clear();
}

// ---------------------------------------------------------------------------
// Draft helpers.
// ---------------------------------------------------------------------------

export function updateRemotionDraft(
  state: RemotionStudioControllerState,
  patch: Partial<RemotionStudioDraft>,
): void {
  state.remotionDraft = { ...state.remotionDraft, ...patch };
}

/** Validate JSON textarea content. Returns parsed object or an Error. */
export function tryParseInputPropsJson(
  raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "inputProps must be a JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}
