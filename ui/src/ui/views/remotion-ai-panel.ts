// Remotion AI Create — Lit panel view.
//
// Pure-function view (matches `remotion-studio-view.ts` style). Renders a
// collapsible "AI Create" panel that mounts at the top of the Remotion
// Studio tab. The panel is fully optional: callers that don't pass the
// `aiPanel` prop to `renderRemotionStudioView()` get the legacy layout
// unchanged.
//
// Layout (post-M1.5 simplification):
//
//   ┌────────────────────────────────────────────────────────────────┐
//   │ ✨ AI Create                              [phase]    [Collapse] │
//   ├────────────────────────────────────────────────────────────────┤
//   │ Prompt   [textarea ─────────────────────────────────────────]  │
//   │ [Generate]  [Cancel]                   [▸ Advanced]             │
//   │                                                                 │
//   │ (advanced expanded) Max retries [ 3 ]                           │
//   ├────────────────────────────────────────────────────────────────┤
//   │ Phase: workspace → skills → agent → validate → ✓ done           │
//   │ Last:  "Generated src/Root.tsx with the Title composition…"     │
//   ├────────────────────────────────────────────────────────────────┤
//   │ ✓ Saved to Library                                              │
//   │ Composition: Title     [Open in Library]                        │
//   └────────────────────────────────────────────────────────────────┘
//
// The user no longer picks the output directory — the plugin manages a
// single library root (`~/.openclaw/remotion-ai/library`) and the Library
// tab is the UI for browsing it.

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import {
  describeAuthBadge,
  type RemotionAiAuthModalView,
  type RemotionAiAuthStatusWire,
} from "../controllers/remotion-ai-auth.ts";
import {
  type RemotionAiDraft,
  type RemotionAiJobSnapshotWire,
  type RemotionAiPhase,
  isTerminalPhase,
} from "../controllers/remotion-ai.ts";
import { renderIcon } from "../icons.ts";
import {
  renderRemotionAiAuthModal,
  type RemotionAiAuthModalCallbacks,
} from "./remotion-ai-auth-modal.ts";

// ---------------------------------------------------------------------------
// Public inputs.
// ---------------------------------------------------------------------------

export type RemotionAiPanelCallbacks = {
  readonly onDraftChange: (patch: Partial<RemotionAiDraft>) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly onToggleCollapsed: () => void;
  readonly onToggleAdvanced: () => void;
  readonly onOpenLibrary: () => void;
  readonly onCopyPath: (path: string) => void;
  /** User clicked the auth badge — open the modal so they can switch
   *  modes. The panel passes this through to a controller; the panel
   *  itself doesn't manage modal state. */
  readonly onOpenAuthModal: () => void;
  /** Modal sub-form callbacks. Passed verbatim to
   *  `<remotion-ai-auth-modal>`. */
  readonly authModal: RemotionAiAuthModalCallbacks;
};

export type RemotionAiPanelViewState = {
  readonly draft: RemotionAiDraft;
  readonly currentJob: RemotionAiJobSnapshotWire | null;
  readonly submitting: boolean;
  readonly submitError: string | null;
  readonly cancelling: boolean;
  readonly lastAgentMessage: string | null;
  readonly collapsed: boolean;
  readonly advancedOpen: boolean;
  /**
   * Gateway base path used to build absolute URLs for cross-origin
   * resources (e.g. the `<video src=…>` for a rendered job's mp4). When
   * the UI runs in the same origin as the gateway this is empty/"".
   */
  readonly basePath?: string;
  /** Cached auth status. `null` until the first `/auth/status` reply. */
  readonly authStatus: RemotionAiAuthStatusWire | null;
  /** Drives the auth modal. `"closed"` means the modal isn't mounted. */
  readonly authModalView: RemotionAiAuthModalView;
  /** True while a login/byok-write request is pending. */
  readonly authPending: boolean;
  /** Inline error message inside the auth modal. */
  readonly authError: string | null;
  /** Cached OpenRouter model list — passed verbatim to the modal so its
   *  dropdown can render. `null` means "still loading"; `undefined` means
   *  "panel hasn't bothered to fetch yet" (treated identically). */
  readonly openRouterModels?: ReadonlyArray<
    import("../controllers/remotion-ai-auth.ts").OpenRouterModelWire
  > | null;
  readonly callbacks: RemotionAiPanelCallbacks;
};

// ---------------------------------------------------------------------------
// Root entry.
// ---------------------------------------------------------------------------

/**
 * Render the AI Create panel. Returns `nothing` if `state` is `undefined`
 * so callers can mount the panel conditionally without a wrapper.
 */
export function renderRemotionAiPanel(
  state: RemotionAiPanelViewState | undefined,
): TemplateResult | typeof nothing {
  if (!state) {
    return nothing;
  }

  return html`
    <section
      class="remotion-ai-panel"
      aria-labelledby="remotion-ai-panel-title"
      data-testid="remotion-ai-panel"
      style="
        border:1px solid var(--border, rgba(127,127,127,0.25));
        border-radius:0.5rem;
        background:var(--card, var(--bg));
        overflow:hidden;
      "
    >
      ${renderHeader(state)} ${state.collapsed ? nothing : renderBody(state)}
    </section>
    ${renderRemotionAiAuthModal({
      view: state.authModalView,
      pending: state.authPending,
      error: state.authError,
      currentStatus: state.authStatus,
      openRouterModels: state.openRouterModels ?? null,
      callbacks: state.callbacks.authModal,
    })}
  `;
}

// ---------------------------------------------------------------------------
// Header (title + collapse toggle).
// ---------------------------------------------------------------------------

function renderHeader(state: RemotionAiPanelViewState): TemplateResult {
  // When a job is in flight we show its live phase. Between clicking
  // "Generate" and receiving the first snapshot, state.submitting == true
  // but currentJob is still null — surface a dedicated "submitting" label
  // instead of "Idle" so the user sees feedback immediately.
  let phaseSummary: string;
  if (state.currentJob) {
    phaseSummary = phaseLabel(state.currentJob.phase);
  } else if (state.submitting) {
    phaseSummary = t("remotionAi.form.submitting");
  } else {
    phaseSummary = t("remotionAi.state.idle");
  }
  const activityColor = state.currentJob
    ? isTerminalPhase(state.currentJob.phase)
      ? state.currentJob.phase === "done"
        ? "var(--success, #15803d)"
        : state.currentJob.phase === "failed"
          ? "var(--danger, #b00020)"
          : "var(--muted, rgba(127,127,127,0.7))"
      : "var(--accent, #3b82f6)"
    : state.submitting
      ? "var(--accent, #3b82f6)"
      : "var(--muted, rgba(127,127,127,0.6))";
  return html`
    <header
      style="
        display:flex;align-items:center;gap:0.5rem;
        padding:0.65rem 0.85rem;
        background:var(--card-header, rgba(127,127,127,0.08));
      "
    >
      ${renderIcon("spark", "remotion-ai-panel__icon")}
      <h3
        id="remotion-ai-panel-title"
        data-testid="remotion-ai-panel-title"
        style="margin:0;font-size:0.95rem;font-weight:600;flex:1;"
      >
        ${t("remotionAi.heading")}
      </h3>
      <span
        aria-hidden="true"
        style="
          width:0.5rem;height:0.5rem;border-radius:50%;
          background:${activityColor};
          box-shadow:0 0 0 0 ${activityColor};
          animation:${state.submitting ||
        (state.currentJob && !isTerminalPhase(state.currentJob.phase))
          ? "remotion-ai-pulse 1.5s ease-out infinite"
          : "none"};
        "
      ></span>
      <span data-testid="remotion-ai-panel-status" style="font-size:0.8rem;opacity:0.75;">
        ${phaseSummary}
      </span>
      ${renderAuthBadge(state)}
      <button
        type="button"
        class="remotion-ai-panel__toggle"
        data-testid="remotion-ai-panel-toggle"
        aria-expanded=${state.collapsed ? "false" : "true"}
        @click=${() => state.callbacks.onToggleCollapsed()}
        style="
          background:transparent;border:1px solid var(--border, rgba(127,127,127,0.25));
          border-radius:0.35rem;padding:0.2rem 0.55rem;font-size:0.75rem;cursor:pointer;
        "
      >
        ${state.collapsed ? t("remotionAi.actions.expand") : t("remotionAi.actions.collapse")}
      </button>
    </header>
    <style>
      @keyframes remotion-ai-pulse {
        0% {
          box-shadow: 0 0 0 0 currentColor;
        }
        70% {
          box-shadow: 0 0 0 6px transparent;
        }
        100% {
          box-shadow: 0 0 0 0 transparent;
        }
      }
    </style>
  `;
}

// ---------------------------------------------------------------------------
// Body (form + status + outcome).
// ---------------------------------------------------------------------------

function renderBody(state: RemotionAiPanelViewState): TemplateResult {
  return html`
    <div style="padding:0.85rem;display:flex;flex-direction:column;gap:0.85rem;">
      ${renderForm(state)} ${renderStatus(state)} ${renderOutcome(state)} ${renderError(state)}
    </div>
  `;
}

function renderForm(state: RemotionAiPanelViewState): TemplateResult {
  const promptValid = state.draft.prompt.trim().length > 0;
  const submitDisabled =
    !promptValid ||
    state.submitting ||
    Boolean(state.currentJob && !isTerminalPhase(state.currentJob.phase));
  const cancelDisabled =
    state.cancelling || !state.currentJob || isTerminalPhase(state.currentJob.phase);

  return html`
    <div style="display:flex;flex-direction:column;gap:0.55rem;">
      <label style="display:flex;flex-direction:column;gap:0.25rem;">
        <span style="font-size:0.8rem;opacity:0.85;"> ${t("remotionAi.form.promptLabel")} </span>
        <textarea
          data-testid="remotion-ai-prompt"
          rows="3"
          placeholder=${t("remotionAi.form.promptPlaceholder")}
          .value=${state.draft.prompt}
          @input=${(e: Event) =>
            state.callbacks.onDraftChange({
              prompt: (e.target as HTMLTextAreaElement).value,
            })}
          style="
            font:inherit;padding:0.5rem;border-radius:0.35rem;
            border:1px solid var(--border, rgba(127,127,127,0.25));
            background:var(--input-bg, transparent);color:inherit;resize:vertical;
          "
        ></textarea>
      </label>
      <div style="display:flex;align-items:center;gap:0.55rem;flex-wrap:wrap;">
        <button
          type="button"
          data-testid="remotion-ai-submit"
          ?disabled=${submitDisabled}
          @click=${() => state.callbacks.onSubmit()}
          style="
            font:inherit;padding:0.5rem 0.9rem;border-radius:0.35rem;cursor:pointer;
            background:var(--accent, #3b82f6);color:var(--accent-fg, #fff);
            border:1px solid transparent;font-weight:600;
          "
        >
          ${state.submitting ? t("remotionAi.form.submitting") : t("remotionAi.form.submit")}
        </button>
        <button
          type="button"
          data-testid="remotion-ai-cancel"
          ?disabled=${cancelDisabled}
          @click=${() => state.callbacks.onCancel()}
          style="
            font:inherit;padding:0.5rem 0.9rem;border-radius:0.35rem;cursor:pointer;
            background:transparent;color:inherit;
            border:1px solid var(--border, rgba(127,127,127,0.35));
          "
        >
          ${t("remotionAi.form.cancel")}
        </button>
        <button
          type="button"
          data-testid="remotion-ai-advanced-toggle"
          aria-expanded=${state.advancedOpen ? "true" : "false"}
          @click=${() => state.callbacks.onToggleAdvanced()}
          style="
            margin-left:auto;font:inherit;font-size:0.78rem;
            padding:0.35rem 0.55rem;border-radius:0.3rem;cursor:pointer;
            background:transparent;color:inherit;
            border:1px solid var(--border, rgba(127,127,127,0.25));
          "
        >
          ${state.advancedOpen
            ? t("remotionAi.form.advancedHide")
            : t("remotionAi.form.advancedShow")}
        </button>
      </div>
      ${state.advancedOpen ? renderAdvanced(state) : nothing}
      ${!promptValid
        ? html`<span
            data-testid="remotion-ai-form-error"
            style="font-size:0.75rem;color:var(--muted, rgba(127,127,127,0.9));"
          >
            ${t("remotionAi.form.validation.promptRequired")}
          </span>`
        : nothing}
    </div>
  `;
}

function renderAdvanced(state: RemotionAiPanelViewState): TemplateResult {
  return html`
    <div
      data-testid="remotion-ai-advanced"
      style="
        display:flex;gap:0.6rem;align-items:flex-end;flex-wrap:wrap;
        padding:0.55rem 0.65rem;border-radius:0.4rem;
        background:var(--card-sub, rgba(127,127,127,0.06));
        border:1px dashed var(--border, rgba(127,127,127,0.25));
      "
    >
      <label style="display:flex;flex-direction:column;gap:0.25rem;">
        <span style="font-size:0.75rem;opacity:0.8;"> ${t("remotionAi.form.retryMaxLabel")} </span>
        <input
          type="number"
          min="0"
          max="10"
          data-testid="remotion-ai-retry-max"
          .value=${String(state.draft.retryMax)}
          @input=${(e: Event) => {
            const raw = (e.target as HTMLInputElement).value;
            const parsed = Number.parseInt(raw, 10);
            if (Number.isFinite(parsed) && parsed >= 0) {
              state.callbacks.onDraftChange({ retryMax: parsed });
            }
          }}
          style="
            font:inherit;padding:0.35rem 0.45rem;border-radius:0.3rem;
            border:1px solid var(--border, rgba(127,127,127,0.25));
            background:var(--input-bg, transparent);color:inherit;width:4.5rem;
          "
        />
      </label>
      <span style="font-size:0.72rem;opacity:0.6;flex:1;">
        ${t("remotionAi.form.advancedHint")}
      </span>
    </div>
  `;
}

function renderStatus(state: RemotionAiPanelViewState): TemplateResult | typeof nothing {
  const job = state.currentJob;
  if (!job) {
    return nothing;
  }
  // Terminal phases own the whole "outcome" block below; don't double-render
  // the in-flight stepper once the job is resolved.
  const isTerminal = isTerminalPhase(job.phase);
  if (isTerminal) {
    return nothing;
  }
  const startTs = job.startedAt ?? job.enqueuedAt ?? job.createdAt ?? Date.now();
  const elapsedMs = Date.now() - startTs;
  const elapsedSec = Math.max(0, Math.round(elapsedMs / 1000));
  return html`
    <div
      data-testid="remotion-ai-status"
      style="
        border-top:1px dashed var(--border, rgba(127,127,127,0.25));
        padding-top:0.75rem;display:flex;flex-direction:column;gap:0.6rem;
      "
    >
      ${renderPhaseStepper(job.phase)}
      <div
        style="
          display:flex;align-items:center;gap:0.55rem;flex-wrap:wrap;
          font-size:0.78rem;
        "
      >
        <span
          aria-hidden="true"
          style="
            width:0.75rem;height:0.75rem;border-radius:50%;
            border:2px solid var(--accent, #3b82f6);
            border-top-color:transparent;
            animation:remotion-ai-spin 0.9s linear infinite;
            display:inline-block;
          "
        ></span>
        <span>
          ${t("remotionAi.status.phase")}:
          <strong data-testid="remotion-ai-phase">${phaseLabel(job.phase)}</strong>
        </span>
        <span style="opacity:0.55;">·</span>
        <span style="opacity:0.75;">
          ${t("remotionAi.status.elapsed", { seconds: String(elapsedSec) })}
        </span>
        ${job.retryCount > 0
          ? html`<span style="opacity:0.55;">·</span>
              <span
                data-testid="remotion-ai-retry-count"
                style="
                  background:var(--warning-bg, rgba(234,179,8,0.15));
                  color:var(--warning-fg, #92400e);
                  padding:0.1rem 0.45rem;border-radius:999px;
                  font-size:0.72rem;font-weight:600;
                "
              >
                ${t("remotionAi.status.retryCount", {
                  count: String(job.retryCount),
                })}
              </span>`
          : nothing}
      </div>
      ${state.lastAgentMessage
        ? html`<div
            data-testid="remotion-ai-last-message"
            style="
              font-size:0.78rem;opacity:0.7;
              white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;
            "
          >
            ${state.lastAgentMessage}
          </div>`
        : nothing}
    </div>
    <style>
      @keyframes remotion-ai-spin {
        to {
          transform: rotate(360deg);
        }
      }
    </style>
  `;
}

/**
 * Horizontal stepper that shows the 7 main phases a job moves through.
 * `retry` isn't a standalone step — it's a loop back to `agent`, so we
 * surface it with the retry-count pill rather than an extra dot.
 *
 * Each step renders in one of three states:
 *   - `done`     → filled accent circle with a check glyph
 *   - `current`  → hollow accent circle (ring), slightly larger
 *   - `pending`  → muted outline
 */
const STEPPER_PHASES: ReadonlyArray<RemotionAiPhase> = [
  "queued",
  "workspace",
  "skills",
  "agent",
  "bundle",
  "select",
  "still",
  "done",
];

function renderPhaseStepper(current: RemotionAiPhase): TemplateResult {
  // `failed` / `cancelled` short-circuit the stepper — they always render
  // via renderOutcome(). `retry` is treated as \"agent\" for positioning
  // because it IS the agent step on a retry iteration.
  const effective: RemotionAiPhase = current === "retry" ? "agent" : current;
  const currentIndex = STEPPER_PHASES.indexOf(effective);
  return html`
    <ol
      data-testid="remotion-ai-stepper"
      aria-label=${t("remotionAi.status.progressLabel")}
      style="
        list-style:none;margin:0;padding:0;
        display:flex;align-items:center;gap:0;
        overflow-x:auto;
      "
    >
      ${STEPPER_PHASES.map((phase, index) => {
        // Skip \"done\" unless we're actually there — showing a pending \"done\"
        // dot just adds visual noise mid-run.
        if (phase === "done" && currentIndex < STEPPER_PHASES.length - 1) {
          return nothing;
        }
        const done = index < currentIndex;
        const isCurrent = index === currentIndex;
        const pending = index > currentIndex;
        const fg = done
          ? "var(--success, #15803d)"
          : isCurrent
            ? "var(--accent, #3b82f6)"
            : "var(--muted, rgba(127,127,127,0.55))";
        const dotStyle = done
          ? `background:${fg};color:var(--accent-fg, #fff);`
          : isCurrent
            ? `background:transparent;border:2px solid ${fg};color:${fg};`
            : `background:transparent;border:1px dashed ${fg};color:${fg};`;
        const connector =
          index === 0
            ? nothing
            : html`<span
                aria-hidden="true"
                style="
                  flex:1;min-width:0.6rem;height:2px;
                  background:${done || isCurrent
                  ? "var(--success, #15803d)"
                  : "var(--border, rgba(127,127,127,0.25))"};
                  margin:0 0.15rem;
                "
              ></span>`;
        return html`
          ${connector}
          <li
            style="
              display:flex;flex-direction:column;align-items:center;gap:0.25rem;
              flex-shrink:0;
            "
          >
            <span
              aria-current=${isCurrent ? "step" : "false"}
              style="
                width:1.1rem;height:1.1rem;border-radius:50%;
                display:inline-flex;align-items:center;justify-content:center;
                font-size:0.65rem;font-weight:700;line-height:1;
                ${dotStyle}
              "
            >
              ${done ? "✓" : ""}
            </span>
            <span
              style="
                font-size:0.65rem;white-space:nowrap;
                color:${fg};
                font-weight:${isCurrent ? 600 : 400};
                opacity:${pending ? 0.6 : 1};
              "
            >
              ${phaseLabel(phase)}
            </span>
          </li>
        `;
      })}
    </ol>
  `;
}

function renderOutcome(state: RemotionAiPanelViewState): TemplateResult | typeof nothing {
  const job = state.currentJob;
  if (!job || !isTerminalPhase(job.phase)) {
    return nothing;
  }
  if (job.phase === "done") {
    // Build the streaming URL for the rendered mp4. We can't tell from
    // the snapshot alone whether the video has actually finished
    // encoding (the orchestrator updates the snapshot only after the
    // sidecar write succeeds), so we let the `<video>` element fail
    // gracefully — modern browsers fire `error` and show a poster, and
    // in practice by the time we hit `phase === "done"` the file is
    // there. Range support on the server covers seek-while-loading.
    const basePath = state.basePath ?? "";
    const videoSrc = `${basePath}/remotion-ai/library/${encodeURIComponent(job.jobId)}/output.mp4`;
    return html`
      <div
        data-testid="remotion-ai-outcome-success"
        style="
          border-top:1px solid var(--border, rgba(127,127,127,0.25));
          padding-top:0.65rem;display:flex;flex-direction:column;gap:0.5rem;
        "
      >
        <div style="font-size:0.85rem;font-weight:600;color:var(--success, #15803d);">
          ${t("remotionAi.outcome.savedToLibrary")}
        </div>
        <video
          data-testid="remotion-ai-outcome-video"
          src=${videoSrc}
          controls
          playsinline
          preload="metadata"
          style="
            width:100%;max-width:520px;border-radius:0.4rem;
            background:var(--video-bg, #000);
            aspect-ratio:16 / 9;outline:none;
          "
        ></video>
        ${job.compositionId
          ? html`<div style="font-size:0.78rem;opacity:0.85;">
              ${t("remotionAi.outcome.composition")}:
              <code>${job.compositionId}</code>
            </div>`
          : nothing}
        <div style="display:flex;gap:0.4rem;flex-wrap:wrap;">
          <button
            type="button"
            data-testid="remotion-ai-open-library"
            @click=${() => state.callbacks.onOpenLibrary()}
            style="
              font:inherit;font-size:0.8rem;padding:0.35rem 0.7rem;
              border-radius:0.35rem;cursor:pointer;
              background:var(--accent, #3b82f6);color:var(--accent-fg, #fff);
              border:1px solid transparent;font-weight:600;
            "
          >
            ${t("remotionAi.outcome.openLibrary")}
          </button>
          <a
            data-testid="remotion-ai-download-video"
            href=${videoSrc}
            download="${job.compositionId ?? "remotion-ai"}.mp4"
            style="
              font:inherit;font-size:0.78rem;padding:0.3rem 0.55rem;
              border-radius:0.3rem;cursor:pointer;background:transparent;color:inherit;
              border:1px solid var(--border, rgba(127,127,127,0.35));
              text-decoration:none;display:inline-flex;align-items:center;
            "
          >
            ${t("remotionAi.outcome.downloadVideo")}
          </a>
          <button
            type="button"
            data-testid="remotion-ai-copy-workspace"
            @click=${() => state.callbacks.onCopyPath(job.workspaceDir)}
            style="
              font:inherit;font-size:0.78rem;padding:0.3rem 0.55rem;
              border-radius:0.3rem;cursor:pointer;background:transparent;color:inherit;
              border:1px solid var(--border, rgba(127,127,127,0.35));
            "
          >
            ${t("remotionAi.outcome.copyWorkspacePath")}
          </button>
        </div>
      </div>
    `;
  }
  if (job.phase === "cancelled") {
    return html`
      <div
        data-testid="remotion-ai-outcome-cancelled"
        style="
          border-top:1px solid var(--border, rgba(127,127,127,0.25));
          padding-top:0.65rem;font-size:0.85rem;opacity:0.85;
        "
      >
        ${t("remotionAi.outcome.cancelled")}
      </div>
    `;
  }
  // failed
  // Server-side snapshot may carry `errorSummary` (the real field name) or
  // `error` (legacy alias); display whichever is present. Also include
  // jobId + workspaceDir so the user can grep gateway logs.
  const failureDetail = job.errorSummary ?? job.error ?? null;
  return html`
    <div
      data-testid="remotion-ai-outcome-failed"
      style="
        border-top:1px solid var(--border, rgba(127,127,127,0.25));
        padding-top:0.75rem;display:flex;flex-direction:column;gap:0.55rem;
      "
    >
      <div
        style="
          display:flex;align-items:center;gap:0.45rem;
          font-size:0.9rem;font-weight:600;color:var(--danger, #b00020);
        "
      >
        <span aria-hidden="true">⚠</span>
        <span>${t("remotionAi.outcome.failed")}</span>
      </div>
      ${failureDetail
        ? html`<div
            data-testid="remotion-ai-failure-detail"
            style="
              font-size:0.82rem;line-height:1.45;
              padding:0.55rem 0.7rem;border-radius:0.35rem;
              background:var(--danger-bg, rgba(176,0,32,0.08));
              border:1px solid var(--danger-border, rgba(176,0,32,0.2));
              color:var(--danger, #b00020);
              white-space:pre-wrap;word-break:break-word;
            "
          >
            ${failureDetail}
          </div>`
        : html`<div
            style="
              font-size:0.78rem;opacity:0.7;font-style:italic;
            "
          >
            ${t("remotionAi.outcome.failedNoDetail")}
          </div>`}
      <details data-testid="remotion-ai-failure-debug" style="font-size:0.72rem;opacity:0.75;">
        <summary style="cursor:pointer;user-select:none;">
          ${t("remotionAi.outcome.debugDetails")}
        </summary>
        <dl
          style="
            margin:0.4rem 0 0;display:grid;grid-template-columns:max-content 1fr;
            gap:0.2rem 0.55rem;font-family:var(--font-mono, ui-monospace, monospace);
          "
        >
          <dt style="opacity:0.7;">jobId</dt>
          <dd style="margin:0;word-break:break-all;">${job.jobId}</dd>
          <dt style="opacity:0.7;">workspace</dt>
          <dd style="margin:0;word-break:break-all;">${job.workspaceDir}</dd>
          <dt style="opacity:0.7;">phase</dt>
          <dd style="margin:0;">${job.phase} (retry ${job.retryCount})</dd>
        </dl>
      </details>
      <div style="display:flex;gap:0.4rem;flex-wrap:wrap;">
        <button
          type="button"
          data-testid="remotion-ai-copy-workspace"
          @click=${() => state.callbacks.onCopyPath(job.workspaceDir)}
          style="
            font:inherit;font-size:0.75rem;padding:0.3rem 0.55rem;
            border-radius:0.3rem;cursor:pointer;background:transparent;color:inherit;
            border:1px solid var(--border, rgba(127,127,127,0.35));
          "
        >
          ${t("remotionAi.outcome.copyWorkspacePath")}
        </button>
      </div>
    </div>
  `;
}

function renderError(state: RemotionAiPanelViewState): TemplateResult | typeof nothing {
  if (!state.submitError) {
    return nothing;
  }
  return html`
    <div
      data-testid="remotion-ai-submit-error"
      role="alert"
      style="
        display:flex;align-items:flex-start;gap:0.5rem;
        padding:0.6rem 0.75rem;border-radius:0.4rem;
        background:var(--danger-bg, rgba(176,0,32,0.08));
        border:1px solid var(--danger-border, rgba(176,0,32,0.25));
        color:var(--danger, #b00020);
        font-size:0.82rem;line-height:1.45;
        white-space:pre-wrap;word-break:break-word;
      "
    >
      <span aria-hidden="true" style="flex-shrink:0;">⚠</span>
      <span style="flex:1;">
        ${t("remotionAi.errors.submitFailed", { detail: state.submitError })}
      </span>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function phaseLabel(phase: RemotionAiPhase | null | undefined): string {
  // Polling can race submit and briefly leave `phase` undefined; rather than
  // rendering the literal i18n key ("remotionAi.phase.undefined"), fall back
  // to the friendly \"queued\" label so the user sees something sensible.
  const safe: RemotionAiPhase =
    phase && typeof phase === "string" ? (phase as RemotionAiPhase) : "queued";
  const label = t(`remotionAi.phase.${safe}` as const);
  // If the key round-trips (no locale entry), degrade gracefully to the
  // raw phase name rather than the i18n key path.
  return label.startsWith("remotionAi.phase.") ? safe : label;
}

// ---------------------------------------------------------------------------
// Auth status badge — small chip in the header next to the phase label.
// Clicking opens the auth modal so the user can switch from hosted ↔ byok
// without leaving the panel. Bold the unset case so first-time users see
// "Choose AI" before they hit Generate.
// ---------------------------------------------------------------------------

function renderAuthBadge(state: RemotionAiPanelViewState): TemplateResult {
  const badge = describeAuthBadge(state.authStatus, t);
  // Visual treatment per tone:
  //   hosted → soft accent fill (we want users to see "you're on the
  //            recommended path" but not be loud about it).
  //   byok   → neutral border (tasteful "advanced user" look).
  //   unset  → solid accent bg + animated glow → unmissable on first run.
  const tone = badge.tone;
  const isUnset = tone === "unset";
  const bg =
    tone === "hosted"
      ? "rgba(59,130,246,0.12)"
      : tone === "byok"
        ? "transparent"
        : "var(--accent, #3b82f6)";
  const fg = isUnset ? "#fff" : "var(--fg, inherit)";
  const borderColor =
    tone === "hosted"
      ? "rgba(59,130,246,0.45)"
      : tone === "byok"
        ? "var(--border, rgba(127,127,127,0.35))"
        : "var(--accent, #3b82f6)";
  return html`
    <button
      type="button"
      data-testid="remotion-ai-auth-badge"
      data-tone=${tone}
      title=${badge.hint ?? ""}
      @click=${() => state.callbacks.onOpenAuthModal()}
      style="
        display:inline-flex;align-items:center;gap:0.35rem;
        padding:0.18rem 0.55rem;border-radius:1rem;
        font-size:0.7rem;font-weight:600;cursor:pointer;
        background:${bg};color:${fg};
        border:1px solid ${borderColor};
        ${isUnset ? "animation:remotion-ai-pulse 1.5s ease-out infinite;" : ""}
      "
    >
      ${badge.label}
    </button>
  `;
}
