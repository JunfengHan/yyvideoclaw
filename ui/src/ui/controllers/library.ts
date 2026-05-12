// Library controller.
//
// The Library tab aggregates "AI-generated local resources". M1 implements a
// single source: `remotion-ai` workspaces. Future milestones plug in more
// sources (images, videos, ComfyUI outputs, Pixelle outputs) by registering
// additional `LibrarySource` entries — the view is source-agnostic.
//
// Design notes:
//   - Keeps a flat list of `LibraryItem` objects the view renders uniformly.
//   - Each source has its own loader + optional delete verb.
//   - Loading/errors are tracked per-source so a broken source doesn't black
//     out the rest of the Library view.

import {
  deleteRemotionAiLibraryEntry,
  isLiveLibraryEntry,
  loadRemotionAiLibrary,
  type RemotionAiHttpDeps,
  type RemotionAiLibraryAnyEntryWire,
} from "./remotion-ai.ts";

// ---------------------------------------------------------------------------
// Public shape.
// ---------------------------------------------------------------------------

export type LibraryItemKind = "remotion-ai-job";

/** A normalised, source-agnostic item that the view renders. */
export type LibraryItem = {
  readonly kind: LibraryItemKind;
  /** Unique within a source; the view dedupes using `${kind}:${id}`. */
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * Absolute filesystem path (or null when the resource lives elsewhere).
   * Used for "Open in Finder" / "Copy path" affordances.
   */
  readonly workspaceDir: string | null;
  readonly live: boolean;
  readonly renderable: boolean;
  readonly sizeBytes: number | null;
  /** Extra source-specific payload the view can drill into. */
  readonly payload: { readonly kind: "remotion-ai"; readonly entry: RemotionAiLibraryAnyEntryWire };
};

export type LibrarySourceId = "remotion-ai";

export interface LibrarySourceStatus {
  readonly loading: boolean;
  readonly error: string | null;
  readonly lastLoadedAt: number | null;
  readonly libraryRoot: string | null;
  readonly entryCount: number;
}

export type LibraryFilter = {
  readonly search: string;
  readonly sourceId: LibrarySourceId | "all";
  readonly includeLive: boolean;
};

export const DEFAULT_LIBRARY_FILTER: LibraryFilter = Object.freeze({
  search: "",
  sourceId: "all",
  includeLive: true,
});

export type LibraryControllerState = {
  libraryItems: readonly LibraryItem[];
  librarySourceStatus: Readonly<Record<LibrarySourceId, LibrarySourceStatus>>;
  libraryFilter: LibraryFilter;
  /** Poll handle for the "list" endpoint while the tab is active. */
  libraryPollHandle: ReturnType<typeof setInterval> | null;
  libraryDeletingId: string | null;
};

export function defaultLibraryState(): LibraryControllerState {
  return {
    libraryItems: [],
    librarySourceStatus: { "remotion-ai": makeInitialStatus() },
    libraryFilter: DEFAULT_LIBRARY_FILTER,
    libraryPollHandle: null,
    libraryDeletingId: null,
  };
}

function makeInitialStatus(): LibrarySourceStatus {
  return {
    loading: false,
    error: null,
    lastLoadedAt: null,
    libraryRoot: null,
    entryCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Loading.
// ---------------------------------------------------------------------------

/**
 * Load all sources concurrently and merge into `libraryItems` (newest
 * first). Fills the per-source status for every known source regardless
 * of whether it succeeded.
 */
export async function loadLibrary(
  state: LibraryControllerState,
  deps: RemotionAiHttpDeps,
  now: () => number = () => Date.now(),
): Promise<void> {
  // Mark each source as loading upfront so the UI can show spinners even
  // across a long fetch.
  state.librarySourceStatus = {
    ...state.librarySourceStatus,
    "remotion-ai": {
      ...(state.librarySourceStatus["remotion-ai"] ?? makeInitialStatus()),
      loading: true,
      error: null,
    },
  };

  const remotionAiResult = await loadRemotionAiSource(deps).catch((err) => ({
    kind: "error" as const,
    error: err instanceof Error ? err.message : String(err),
  }));

  const items: LibraryItem[] = [];
  let remotionAiStatus: LibrarySourceStatus = {
    ...(state.librarySourceStatus["remotion-ai"] ?? makeInitialStatus()),
    loading: false,
  };

  if (remotionAiResult.kind === "ok") {
    items.push(...remotionAiResult.items);
    remotionAiStatus = {
      loading: false,
      error: null,
      lastLoadedAt: now(),
      libraryRoot: remotionAiResult.libraryRoot,
      entryCount: remotionAiResult.items.length,
    };
  } else {
    remotionAiStatus = {
      loading: false,
      error: remotionAiResult.error,
      lastLoadedAt: now(),
      libraryRoot: state.librarySourceStatus["remotion-ai"]?.libraryRoot ?? null,
      entryCount: state.librarySourceStatus["remotion-ai"]?.entryCount ?? 0,
    };
  }

  items.sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt);
  state.libraryItems = items;
  state.librarySourceStatus = {
    ...state.librarySourceStatus,
    "remotion-ai": remotionAiStatus,
  };
}

type LoadSourceResult =
  | { readonly kind: "ok"; readonly libraryRoot: string; readonly items: LibraryItem[] }
  | { readonly kind: "error"; readonly error: string };

async function loadRemotionAiSource(deps: RemotionAiHttpDeps): Promise<LoadSourceResult> {
  const wire = await loadRemotionAiLibrary(deps);
  const items = wire.entries.map((entry) => remotionAiEntryToItem(entry));
  return { kind: "ok", libraryRoot: wire.libraryRoot, items };
}

function remotionAiEntryToItem(entry: RemotionAiLibraryAnyEntryWire): LibraryItem {
  const title = entry.promptPreview || entry.prompt || entry.jobId;
  const subtitle = isLiveLibraryEntry(entry)
    ? `engine=${entry.engine} · phase=${entry.phase}`
    : `engine=${entry.engine}${entry.renderable ? "" : " · unrenderable"}`;
  return {
    kind: "remotion-ai-job",
    id: `remotion-ai:${entry.jobId}`,
    title,
    subtitle,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    workspaceDir: entry.workspaceDir || null,
    live: isLiveLibraryEntry(entry),
    renderable: entry.renderable === true,
    sizeBytes: entry.sizeBytes ?? null,
    payload: { kind: "remotion-ai", entry },
  };
}

// ---------------------------------------------------------------------------
// Delete.
// ---------------------------------------------------------------------------

/**
 * Delete one library item. Only `remotion-ai-job` items are deletable in
 * M1. Returns a short human-readable reason on failure so the caller can
 * surface it in a toast / inline banner.
 */
export async function deleteLibraryItem(
  state: LibraryControllerState,
  deps: RemotionAiHttpDeps,
  itemId: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const item = state.libraryItems.find((entry) => entry.id === itemId);
  if (!item) {
    return { ok: false, reason: "unknown_item" };
  }
  if (item.live) {
    return { ok: false, reason: "cancel_live_job_first" };
  }
  if (item.kind !== "remotion-ai-job") {
    return { ok: false, reason: "unsupported_kind" };
  }
  const jobId = item.payload.entry.jobId;
  state.libraryDeletingId = itemId;
  try {
    await deleteRemotionAiLibraryEntry(deps, jobId);
    state.libraryItems = state.libraryItems.filter((entry) => entry.id !== itemId);
    state.librarySourceStatus = {
      ...state.librarySourceStatus,
      "remotion-ai": {
        ...(state.librarySourceStatus["remotion-ai"] ?? makeInitialStatus()),
        entryCount: Math.max(0, (state.librarySourceStatus["remotion-ai"]?.entryCount ?? 0) - 1),
      },
    };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    state.libraryDeletingId = null;
  }
}

// ---------------------------------------------------------------------------
// Filter / view helpers.
// ---------------------------------------------------------------------------

export function updateLibraryFilter(
  state: LibraryControllerState,
  patch: Partial<LibraryFilter>,
): void {
  state.libraryFilter = { ...state.libraryFilter, ...patch };
}

export function applyLibraryFilter(
  items: readonly LibraryItem[],
  filter: LibraryFilter,
): LibraryItem[] {
  const q = filter.search.trim().toLowerCase();
  return items.filter((item) => {
    if (!filter.includeLive && item.live) {
      return false;
    }
    if (filter.sourceId !== "all" && !item.kind.startsWith(filter.sourceId)) {
      return false;
    }
    if (q.length === 0) {
      return true;
    }
    return (
      item.title.toLowerCase().includes(q) ||
      item.subtitle.toLowerCase().includes(q) ||
      (item.workspaceDir?.toLowerCase().includes(q) ?? false)
    );
  });
}

// ---------------------------------------------------------------------------
// Polling.
// ---------------------------------------------------------------------------

export type LibraryPollHandlers = {
  /** Invoked with the fully-loaded state after each successful load. */
  onLoaded?: (state: LibraryControllerState) => void;
  onError?: (err: Error) => void;
};

/**
 * Start a 10s library poll. The handle is returned so callers can stop
 * polling when the tab becomes inactive. This is deliberately simpler
 * than the per-job poller — the Library tab wants a low-frequency
 * heartbeat, not sub-second latency.
 */
export function startLibraryPolling(
  state: LibraryControllerState,
  deps: RemotionAiHttpDeps,
  handlers: LibraryPollHandlers = {},
  intervalMs = 10_000,
): ReturnType<typeof setInterval> {
  let inFlight = false;
  const tick = async () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      await loadLibrary(state, deps);
      handlers.onLoaded?.(state);
    } catch (err) {
      handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      inFlight = false;
    }
  };
  void tick();
  const handle = setInterval(() => void tick(), intervalMs);
  return handle;
}

export function stopLibraryPolling(state: LibraryControllerState): void {
  if (state.libraryPollHandle) {
    clearInterval(state.libraryPollHandle);
    state.libraryPollHandle = null;
  }
}
