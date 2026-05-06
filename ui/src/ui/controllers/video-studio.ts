// Video Studio controller.
//
// The single bridge between the `<video-studio-view>` Lit render and the
// main-process runtime plugin under `extensions/video-studio/`. Mirrors the
// shape of other read-only status controllers (see ./health.ts) while
// layering on the write verbs Video Studio needs (install / start / stop /
// generate).
//
// The plugin exposes JSON routes at `/video-studio/*`; we reach them with
// the same same-origin + bearer-candidate pattern used by
// `control-ui-bootstrap.ts` so the controller works whether the Control UI
// sits behind gateway-password or gateway-token auth.

import { i18n } from "../../i18n/index.ts";
import { resolveControlUiAuthCandidates } from "../control-ui-auth.ts";
import { normalizeBasePath } from "../navigation.ts";
import type {
  AspectRatio,
  FrameTemplate,
  Pipeline,
  TaskSnapshot,
  VideoTaskRequest,
} from "../video-studio/client.ts";

// ---------------------------------------------------------------------------
// Wire types (kept in sync with extensions/video-studio/index.ts).
// ---------------------------------------------------------------------------

export type VideoStudioBackendWire =
  | { readonly kind: "ready" }
  | { readonly kind: "idle" }
  | { readonly kind: "missing"; readonly reason: string }
  | { readonly kind: "starting" }
  | { readonly kind: "error"; readonly reason: string };

export type VideoStudioSupervisorStatusWire =
  | { readonly kind: "idle" }
  | { readonly kind: "starting"; readonly attempt: number }
  | {
      readonly kind: "running";
      readonly pid: number;
      readonly port: number;
      readonly startedAt: string;
      readonly streamlitPort: number | null;
      readonly streamlitUrl: string | null;
      readonly streamlitPid: number | null;
    }
  | {
      readonly kind: "retrying";
      readonly attempt: number;
      readonly retryInMs: number;
      readonly reason: string;
    }
  | { readonly kind: "stopped"; readonly reason: string };

export type VideoStudioResolutionWire =
  | { readonly kind: "binary"; readonly version: string }
  | { readonly kind: "venv"; readonly version: string }
  | { readonly kind: "missing"; readonly reason: string };

export type VideoStudioStatusPayload = {
  readonly resolution: VideoStudioResolutionWire;
  readonly supervisor: VideoStudioSupervisorStatusWire;
  readonly backend: VideoStudioBackendWire;
  readonly endpoint: string | null;
  readonly recentLogTail: ReadonlyArray<{
    readonly stream: "stdout" | "stderr";
    readonly line: string;
  }>;
};

// ---------------------------------------------------------------------------
// State slice consumed by app-view-state.ts (extended with dreaming-style
// `videoStudio*` fields — see AppViewState).
// ---------------------------------------------------------------------------

export type VideoStudioControllerState = {
  /** `true` while a /video-studio/* request is in flight. */
  videoStudioLoading: boolean;
  /** Latest status snapshot from GET /video-studio/status. */
  videoStudioStatus: VideoStudioStatusPayload | null;
  /** Human-readable error from the last network/5xx call. */
  videoStudioError: string | null;
  /** Track the last explicit user-initiated action so the UI can disable
   *  buttons without over-disabling the whole panel. */
  videoStudioActionInFlight: "install" | "start" | "stop" | "restart" | "generate" | null;
  /** Polling timer handle (`window.setInterval` result). `null` while
   *  polling is paused (e.g. user navigated away from the tab). */
  videoStudioPollTimer: number | null;
  /** Current form draft (topic + narration + aspect + pipeline + template). */
  videoStudioDraft: VideoStudioDraft;
  /** Latest generation task snapshot driving the progress panel / result. */
  videoStudioCurrentTask: TaskSnapshot | null;
  /** Recent task snapshots surfaced in the History sidebar. */
  videoStudioHistory: TaskSnapshot[];
  /** Frame-template catalog loaded from `/api/frame/templates`. */
  videoStudioTemplates: FrameTemplate[];
  /** `true` when the History sidebar is open (user preference). */
  videoStudioHistoryExpanded: boolean;
  /** Per-task poll handle; cleared when the task reaches a terminal state. */
  videoStudioTaskPollTimer: number | null;
};

/** User-editable draft for the next generation. */
export type VideoStudioDraft = {
  title: string;
  narration: string;
  aspectRatio: AspectRatio;
  pipeline: Pipeline;
  frameTemplate: string | null;
};

export const DEFAULT_VIDEO_STUDIO_DRAFT: VideoStudioDraft = Object.freeze({
  title: "",
  narration: "",
  aspectRatio: "9:16",
  pipeline: "standard",
  frameTemplate: null,
});

// Auth + fetch helpers are intentionally duplicated here (instead of
// centralised) because (a) the shape is tiny, (b) the control-ui-bootstrap
// copy isn't exported as a helper, and (c) the pattern is already stable.

// Shape that satisfies both `basePath` (for URL building) and the fields
// `resolveControlUiAuthCandidates` reads (`hello` / `settings` / `password`).
// `AppViewState` already has all of these, so the caller just passes `state`
// directly — no additional `authSource` wrapper field required.
export type VideoStudioHttpDeps = {
  readonly basePath: string;
  readonly hello?: { auth?: { deviceToken?: string | null } | null } | null;
  readonly settings?: { token?: string | null } | null;
  readonly password?: string | null;
  /** Inject-able for Node-side tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof globalThis.fetch;
};

// ---------------------------------------------------------------------------
// Low-level HTTP helper.
// ---------------------------------------------------------------------------

async function callVideoStudioRoute<T>(
  deps: VideoStudioHttpDeps,
  subpath: `/${string}`,
  init: RequestInit = {},
): Promise<T> {
  if (typeof window === "undefined") {
    throw new Error("videoStudio controller is browser-only");
  }
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const basePath = normalizeBasePath(deps.basePath ?? "");
  const url = basePath ? `${basePath}${subpath}` : subpath;
  // `deps` itself satisfies ControlUiAuthSource (hello / settings / password).
  // Using `deps` directly avoids an undefined `deps.authSource` crash when
  // callers forget the wrapper field — see note on VideoStudioHttpDeps.
  const candidates = resolveControlUiAuthCandidates(deps);
  const attempts = candidates.length > 0 ? candidates : [""];
  let lastError: unknown = null;
  for (const candidate of attempts) {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    };
    if (candidate) headers.Authorization = `Bearer ${candidate}`;
    try {
      const res = await fetchImpl(url, { ...init, headers, credentials: "same-origin" });
      if (res.ok) {
        return (await res.json()) as T;
      }
      if (res.status !== 401 && res.status !== 403) {
        const text = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
      }
      // otherwise: fall through and try the next auth candidate
      lastError = new Error(`${res.status} ${res.statusText}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "unknown error"));
}

// ---------------------------------------------------------------------------
// Public API — matches the ./health.ts shape: pure function first, then a
// state-mutating wrapper that toggles `videoStudioLoading`.
// ---------------------------------------------------------------------------

export async function loadVideoStudioStatus(
  deps: VideoStudioHttpDeps,
): Promise<VideoStudioStatusPayload> {
  return callVideoStudioRoute<VideoStudioStatusPayload>(deps, "/video-studio/status");
}

export async function loadVideoStudioStatusState(
  state: VideoStudioControllerState & VideoStudioHttpDeps,
): Promise<void> {
  if (state.videoStudioLoading) {
    return;
  }
  state.videoStudioLoading = true;
  state.videoStudioError = null;
  try {
    state.videoStudioStatus = await loadVideoStudioStatus(state);
  } catch (err) {
    state.videoStudioError = err instanceof Error ? err.message : String(err);
  } finally {
    state.videoStudioLoading = false;
  }
  // Mirror the current host UI locale to the embedded Pixelle backend so
  // the iframe's language picker stays aligned with the shell. Idempotent
  // and dedupe-guarded inside `ensureHostLanguageSync`, so it's safe to
  // call from every status refresh — first-time arrivals (cold tab open
  // or HMR replacing the polling closure) will push, subsequent ticks
  // skip the network round-trip.
  ensureHostLanguageSync(state);
  // Note: we deliberately no longer auto-call `loadFrameTemplates` when the
  // backend transitions to `ready`. The new embedded Streamlit UI renders
  // its own template picker, so pre-fetching via the legacy FastAPI
  // `/api/frame/templates` proxy route would only surface a 404 (the route
  // no longer exists upstream) and pollute `videoStudioError`, dragging the
  // view into its error card. Callers that still need the template catalog
  // can opt-in by calling `loadFrameTemplates` directly.
}

// ---------------------------------------------------------------------------
// Write verbs — each one:
//   1. flags videoStudioActionInFlight so the UI can reflect "in progress"
//   2. calls the route, surfaces errors through videoStudioError
//   3. refreshes the status snapshot so the view updates immediately
// ---------------------------------------------------------------------------

async function performAction(
  state: VideoStudioControllerState & VideoStudioHttpDeps,
  action: "install" | "start" | "stop" | "restart",
  subpath: `/video-studio/${string}`,
): Promise<void> {
  if (state.videoStudioActionInFlight) {
    return;
  }
  state.videoStudioActionInFlight = action;
  state.videoStudioError = null;
  try {
    await callVideoStudioRoute<{ ok?: boolean; error?: string; detail?: string }>(state, subpath, {
      method: "POST",
    });
    await loadVideoStudioStatusState(state);
  } catch (err) {
    state.videoStudioError = err instanceof Error ? err.message : String(err);
  } finally {
    state.videoStudioActionInFlight = null;
  }
}

export async function installVideoStudioBackend(
  state: VideoStudioControllerState & VideoStudioHttpDeps,
): Promise<void> {
  await performAction(state, "install", "/video-studio/install");
}

export async function startVideoStudioBackend(
  state: VideoStudioControllerState & VideoStudioHttpDeps,
): Promise<void> {
  await performAction(state, "start", "/video-studio/start");
}

export async function stopVideoStudioBackend(
  state: VideoStudioControllerState & VideoStudioHttpDeps,
): Promise<void> {
  await performAction(state, "stop", "/video-studio/stop");
}

/**
 * Ask the runtime plugin to restart the Pixelle backend. Useful after the
 * supervisor has auto-stopped on idle or landed in a terminal `stopped`
 * state following exhausted crash retries — the user gets one button to
 * bring the child back without hunting for Stop + Start.
 */
export async function restartVideoStudioBackend(
  state: VideoStudioControllerState & VideoStudioHttpDeps,
): Promise<void> {
  await performAction(state, "restart", "/video-studio/restart");
}

// ---------------------------------------------------------------------------
// Generation flow.
//
// All Pixelle-side calls go through /video-studio/proxy, which the runtime
// plugin forwards to the loopback FastAPI with the ephemeral internal token
// attached server-side. The browser never sees that token — see
// extensions/video-studio/index.ts#handleProxy.
// ---------------------------------------------------------------------------

const PROXY_PREFIX = "/video-studio/proxy";

type ProxyInit = Omit<RequestInit, "headers"> & { readonly jsonBody?: unknown };

async function proxyCall<T>(
  deps: VideoStudioHttpDeps,
  pixelleSubpath: `/${string}`,
  init: ProxyInit = {},
): Promise<T> {
  const body = init.jsonBody !== undefined ? JSON.stringify(init.jsonBody) : init.body;
  return callVideoStudioRoute<T>(deps, `${PROXY_PREFIX}${pixelleSubpath}` as `/${string}`, {
    ...init,
    body,
  });
}

export function updateVideoStudioDraft(
  state: VideoStudioControllerState,
  patch: Partial<VideoStudioDraft>,
): void {
  state.videoStudioDraft = { ...state.videoStudioDraft, ...patch };
}

export async function loadFrameTemplates(
  state: VideoStudioControllerState & VideoStudioHttpDeps,
): Promise<void> {
  try {
    const res = await proxyCall<{ templates?: FrameTemplate[] } | FrameTemplate[]>(
      state,
      "/api/frame/templates",
    );
    state.videoStudioTemplates = Array.isArray(res) ? res : (res.templates ?? []);
  } catch (err) {
    state.videoStudioError = err instanceof Error ? err.message : String(err);
  }
}

function taskFromRaw(raw: unknown): TaskSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : typeof r.task_id === "string" ? r.task_id : null;
  if (!id) return null;
  const statusCandidate = typeof r.status === "string" ? r.status : "pending";
  const status: TaskSnapshot["status"] =
    statusCandidate === "succeeded" ||
    statusCandidate === "failed" ||
    statusCandidate === "cancelled" ||
    statusCandidate === "running"
      ? statusCandidate
      : "pending";
  const phase =
    typeof r.phase === "string" &&
    ["title", "narration", "images", "frames", "tts", "compose"].includes(r.phase)
      ? (r.phase as TaskSnapshot["phase"])
      : null;
  const output =
    r.output && typeof r.output === "object" && "videoUrl" in (r.output as Record<string, unknown>)
      ? { videoUrl: (r.output as { videoUrl?: string | null }).videoUrl ?? null }
      : r.video_url
        ? { videoUrl: String(r.video_url) }
        : null;
  return {
    id,
    status,
    phase,
    progress: typeof r.progress === "number" ? r.progress : null,
    output,
    error: typeof r.error === "string" ? r.error : null,
    createdAt: typeof r.created_at === "string" ? r.created_at : undefined,
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : undefined,
  };
}

export async function generateVideoTask(
  state: VideoStudioControllerState & VideoStudioHttpDeps,
  onChange?: () => void,
): Promise<void> {
  if (state.videoStudioActionInFlight) return;
  // Require the backend to be ready before submitting a generation request.
  if (state.videoStudioStatus?.backend.kind !== "ready") {
    state.videoStudioError = "Backend not ready yet — click Install or wait for startup to finish.";
    onChange?.();
    return;
  }
  const draft = state.videoStudioDraft;
  const topic = draft.narration.trim() || draft.title.trim();
  if (!topic) {
    state.videoStudioError = "Enter a title or narration before generating.";
    onChange?.();
    return;
  }
  state.videoStudioActionInFlight = "generate";
  state.videoStudioError = null;
  try {
    const req: VideoTaskRequest = {
      topic,
      title: draft.title.trim() || undefined,
      narration: draft.narration.trim() || undefined,
      aspectRatio: draft.aspectRatio,
      pipeline: draft.pipeline,
      frameTemplate: draft.frameTemplate ?? undefined,
    };
    const raw = await proxyCall<unknown>(state, "/api/video/generate/async", {
      method: "POST",
      jsonBody: {
        topic: req.topic,
        title: req.title ?? null,
        narration: req.narration ?? null,
        aspect_ratio: req.aspectRatio,
        pipeline: req.pipeline,
        frame_template: req.frameTemplate ?? null,
        model: req.model ?? null,
      },
    });
    const snap = taskFromRaw(raw);
    if (snap) {
      state.videoStudioCurrentTask = snap;
      onChange?.();
      startTaskPolling(state, snap.id, onChange);
    } else {
      state.videoStudioError = "Pixelle accepted the request but returned no task id.";
      onChange?.();
    }
  } catch (err) {
    state.videoStudioError = err instanceof Error ? err.message : String(err);
    onChange?.();
  } finally {
    state.videoStudioActionInFlight = null;
  }
}

const TASK_POLL_INTERVAL_MS = 2_000;

function startTaskPolling(
  state: VideoStudioControllerState & VideoStudioHttpDeps,
  taskId: string,
  onChange?: () => void,
): void {
  if (typeof window === "undefined") return;
  stopTaskPolling(state);
  state.videoStudioTaskPollTimer = window.setInterval(() => {
    void (async () => {
      try {
        const raw = await proxyCall<unknown>(state, `/api/tasks/${encodeURIComponent(taskId)}`);
        const snap = taskFromRaw(raw);
        if (!snap) return;
        state.videoStudioCurrentTask = snap;
        if (
          snap.status === "succeeded" ||
          snap.status === "failed" ||
          snap.status === "cancelled"
        ) {
          stopTaskPolling(state);
          // Prepend to history, dedupe by id, cap at 20.
          const remaining = state.videoStudioHistory.filter((t) => t.id !== snap.id);
          state.videoStudioHistory = [snap, ...remaining].slice(0, 20);
        }
        onChange?.();
      } catch (err) {
        state.videoStudioError = err instanceof Error ? err.message : String(err);
        onChange?.();
      }
    })();
  }, TASK_POLL_INTERVAL_MS);
}

export function stopTaskPolling(state: VideoStudioControllerState): void {
  if (typeof window === "undefined") return;
  if (state.videoStudioTaskPollTimer == null) return;
  window.clearInterval(state.videoStudioTaskPollTimer);
  state.videoStudioTaskPollTimer = null;
}

// ---------------------------------------------------------------------------
// View-model mapping.
//
// `<video-studio-view>` wants a `BackendState` shaped like the
// view-helpers.ts union (`ready | missing | starting | error`). The wire
// payload already matches — this helper exists so the mapping lives in one
// place and future payload drift doesn't silently leak into the view.
// ---------------------------------------------------------------------------

export type BackendStateForView =
  | { readonly kind: "ready"; readonly streamlitUrl: string | null }
  | { readonly kind: "idle" }
  | { readonly kind: "missing" }
  | { readonly kind: "starting" }
  | { readonly kind: "error"; readonly reason: string };

export function mapStatusToBackendState(
  snapshot: VideoStudioStatusPayload | null,
  loading: boolean,
  error: string | null,
): BackendStateForView {
  if (error) {
    return { kind: "error", reason: error };
  }
  if (!snapshot) {
    return loading ? { kind: "starting" } : { kind: "starting" };
  }
  if (snapshot.backend.kind === "missing") {
    return { kind: "missing" };
  }
  // When the supervisor reports `ready`, surface the Streamlit loopback URL
  // so `<video-studio-view>` can embed it directly in an iframe. The URL is
  // sourced from the running supervisor status (not the top-level `endpoint`
  // field, which is a legacy alias) so the view stays in sync with the
  // actual child process port even across restarts.
  if (snapshot.backend.kind === "ready") {
    const sup = snapshot.supervisor;
    const streamlitUrl = sup.kind === "running" ? (sup.streamlitUrl ?? null) : null;
    return { kind: "ready", streamlitUrl };
  }
  // `idle`, `starting`, `error` pass through unchanged.
  return snapshot.backend;
}

// ---------------------------------------------------------------------------
// Polling lifecycle.
// ---------------------------------------------------------------------------

const STATUS_POLL_INTERVAL_MS = 3_000;

// ---------------------------------------------------------------------------
// Host UI language sync.
//
// The embedded Pixelle Streamlit only resolves its locale at process boot
// from the `PIXELLE_LANGUAGE` env var. To keep the embedded tab matching
// whatever language the yyvideoclaw shell is showing, we POST the current
// host UI locale to `/video-studio/host-language` whenever video-studio
// polling starts (cold start + tab re-entry) and whenever the user flips
// the shell language via the overview language picker.
//
// Dedupe on the last value sent so re-renders don't spam the route, and
// silently swallow errors — language drift is cosmetic, not fatal.
// ---------------------------------------------------------------------------

let lastSyncedHostLanguage: string | null = null;
let hostLanguageSubscription: (() => void) | null = null;
let hostLanguageDeps: VideoStudioHttpDeps | null = null;

async function postHostLanguage(deps: VideoStudioHttpDeps): Promise<void> {
  if (typeof window === "undefined") return;
  const locale = i18n.getLocale();
  if (!locale || locale === lastSyncedHostLanguage) return;
  lastSyncedHostLanguage = locale;
  try {
    await callVideoStudioRoute<{ ok?: boolean; restarted?: boolean }>(
      deps,
      "/video-studio/host-language",
      {
        method: "POST",
        body: JSON.stringify({ language: locale }),
      },
    );
  } catch {
    // Best-effort: a transient failure here just means the embedded tab
    // may briefly render in its previous locale until the next sync.
    lastSyncedHostLanguage = null;
  }
}

/**
 * Push the current host UI locale to the Video Studio backend so the
 * embedded Pixelle tab boots / re-renders in the same language as the
 * shell. Subscribes to host-language changes once so subsequent toggles
 * propagate automatically.
 *
 * Idempotent and safe to call from any tab-activation / status-refresh
 * path; downstream restarts are debounced inside the supervisor.
 */
export function ensureHostLanguageSync(deps: VideoStudioHttpDeps): void {
  if (typeof window === "undefined") return;
  hostLanguageDeps = deps;
  void postHostLanguage(deps);
  if (hostLanguageSubscription === null) {
    hostLanguageSubscription = i18n.subscribe(() => {
      if (hostLanguageDeps) {
        void postHostLanguage(hostLanguageDeps);
      }
    });
  }
}

export function startVideoStudioPolling(
  state: VideoStudioControllerState & VideoStudioHttpDeps,
  onTick?: () => void,
): void {
  if (typeof window === "undefined") return;
  if (state.videoStudioPollTimer != null) return;
  // Kick off an immediate status fetch so the UI doesn't wait 3s on first
  // render.
  void loadVideoStudioStatusState(state).then(() => onTick?.());
  state.videoStudioPollTimer = window.setInterval(() => {
    void loadVideoStudioStatusState(state).then(() => onTick?.());
  }, STATUS_POLL_INTERVAL_MS);
}

export function stopVideoStudioPolling(state: VideoStudioControllerState): void {
  if (typeof window === "undefined") return;
  if (state.videoStudioPollTimer == null) return;
  window.clearInterval(state.videoStudioPollTimer);
  state.videoStudioPollTimer = null;
}
