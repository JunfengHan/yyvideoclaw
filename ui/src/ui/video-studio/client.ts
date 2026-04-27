// videoStudioClient — the single allowed HTTP surface between the
// Video Studio UI and the embedded Pixelle FastAPI backend.
//
// Responsibilities (per requirements §5.6, §8.1, §8.3):
//
//   1. Centralise every network call the Video Studio tab makes so the
//     loopback/token policy lives in exactly one file.
//   2. Reject any endpoint URL that isn't on `127.0.0.1` / `localhost`.
//     This is our last line of defence against an XSS that manages to
//     inject a different `window.videoStudioEndpoint` — without this check
//     it could pivot the bearer token to an attacker-controlled origin.
//   3. Normalise transport errors into a tiny set of typed exceptions
//     (`BackendNotReadyError`, `InstallRequiredError`, `TaskFailedError`,
//     `NetworkError`) so the Lit view can switch on them directly.
//   4. Provide an SSE-first, polling-fallback helper for `/tasks/{id}/events`
//     so the progress panel reacts live without needing a WebSocket.
//
// The client is framework-agnostic: it takes a plain `{ endpoint, token,
// fetch }` config and returns an object of async methods. This keeps it
// fully unit-testable with a stub `fetch` (we intentionally avoid depending
// on MSW; the yyvideoclaw monorepo doesn't ship it today).

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export type FrameTemplate = {
  readonly key: string;
  readonly label?: string;
  readonly width?: number;
  readonly height?: number;
};

export type Pipeline = "standard" | "asset-based" | "linear" | "custom";

export type AspectRatio = "9:16" | "16:9" | "1:1";

export type VideoTaskRequest = {
  readonly topic: string;
  readonly title?: string;
  readonly narration?: string;
  readonly aspectRatio: AspectRatio;
  readonly pipeline: Pipeline;
  readonly frameTemplate?: string;
  readonly model?: string;
};

export type TaskPhase = "title" | "narration" | "images" | "frames" | "tts" | "compose";

export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export type TaskSnapshot = {
  readonly id: string;
  readonly status: TaskStatus;
  readonly phase?: TaskPhase | null;
  readonly progress?: number | null;
  readonly output?: { readonly videoUrl?: string | null } | null;
  readonly error?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
};

export type TaskEvent = {
  readonly phase: TaskPhase;
  readonly progress?: number;
  readonly message?: string;
};

export type VideoStudioClientConfig = {
  /** Loopback URL exposed by the main process, e.g. `http://127.0.0.1:34567`. */
  readonly endpoint: string;
  /** Loopback bearer for the embedded backend (never leaves main↔renderer). */
  readonly token: string;
  /** Inject-able fetch (default: the global `fetch`). */
  readonly fetch?: typeof globalThis.fetch;
  /** Pixelle API prefix (default `/api`, matching upstream). */
  readonly apiPrefix?: string;
};

// ---------------------------------------------------------------------------
// Error model.
// ---------------------------------------------------------------------------

export class BackendNotReadyError extends Error {
  constructor(message = "Video Studio backend is not ready yet.") {
    super(message);
    this.name = "BackendNotReadyError";
  }
}

export class InstallRequiredError extends Error {
  constructor(message = "Video Studio backend is not installed.") {
    super(message);
    this.name = "InstallRequiredError";
  }
}

export class TaskFailedError extends Error {
  readonly taskId: string | null;
  constructor(taskId: string | null, message: string) {
    super(message);
    this.name = "TaskFailedError";
    this.taskId = taskId;
  }
}

export class NetworkError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "NetworkError";
    this.status = status;
  }
}

export class InsecureEndpointError extends Error {
  constructor(url: string) {
    super(`Refused to call non-loopback endpoint: ${url}`);
    this.name = "InsecureEndpointError";
  }
}

// ---------------------------------------------------------------------------
// Loopback guard.
// ---------------------------------------------------------------------------

/**
 * Exported so the supervisor and Settings diagnostics can reuse the exact
 * same predicate and never disagree on what "loopback" means.
 */
export function isLoopbackUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  const host = parsed.hostname;
  return host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "localhost";
}

// ---------------------------------------------------------------------------
// Client implementation.
// ---------------------------------------------------------------------------

export type VideoStudioClient = {
  readonly getTemplates: () => Promise<readonly FrameTemplate[]>;
  readonly getPipelines: () => readonly Pipeline[];
  readonly createVideoTask: (req: VideoTaskRequest) => Promise<TaskSnapshot>;
  readonly getTask: (id: string) => Promise<TaskSnapshot>;
  readonly listTasks: () => Promise<readonly TaskSnapshot[]>;
  readonly streamTaskEvents: (
    id: string,
    onEvent: (event: TaskEvent | TaskSnapshot) => void,
    onError?: (err: Error) => void,
  ) => { readonly close: () => void };
  readonly getMediaUrl: (pathname: string) => string;
};

const DEFAULT_API_PREFIX = "/api";
const PIPELINES: readonly Pipeline[] = ["standard", "asset-based", "linear", "custom"];

export function createVideoStudioClient(cfg: VideoStudioClientConfig): VideoStudioClient {
  if (!isLoopbackUrl(cfg.endpoint)) {
    throw new InsecureEndpointError(cfg.endpoint);
  }
  const fetchImpl = cfg.fetch ?? globalThis.fetch;
  const apiPrefix = cfg.apiPrefix ?? DEFAULT_API_PREFIX;
  const endpointBase = cfg.endpoint.replace(/\/+$/, "");

  function buildUrl(path: string): string {
    const suffix = path.startsWith("/") ? path : `/${path}`;
    const full = `${endpointBase}${apiPrefix}${suffix}`;
    if (!isLoopbackUrl(full)) {
      throw new InsecureEndpointError(full);
    }
    return full;
  }

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const url = buildUrl(path);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          accept: "application/json",
          authorization: `Bearer ${cfg.token}`,
          ...(init?.body ? { "content-type": "application/json" } : {}),
        },
      });
    } catch (err) {
      // `TypeError: Failed to fetch` in browsers maps to "backend not up".
      throw new BackendNotReadyError(err instanceof Error ? err.message : String(err));
    }
    if (response.status === 503) {
      throw new BackendNotReadyError();
    }
    if (response.status === 404 && path.startsWith("/frame")) {
      // 404 on a frame endpoint during first launch typically means the
      // install wizard hasn't finished unpacking templates yet.
      throw new InstallRequiredError();
    }
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { detail?: unknown };
        if (typeof body?.detail === "string") detail = body.detail;
      } catch {
        // Response had no JSON body; keep the status string as-is.
      }
      throw new NetworkError(detail, response.status);
    }
    return (await response.json()) as T;
  }

  return {
    async getTemplates() {
      const res = await call<{ templates?: readonly FrameTemplate[] } | readonly FrameTemplate[]>(
        "/frame/templates",
      );
      return Array.isArray(res) ? res : (res.templates ?? []);
    },

    getPipelines() {
      return PIPELINES;
    },

    async createVideoTask(req) {
      const body = JSON.stringify({
        topic: req.topic,
        title: req.title ?? null,
        narration: req.narration ?? null,
        aspect_ratio: req.aspectRatio,
        pipeline: req.pipeline,
        frame_template: req.frameTemplate ?? null,
        model: req.model ?? null,
      });
      return call<TaskSnapshot>("/video/generate/async", { method: "POST", body });
    },

    async getTask(id) {
      return call<TaskSnapshot>(`/tasks/${encodeURIComponent(id)}`);
    },

    async listTasks() {
      const res = await call<readonly TaskSnapshot[] | { tasks?: readonly TaskSnapshot[] }>(
        "/tasks",
      );
      return Array.isArray(res) ? res : (res.tasks ?? []);
    },

    streamTaskEvents(id, onEvent, onError) {
      const url = buildUrl(`/tasks/${encodeURIComponent(id)}/events`);
      const supportsSse = typeof EventSource !== "undefined";
      if (supportsSse) {
        // Note: EventSource cannot carry custom headers; for loopback-only
        // traffic we fall back to query-string bearer. The Pixelle side
        // accepts both — see `api/dependencies.py`.
        const sse = new EventSource(`${url}?token=${encodeURIComponent(cfg.token)}`);
        sse.onmessage = (evt) => {
          try {
            onEvent(JSON.parse(evt.data) as TaskEvent | TaskSnapshot);
          } catch (err) {
            onError?.(err instanceof Error ? err : new Error(String(err)));
          }
        };
        sse.onerror = () => onError?.(new NetworkError("SSE connection dropped"));
        return { close: () => sse.close() };
      }
      // Polling fallback: every 1500ms until status leaves the running set.
      let cancelled = false;
      const tick = async (): Promise<void> => {
        if (cancelled) return;
        try {
          const snap = await call<TaskSnapshot>(`/tasks/${encodeURIComponent(id)}`);
          onEvent(snap);
          if (
            snap.status === "succeeded" ||
            snap.status === "failed" ||
            snap.status === "cancelled"
          ) {
            return;
          }
        } catch (err) {
          onError?.(err instanceof Error ? err : new Error(String(err)));
        }
        setTimeout(() => {
          void tick();
        }, 1_500);
      };
      void tick();
      return {
        close: () => {
          cancelled = true;
        },
      };
    },

    getMediaUrl(pathname) {
      // Media files are served verbatim by Pixelle's `files` router; we
      // intentionally do not sign this URL because Pixelle stays on
      // loopback only (see §8.1).
      const suffix = pathname.startsWith("/") ? pathname : `/${pathname}`;
      const full = `${endpointBase}${apiPrefix}/files${suffix}`;
      if (!isLoopbackUrl(full)) {
        throw new InsecureEndpointError(full);
      }
      return full;
    },
  };
}
