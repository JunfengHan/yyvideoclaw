// Remotion AI Create controller.
//
// HTTP/state bridge between the `<remotion-ai-panel>` Lit view and the
// `extensions/remotion-ai/` plugin's `/remotion-ai/*` routes. Mirrors the
// shape of `./remotion-studio.ts` (status snapshot polling + write verbs)
// for consistency, but tracks "AI Create jobs" instead of render jobs.
//
// What lives in this file:
//   - HTTP wire types — kept in sync with extensions/remotion-ai/src/server/routes.ts
//   - `RemotionAiControllerState` — the slice of AppViewState this owns.
//   - HTTP verbs: `submitRemotionAiJob`, `pollRemotionAiJob`,
//     `cancelRemotionAiJob`, `loadRemotionAiHistory`,
//     `loadRemotionAiLibrary`, `deleteRemotionAiLibraryEntry`.
//   - `startRemotionAiJobPolling` / `stopAllRemotionAiPolling` — drives the
//     in-flight job state. SSE endpoint exists server-side but the gateway's
//     bearer-only auth cannot ride a plain `<EventSource>` URL today, so M1
//     uses polling exclusively.
//   - Draft helpers (the form on the panel).

import { resolveControlUiAuthCandidates } from "../control-ui-auth.ts";
import { normalizeBasePath } from "../navigation.ts";

// ---------------------------------------------------------------------------
// Wire types — keep in sync with extensions/remotion-ai/src/server/routes.ts
// and extensions/remotion-ai/src/types.ts.
// ---------------------------------------------------------------------------

export type RemotionAiPhase =
  | "queued"
  | "workspace"
  | "skills"
  | "agent"
  | "bundle"
  | "select"
  | "still"
  | "retry"
  | "done"
  | "failed"
  | "cancelled";

export type RemotionAiEngineId = "codex";

export type RemotionAiJobSnapshotWire = {
  readonly jobId: string;
  readonly phase: RemotionAiPhase;
  readonly engine: RemotionAiEngineId;
  readonly workspaceDir: string;
  readonly enqueuedAt?: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly retryCount: number;
  readonly compositionId?: string;
  readonly stillPath?: string;
  readonly promptPreview?: string;
  /**
   * Server-side error summary (field name mirrors `JobSnapshot.errorSummary`
   * in extensions/remotion-ai/src/types.ts). When a job enters the `failed`
   * phase this is the one-line reason the UI should surface.
   */
  readonly errorSummary?: string;
  /** Legacy alias — kept for any callers that still read `.error`. */
  readonly error?: string;
};

export type RemotionAiJobEventWire =
  | { readonly type: "phase"; readonly jobId: string; readonly phase: RemotionAiPhase }
  | {
      readonly type: "agent_message";
      readonly jobId: string;
      readonly text: string;
    }
  | {
      readonly type: "tool_call";
      readonly jobId: string;
      readonly name: string;
      readonly callId: string;
    }
  | {
      readonly type: "tool_result";
      readonly jobId: string;
      readonly callId: string;
      readonly isError: boolean;
    }
  | {
      readonly type: "validation_failed";
      readonly jobId: string;
      readonly stage: string;
      readonly message: string;
      readonly attempt: number;
    }
  | {
      readonly type: "validation_succeeded";
      readonly jobId: string;
      readonly compositionId: string;
      readonly stillPath: string;
    }
  | {
      readonly type: "error";
      readonly jobId: string;
      readonly message: string;
    };

export type RemotionAiSubmitRequest = {
  readonly prompt: string;
  /** Optional — server falls back to its managed library root. */
  readonly outputRoot?: string;
  readonly engine?: RemotionAiEngineId;
  readonly retryMax?: number;
  readonly jobTimeoutMs?: number;
  readonly allowNetwork?: boolean;
};

export type RemotionAiSubmitResponse = {
  readonly job: RemotionAiJobSnapshotWire;
};

export type RemotionAiHistoryResponse = {
  readonly jobs: ReadonlyArray<RemotionAiJobSnapshotWire>;
};

export type RemotionAiCancelResponse = {
  readonly cancelled: boolean;
};

// ---------------------------------------------------------------------------
// Library wire types — /remotion-ai/library
// ---------------------------------------------------------------------------

/**
 * Disk-backed entry: a workspace on disk with a valid `.remotion-ai/job.json`
 * sidecar. Mirrors `LibraryEntry` on the server.
 */
export type RemotionAiLibraryEntryWire = {
  readonly jobId: string;
  readonly workspaceDir: string;
  readonly prompt: string;
  readonly promptPreview: string;
  readonly engine: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly entryPointAbsolute: string;
  readonly renderable: boolean;
  readonly sizeBytes: number | null;
};

/**
 * Live entry: a job that is currently in the JobsStore but hasn't
 * finished (so its workspace may not exist yet). Carries `live: true` so
 * the UI can render it differently (spinner, cancel button).
 */
export type RemotionAiLibraryLiveEntryWire = {
  readonly jobId: string;
  readonly workspaceDir: string;
  readonly prompt: string;
  readonly promptPreview: string;
  readonly engine: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly entryPointAbsolute: string;
  readonly renderable: false;
  readonly sizeBytes: null;
  readonly live: true;
  readonly phase: RemotionAiPhase;
  readonly retryCount: number;
};

export type RemotionAiLibraryAnyEntryWire =
  | RemotionAiLibraryEntryWire
  | RemotionAiLibraryLiveEntryWire;

export type RemotionAiLibraryResponseWire = {
  readonly libraryRoot: string;
  readonly entries: ReadonlyArray<RemotionAiLibraryAnyEntryWire>;
};

export function isLiveLibraryEntry(
  entry: RemotionAiLibraryAnyEntryWire,
): entry is RemotionAiLibraryLiveEntryWire {
  return (entry as RemotionAiLibraryLiveEntryWire).live === true;
}

// ---------------------------------------------------------------------------
// State slice consumed by app-view-state.ts (or any consumer that wants to
// embed the panel without touching the global app state).
// ---------------------------------------------------------------------------

export type RemotionAiDraft = {
  readonly prompt: string;
  /** UI-only: remember the engine choice when M2 introduces alternatives. */
  readonly engine: RemotionAiEngineId;
  /** UI-only: retry budget surface — surfaced as an optional "advanced"
   *  control. Server clamps between 0 and 10. */
  readonly retryMax: number;
};

export const DEFAULT_REMOTION_AI_DRAFT: RemotionAiDraft = Object.freeze({
  prompt: "",
  engine: "codex" as const,
  retryMax: 3,
});

export type RemotionAiControllerState = {
  remotionAiDraft: RemotionAiDraft;
  remotionAiCurrentJob: RemotionAiJobSnapshotWire | null;
  remotionAiHistory: readonly RemotionAiJobSnapshotWire[];
  remotionAiSubmitting: boolean;
  remotionAiSubmitError: string | null;
  remotionAiCancelling: boolean;
  /** Active polling intervals, by jobId. Only one ever runs per job. */
  remotionAiPollHandles: Map<string, ReturnType<typeof setInterval>>;
  /** Visible recent transcript line (last agent_message text). */
  remotionAiLastAgentMessage: string | null;
};

export function defaultRemotionAiState(): RemotionAiControllerState {
  return {
    remotionAiDraft: DEFAULT_REMOTION_AI_DRAFT,
    remotionAiCurrentJob: null,
    remotionAiHistory: [],
    remotionAiSubmitting: false,
    remotionAiSubmitError: null,
    remotionAiCancelling: false,
    remotionAiPollHandles: new Map(),
    remotionAiLastAgentMessage: null,
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing — pattern from remotion-studio.ts.
// ---------------------------------------------------------------------------

export type RemotionAiHttpDeps = {
  readonly basePath: string;
  readonly hello?: { auth?: { deviceToken?: string | null } | null } | null;
  readonly settings?: { token?: string | null } | null;
  readonly password?: string | null;
  /** Inject-able for tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof globalThis.fetch;
};

async function callRoute<T>(
  deps: RemotionAiHttpDeps,
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
        // Some endpoints return 202 with an empty body; tolerate that.
        const text = await res.text();
        if (text.length === 0) {
          return undefined as unknown as T;
        }
        return JSON.parse(text) as T;
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
    : new Error(typeof lastError === "string" ? lastError : "remotion-ai route failed");
}

// ---------------------------------------------------------------------------
// Public verbs.
// ---------------------------------------------------------------------------

export async function submitRemotionAiJob(
  deps: RemotionAiHttpDeps,
  body: RemotionAiSubmitRequest,
): Promise<RemotionAiSubmitResponse> {
  return await callRoute<RemotionAiSubmitResponse>(deps, "/remotion-ai/jobs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function pollRemotionAiJob(
  deps: RemotionAiHttpDeps,
  jobId: string,
): Promise<RemotionAiJobSnapshotWire> {
  // NOTE: GET /remotion-ai/jobs/:id returns `{ job: JobSnapshot }` (wrapper
  // shape chosen to match cancel's `{ cancelled, job }`). Unwrap to a bare
  // snapshot so callers — and the polling loop's `onUpdate` / `onTerminal`
  // — always see the same flat shape they get from `submitRemotionAiJob`'s
  // `res.job`.
  const body = await callRoute<{ readonly job: RemotionAiJobSnapshotWire }>(
    deps,
    `/remotion-ai/jobs/${encodeURIComponent(jobId)}` as `/${string}`,
  );
  return body.job;
}

export async function cancelRemotionAiJob(
  deps: RemotionAiHttpDeps,
  jobId: string,
): Promise<RemotionAiCancelResponse> {
  return await callRoute<RemotionAiCancelResponse>(
    deps,
    `/remotion-ai/jobs/${encodeURIComponent(jobId)}/cancel` as `/${string}`,
    { method: "POST" },
  );
}

export async function loadRemotionAiHistory(
  deps: RemotionAiHttpDeps,
  limit = 20,
): Promise<RemotionAiHistoryResponse> {
  return await callRoute<RemotionAiHistoryResponse>(
    deps,
    `/remotion-ai/history?limit=${limit}` as `/${string}`,
  );
}

export async function loadRemotionAiLibrary(
  deps: RemotionAiHttpDeps,
): Promise<RemotionAiLibraryResponseWire> {
  return await callRoute<RemotionAiLibraryResponseWire>(deps, "/remotion-ai/library");
}

export async function deleteRemotionAiLibraryEntry(
  deps: RemotionAiHttpDeps,
  jobId: string,
): Promise<{ readonly deleted: boolean }> {
  return await callRoute<{ readonly deleted: boolean }>(
    deps,
    `/remotion-ai/library/${encodeURIComponent(jobId)}` as `/${string}`,
    { method: "DELETE" },
  );
}

// ---------------------------------------------------------------------------
// Polling.
// ---------------------------------------------------------------------------

export interface RemotionAiPollHandlers {
  /** Called whenever the job snapshot changes. */
  onUpdate: (snapshot: RemotionAiJobSnapshotWire) => void;
  /** Called once when the job reaches a terminal phase. */
  onTerminal?: (snapshot: RemotionAiJobSnapshotWire) => void;
  /** Surfaced for the panel to show transient backend errors (without
   *  killing the polling loop). */
  onPollError?: (error: Error) => void;
}

const TERMINAL_PHASES: ReadonlySet<RemotionAiPhase> = new Set(["done", "failed", "cancelled"]);

/**
 * Start polling a single job until it reaches a terminal phase. The caller
 * keeps the returned handle so they can `clearInterval` if the user
 * navigates away. The interval is NOT auto-cleared on terminal — the
 * tick code clears it the moment it observes a terminal phase, but tests
 * sometimes want the final tick to be observable.
 */
export function startRemotionAiJobPolling(
  deps: RemotionAiHttpDeps,
  jobId: string,
  handlers: RemotionAiPollHandlers,
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
      const snapshot = await pollRemotionAiJob(deps, jobId);
      if (stopped) {
        return;
      }
      handlers.onUpdate(snapshot);
      if (TERMINAL_PHASES.has(snapshot.phase)) {
        stopped = true;
        clearInterval(handle);
        handlers.onTerminal?.(snapshot);
      }
    } catch (err) {
      handlers.onPollError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      inFlight = false;
    }
  };
  // Immediate first tick — don't make the user wait `intervalMs` for the
  // first phase flip.
  void tick();
  const handle = setInterval(() => void tick(), intervalMs);
  return handle;
}

export function stopRemotionAiJobPolling(state: RemotionAiControllerState, jobId: string): void {
  const handle = state.remotionAiPollHandles.get(jobId);
  if (handle) {
    clearInterval(handle);
    state.remotionAiPollHandles.delete(jobId);
  }
}

export function stopAllRemotionAiPolling(state: RemotionAiControllerState): void {
  for (const handle of state.remotionAiPollHandles.values()) {
    clearInterval(handle);
  }
  state.remotionAiPollHandles.clear();
}

// ---------------------------------------------------------------------------
// Draft / validation helpers.
// ---------------------------------------------------------------------------

export function updateRemotionAiDraft(
  state: RemotionAiControllerState,
  patch: Partial<RemotionAiDraft>,
): void {
  state.remotionAiDraft = { ...state.remotionAiDraft, ...patch };
}

export type RemotionAiDraftValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "promptRequired" };

/**
 * Light client-side validation. The server re-validates everything; this
 * just lets the panel disable the submit button without a round-trip.
 *
 * outputRoot is NOT validated here because the UI no longer exposes it —
 * the server automatically routes jobs into its managed library root.
 */
export function validateRemotionAiDraft(draft: RemotionAiDraft): RemotionAiDraftValidation {
  if (draft.prompt.trim().length === 0) {
    return { ok: false, reason: "promptRequired" };
  }
  return { ok: true };
}

/** Phase classification helpers used by the view. */
export function isTerminalPhase(phase: RemotionAiPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export function isInFlightPhase(phase: RemotionAiPhase): boolean {
  return !TERMINAL_PHASES.has(phase) && phase !== "queued";
}
