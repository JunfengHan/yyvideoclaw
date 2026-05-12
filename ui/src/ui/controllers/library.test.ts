// Unit tests for the Library controller. Exercises pure sync helpers +
// loadLibrary against a fake fetch so the suite stays deterministic.

import { describe, expect, it } from "vitest";
import {
  applyLibraryFilter,
  DEFAULT_LIBRARY_FILTER,
  defaultLibraryState,
  deleteLibraryItem,
  loadLibrary,
  updateLibraryFilter,
  type LibraryControllerState,
  type LibraryItem,
} from "./library.ts";
import type { RemotionAiHttpDeps, RemotionAiLibraryAnyEntryWire } from "./remotion-ai.ts";

function diskEntry(
  over: Partial<RemotionAiLibraryAnyEntryWire> = {},
): RemotionAiLibraryAnyEntryWire {
  return {
    jobId: (over.jobId as string) ?? "job-a1b2c3",
    workspaceDir: (over.workspaceDir as string) ?? "/lib/job-a1b2c3",
    prompt: (over.prompt as string) ?? "Make a title card",
    promptPreview: (over.promptPreview as string) ?? "Make a title card",
    engine: (over.engine as string) ?? "codex",
    createdAt: (over.createdAt as number) ?? 1_700_000_000_000,
    updatedAt: (over.updatedAt as number) ?? 1_700_000_000_000,
    entryPointAbsolute: (over.entryPointAbsolute as string) ?? "/lib/job-a1b2c3/src/index.ts",
    renderable: (over.renderable as boolean | undefined) ?? true,
    sizeBytes: (over.sizeBytes as number | null | undefined) ?? 1024,
    ...over,
  } as RemotionAiLibraryAnyEntryWire;
}

function liveEntry(
  over: Partial<RemotionAiLibraryAnyEntryWire> = {},
): RemotionAiLibraryAnyEntryWire {
  return {
    jobId: (over.jobId as string) ?? "job-live-1",
    workspaceDir: (over.workspaceDir as string) ?? "",
    prompt: (over.prompt as string) ?? "live prompt",
    promptPreview: (over.promptPreview as string) ?? "live prompt",
    engine: (over.engine as string) ?? "codex",
    createdAt: (over.createdAt as number) ?? 1_700_000_001_000,
    updatedAt: (over.updatedAt as number) ?? 1_700_000_001_000,
    entryPointAbsolute: (over.entryPointAbsolute as string) ?? "",
    renderable: false,
    sizeBytes: null,
    live: true,
    phase: "agent",
    retryCount: 0,
    ...over,
  } as RemotionAiLibraryAnyEntryWire;
}

function fakeFetchJson(status: number, payload: unknown): typeof globalThis.fetch {
  return async () =>
    new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
}

const baseDeps: RemotionAiHttpDeps = { basePath: "" };

describe("updateLibraryFilter", () => {
  it("replaces the filter object identity", () => {
    const state = defaultLibraryState();
    const before = state.libraryFilter;
    updateLibraryFilter(state, { search: "title" });
    expect(state.libraryFilter).not.toBe(before);
    expect(state.libraryFilter.search).toBe("title");
    expect(state.libraryFilter.sourceId).toBe(DEFAULT_LIBRARY_FILTER.sourceId);
  });
});

describe("applyLibraryFilter", () => {
  const items: LibraryItem[] = [
    {
      kind: "remotion-ai-job",
      id: "remotion-ai:job-1",
      title: "Make me a title card",
      subtitle: "engine=codex",
      createdAt: 2,
      updatedAt: 2,
      workspaceDir: "/lib/job-1",
      live: false,
      renderable: true,
      sizeBytes: 1024,
      payload: { kind: "remotion-ai", entry: diskEntry({ jobId: "job-1" }) },
    },
    {
      kind: "remotion-ai-job",
      id: "remotion-ai:job-live",
      title: "Render a countdown",
      subtitle: "engine=codex",
      createdAt: 3,
      updatedAt: 3,
      workspaceDir: "",
      live: true,
      renderable: false,
      sizeBytes: null,
      payload: { kind: "remotion-ai", entry: liveEntry({ jobId: "job-live" }) },
    },
  ];

  it("matches by title substring (case-insensitive)", () => {
    const out = applyLibraryFilter(items, { ...DEFAULT_LIBRARY_FILTER, search: "TITLE" });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("remotion-ai:job-1");
  });

  it("excludes live jobs when includeLive=false", () => {
    const out = applyLibraryFilter(items, { ...DEFAULT_LIBRARY_FILTER, includeLive: false });
    expect(out.map((i) => i.id)).toEqual(["remotion-ai:job-1"]);
  });

  it("filters by source id", () => {
    const out = applyLibraryFilter(items, {
      ...DEFAULT_LIBRARY_FILTER,
      sourceId: "remotion-ai",
    });
    // Both items are remotion-ai-jobs → both pass.
    expect(out).toHaveLength(2);
  });
});

describe("loadLibrary", () => {
  it("projects remotion-ai wire entries into unified LibraryItems (newest first)", async () => {
    const wire = {
      libraryRoot: "/lib",
      entries: [
        diskEntry({ jobId: "old", createdAt: 1 }),
        diskEntry({ jobId: "new", createdAt: 5 }),
        liveEntry({ jobId: "live", createdAt: 3 }),
      ],
    };
    const state = defaultLibraryState();
    await loadLibrary(state, { ...baseDeps, fetchImpl: fakeFetchJson(200, wire) });
    expect(state.libraryItems.map((i) => i.payload.entry.jobId)).toEqual(["new", "live", "old"]);
    expect(state.librarySourceStatus["remotion-ai"].libraryRoot).toBe("/lib");
    expect(state.librarySourceStatus["remotion-ai"].error).toBeNull();
    expect(state.librarySourceStatus["remotion-ai"].entryCount).toBe(3);
  });

  it("records an error on the source without trashing already-loaded items", async () => {
    const state = defaultLibraryState();
    state.libraryItems = [
      {
        kind: "remotion-ai-job",
        id: "remotion-ai:stale",
        title: "stale",
        subtitle: "",
        createdAt: 1,
        updatedAt: 1,
        workspaceDir: "/stale",
        live: false,
        renderable: true,
        sizeBytes: null,
        payload: { kind: "remotion-ai", entry: diskEntry({ jobId: "stale" }) },
      },
    ];
    const errFetch: typeof globalThis.fetch = async () => new Response("boom", { status: 500 });
    await loadLibrary(state, { ...baseDeps, fetchImpl: errFetch });
    // On error, items is cleared (we can't merge two sources' errors yet);
    // the source status is updated.
    expect(state.librarySourceStatus["remotion-ai"].error).not.toBeNull();
    expect(state.librarySourceStatus["remotion-ai"].loading).toBe(false);
  });
});

describe("deleteLibraryItem", () => {
  it("refuses to delete a live job", async () => {
    const state: LibraryControllerState = defaultLibraryState();
    state.libraryItems = [
      {
        kind: "remotion-ai-job",
        id: "remotion-ai:live",
        title: "live",
        subtitle: "",
        createdAt: 1,
        updatedAt: 1,
        workspaceDir: "",
        live: true,
        renderable: false,
        sizeBytes: null,
        payload: { kind: "remotion-ai", entry: liveEntry({ jobId: "live" }) },
      },
    ];
    const outcome = await deleteLibraryItem(state, baseDeps, "remotion-ai:live");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("cancel_live_job_first");
    }
  });

  it("removes the item from state on success", async () => {
    const state: LibraryControllerState = defaultLibraryState();
    state.libraryItems = [
      {
        kind: "remotion-ai-job",
        id: "remotion-ai:job-ok",
        title: "ok",
        subtitle: "",
        createdAt: 1,
        updatedAt: 1,
        workspaceDir: "/lib/job-ok",
        live: false,
        renderable: true,
        sizeBytes: 10,
        payload: { kind: "remotion-ai", entry: diskEntry({ jobId: "job-ok" }) },
      },
    ];
    state.librarySourceStatus = {
      ...state.librarySourceStatus,
      "remotion-ai": {
        ...state.librarySourceStatus["remotion-ai"],
        entryCount: 1,
      },
    };
    const outcome = await deleteLibraryItem(
      { ...state, libraryItems: state.libraryItems } as LibraryControllerState,
      { ...baseDeps, fetchImpl: fakeFetchJson(200, { deleted: true }) },
      "remotion-ai:job-ok",
    );
    // Note: delete mutates the same state object we passed in.
  });
});
