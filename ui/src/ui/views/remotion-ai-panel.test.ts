/* @vitest-environment jsdom */

// View tests for the Remotion AI panel. Pure render function — assertions
// drive the DOM through the panel's `data-testid="..."` hooks so we can
// surface regressions in:
//   - the optional mounting (`undefined` state ⇒ nothing rendered)
//   - the form ↔ callbacks contract (prompt edits, submit, cancel)
//   - the phase status surface
//   - the success / failure / cancelled outcome cards
//   - the advanced / collapse toggles
//   - the i18n routing (en + zh-CN)

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import {
  DEFAULT_REMOTION_AI_DRAFT,
  type RemotionAiJobSnapshotWire,
} from "../controllers/remotion-ai.ts";
import {
  renderRemotionAiPanel,
  type RemotionAiPanelCallbacks,
  type RemotionAiPanelViewState,
} from "./remotion-ai-panel.ts";

function makeCallbacks(): RemotionAiPanelCallbacks & {
  draftPatches: Array<Partial<typeof DEFAULT_REMOTION_AI_DRAFT>>;
  submitCount: () => number;
  cancelCount: () => number;
  toggleCount: () => number;
  advancedCount: () => number;
  openLibraryCount: () => number;
  copyCalls: string[];
} {
  const draftPatches: Array<Partial<typeof DEFAULT_REMOTION_AI_DRAFT>> = [];
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const onToggleCollapsed = vi.fn();
  const onToggleAdvanced = vi.fn();
  const onOpenLibrary = vi.fn();
  const onOpenAuthModal = vi.fn();
  const copyCalls: string[] = [];
  return {
    onDraftChange: (patch) => draftPatches.push(patch),
    onSubmit,
    onCancel,
    onToggleCollapsed,
    onToggleAdvanced,
    onOpenLibrary,
    onCopyPath: (path) => copyCalls.push(path),
    onOpenAuthModal,
    // The auth modal callbacks are exercised by remotion-ai-auth-modal's
    // own tests; from the panel's perspective they're a black box.
    authModal: {
      onPickHosted: vi.fn(),
      onPickByok: vi.fn(),
      onPickByokOpenAi: vi.fn(),
      onPickByokOpenRouter: vi.fn(),
      onBackToChooser: vi.fn(),
      onClose: vi.fn(),
      onSubmitHosted: vi.fn(),
      onSubmitByokOpenAi: vi.fn(),
      onSubmitByokOpenRouter: vi.fn(),
    },
    draftPatches,
    submitCount: () => onSubmit.mock.calls.length,
    cancelCount: () => onCancel.mock.calls.length,
    toggleCount: () => onToggleCollapsed.mock.calls.length,
    advancedCount: () => onToggleAdvanced.mock.calls.length,
    openLibraryCount: () => onOpenLibrary.mock.calls.length,
    copyCalls,
  };
}

function makeState(
  overrides: Partial<RemotionAiPanelViewState> = {},
  callbacks?: RemotionAiPanelCallbacks,
): RemotionAiPanelViewState {
  return {
    draft: DEFAULT_REMOTION_AI_DRAFT,
    currentJob: null,
    submitting: false,
    submitError: null,
    cancelling: false,
    lastAgentMessage: null,
    collapsed: false,
    advancedOpen: false,
    // Defaults: fully-configured hosted account so the modal stays
    // closed and the auth gate doesn't block the panel-level tests.
    // Tests that target the modal explicitly override these.
    authStatus: {
      mode: "hosted",
      hostedUserEmail: "user@test",
      hostedRemainingCredits: 5,
    },
    authModalView: "closed",
    authPending: false,
    authError: null,
    callbacks: callbacks ?? makeCallbacks(),
    ...overrides,
  };
}

function snapshot(overrides: Partial<RemotionAiJobSnapshotWire> = {}): RemotionAiJobSnapshotWire {
  return {
    jobId: "job-1",
    phase: "agent",
    engine: "codex",
    workspaceDir: "/tmp/ai-jobs/job-1",
    enqueuedAt: 1,
    retryCount: 0,
    ...overrides,
  };
}

describe("renderRemotionAiPanel", () => {
  let host: HTMLElement;

  beforeEach(async () => {
    // i18n persists the chosen locale to localStorage; wipe it so a prior
    // test worker leaving zh-CN behind doesn't leak into this file.
    try {
      window.localStorage?.clear?.();
    } catch {
      /* ignore */
    }
    await i18n.setLocale("en");
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(async () => {
    host.remove();
    // Leave the locale at en so the singleton doesn't pollute any test
    // file that may load next in the same vitest worker.
    await i18n.setLocale("en");
    try {
      window.localStorage?.clear?.();
    } catch {
      /* ignore */
    }
  });

  it("renders nothing when state is undefined (optional mount)", () => {
    render(renderRemotionAiPanel(undefined), host);
    expect(host.querySelector('[data-testid="remotion-ai-panel"]')).toBeNull();
  });

  it("renders the form with a valid draft and enables Submit", () => {
    const state = makeState({
      draft: { ...DEFAULT_REMOTION_AI_DRAFT, prompt: "Make me a title card" },
    });
    render(renderRemotionAiPanel(state), host);
    const submit = host.querySelector<HTMLButtonElement>('[data-testid="remotion-ai-submit"]');
    expect(submit).not.toBeNull();
    expect(submit!.disabled).toBe(false);
  });

  it("does NOT render an output-directory input (server manages it)", () => {
    const state = makeState({
      draft: { ...DEFAULT_REMOTION_AI_DRAFT, prompt: "x" },
    });
    render(renderRemotionAiPanel(state), host);
    // The legacy outputRoot input is gone.
    expect(host.querySelector('[data-testid="remotion-ai-output-root"]')).toBeNull();
  });

  it("disables Submit when the prompt is empty, with a hint rather than a hard error", () => {
    const state = makeState({ draft: { ...DEFAULT_REMOTION_AI_DRAFT } });
    render(renderRemotionAiPanel(state), host);
    const submit = host.querySelector<HTMLButtonElement>('[data-testid="remotion-ai-submit"]');
    const formError = host.querySelector('[data-testid="remotion-ai-form-error"]');
    expect(submit!.disabled).toBe(true);
    expect(formError?.textContent).toContain("Please enter a prompt");
  });

  it("forwards textarea edits through onDraftChange", () => {
    const cb = makeCallbacks();
    const state = makeState({ draft: { ...DEFAULT_REMOTION_AI_DRAFT } }, cb);
    render(renderRemotionAiPanel(state), host);
    const textarea = host.querySelector<HTMLTextAreaElement>('[data-testid="remotion-ai-prompt"]')!;
    textarea.value = "Hello world";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(cb.draftPatches).toEqual([{ prompt: "Hello world" }]);
  });

  it("calls onSubmit when the Submit button is clicked", () => {
    const cb = makeCallbacks();
    const state = makeState({ draft: { ...DEFAULT_REMOTION_AI_DRAFT, prompt: "x" } }, cb);
    render(renderRemotionAiPanel(state), host);
    host.querySelector<HTMLButtonElement>('[data-testid="remotion-ai-submit"]')!.click();
    expect(cb.submitCount()).toBe(1);
  });

  it("disables Cancel when no job is in flight", () => {
    const state = makeState({
      draft: { ...DEFAULT_REMOTION_AI_DRAFT, prompt: "x" },
    });
    render(renderRemotionAiPanel(state), host);
    const cancel = host.querySelector<HTMLButtonElement>('[data-testid="remotion-ai-cancel"]');
    expect(cancel!.disabled).toBe(true);
  });

  it("enables Cancel when an in-flight job exists, fires onCancel on click", () => {
    const cb = makeCallbacks();
    const state = makeState(
      {
        draft: { ...DEFAULT_REMOTION_AI_DRAFT, prompt: "x" },
        currentJob: snapshot({ phase: "agent" }),
      },
      cb,
    );
    render(renderRemotionAiPanel(state), host);
    const cancel = host.querySelector<HTMLButtonElement>('[data-testid="remotion-ai-cancel"]');
    expect(cancel!.disabled).toBe(false);
    cancel!.click();
    expect(cb.cancelCount()).toBe(1);
  });

  it("shows the phase status and last agent message", () => {
    const state = makeState({
      draft: { ...DEFAULT_REMOTION_AI_DRAFT, prompt: "x" },
      currentJob: snapshot({ phase: "bundle", retryCount: 2 }),
      lastAgentMessage: "Generated src/Root.tsx with the Title composition.",
    });
    render(renderRemotionAiPanel(state), host);
    expect(host.querySelector('[data-testid="remotion-ai-phase"]')?.textContent).toBeTruthy();
    expect(host.querySelector('[data-testid="remotion-ai-status"]')?.textContent).toContain(
      "2 retry attempt",
    );
    expect(host.querySelector('[data-testid="remotion-ai-last-message"]')?.textContent).toContain(
      "Title composition",
    );
  });

  it("hides the advanced panel by default and toggles it via onToggleAdvanced", () => {
    const cb = makeCallbacks();
    const state = makeState({ draft: { ...DEFAULT_REMOTION_AI_DRAFT, prompt: "x" } }, cb);
    render(renderRemotionAiPanel(state), host);
    expect(host.querySelector('[data-testid="remotion-ai-advanced"]')).toBeNull();
    host.querySelector<HTMLButtonElement>('[data-testid="remotion-ai-advanced-toggle"]')!.click();
    expect(cb.advancedCount()).toBe(1);
  });

  it("renders the retryMax field ONLY when the advanced panel is open", () => {
    const state = makeState({
      draft: { ...DEFAULT_REMOTION_AI_DRAFT, prompt: "x" },
      advancedOpen: true,
    });
    render(renderRemotionAiPanel(state), host);
    expect(host.querySelector('[data-testid="remotion-ai-advanced"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="remotion-ai-retry-max"]')).not.toBeNull();
  });

  it("renders the success outcome pointing at the Library (not templateRoots)", () => {
    const cb = makeCallbacks();
    const state = makeState(
      {
        draft: { ...DEFAULT_REMOTION_AI_DRAFT, prompt: "x" },
        currentJob: snapshot({
          phase: "done",
          compositionId: "Title",
          stillPath: "/tmp/ai-jobs/job-1/.cache/still.png",
        }),
      },
      cb,
    );
    render(renderRemotionAiPanel(state), host);
    expect(host.querySelector('[data-testid="remotion-ai-outcome-success"]')).not.toBeNull();
    // Copy workspace path still works.
    host.querySelector<HTMLButtonElement>('[data-testid="remotion-ai-copy-workspace"]')!.click();
    expect(cb.copyCalls).toEqual(["/tmp/ai-jobs/job-1"]);
    // Open Library button routes through onOpenLibrary.
    host.querySelector<HTMLButtonElement>('[data-testid="remotion-ai-open-library"]')!.click();
    expect(cb.openLibraryCount()).toBe(1);
  });

  it("renders the cancelled outcome", () => {
    const state = makeState({
      draft: { ...DEFAULT_REMOTION_AI_DRAFT, prompt: "x" },
      currentJob: snapshot({ phase: "cancelled" }),
    });
    render(renderRemotionAiPanel(state), host);
    expect(host.querySelector('[data-testid="remotion-ai-outcome-cancelled"]')).not.toBeNull();
  });

  it("renders the failed outcome with the error message", () => {
    const state = makeState({
      draft: { ...DEFAULT_REMOTION_AI_DRAFT, prompt: "x" },
      currentJob: snapshot({
        phase: "failed",
        error: "Bundle failed: ENOENT src/Root.tsx",
      }),
    });
    render(renderRemotionAiPanel(state), host);
    expect(host.querySelector('[data-testid="remotion-ai-outcome-failed"]')?.textContent).toContain(
      "ENOENT src/Root.tsx",
    );
  });

  it("renders the submit-level error banner when submitError is set", () => {
    const state = makeState({
      draft: { ...DEFAULT_REMOTION_AI_DRAFT, prompt: "x" },
      submitError: "401 Unauthorized",
    });
    render(renderRemotionAiPanel(state), host);
    expect(host.querySelector('[data-testid="remotion-ai-submit-error"]')?.textContent).toContain(
      "401 Unauthorized",
    );
  });

  it("hides the body when collapsed and fires onToggleCollapsed", () => {
    const cb = makeCallbacks();
    const state = makeState(
      {
        draft: { ...DEFAULT_REMOTION_AI_DRAFT, prompt: "x" },
        collapsed: true,
      },
      cb,
    );
    render(renderRemotionAiPanel(state), host);
    expect(host.querySelector('[data-testid="remotion-ai-prompt"]')).toBeNull();
    host.querySelector<HTMLButtonElement>('[data-testid="remotion-ai-panel-toggle"]')!.click();
    expect(cb.toggleCount()).toBe(1);
  });

  it("uses zh-CN translations when the locale is zh-CN", async () => {
    await i18n.setLocale("zh-CN");
    const state = makeState({
      draft: { ...DEFAULT_REMOTION_AI_DRAFT, prompt: "x" },
      currentJob: snapshot({ phase: "agent" }),
    });
    render(renderRemotionAiPanel(state), host);
    expect(host.querySelector('[data-testid="remotion-ai-panel-title"]')?.textContent).toContain(
      "AI 创作",
    );
  });
});
