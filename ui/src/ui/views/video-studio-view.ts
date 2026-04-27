// Video Studio — MVP Lit view.
//
// Renders the topic→video workflow as a native tab inside yyvideoclaw.
// The view stays pure-function (no LitElement) on purpose so `app-render.ts`
// can slot it into the existing `${state.tab === "..." ? render... : nothing}`
// dispatch without introducing a new custom-element registration path.
//
// Five MVP sections (per requirements §5.2):
//
//   (A) Topic — title + narration + aspect-ratio + frame template.
//   (B) Pipeline — standard / asset-based / linear / custom radio row.
//   (C) Generate button + live progress panel (6 phases).
//   (D) Result — video player + download / copy-link / open-in-finder /
//       regenerate.
//   (E) History — most recent task snapshots, collapsible below <900px.
//
// Untaken-path states (backend not installed / starting / crashed /
// feature disabled) all fall through to small, theme-consistent cards.

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { renderIcon } from "../icons.ts";
import type {
  AspectRatio,
  FrameTemplate,
  Pipeline,
  TaskPhase,
  TaskSnapshot,
} from "../video-studio/client.ts";
import {
  computePhaseRows,
  isTaskActive,
  resolveViewMode,
  type BackendState,
} from "../video-studio/view-helpers.ts";

// ---------------------------------------------------------------------------
// Public inputs.
// ---------------------------------------------------------------------------

export type DraftState = {
  readonly title: string;
  readonly narration: string;
  readonly aspectRatio: AspectRatio;
  readonly frameTemplate: string | null;
  readonly pipeline: Pipeline;
};

export type VideoStudioViewCallbacks = {
  readonly onDraftChange: (patch: Partial<DraftState>) => void;
  readonly onGenerate: () => void;
  readonly onRegenerate: () => void;
  readonly onSelectHistory: (taskId: string) => void;
  readonly onInstall: () => void;
  readonly onOpenLogs: () => void;
  readonly onDownload: (task: TaskSnapshot) => void;
  readonly onCopyLink: (task: TaskSnapshot) => void;
  readonly onOpenInFinder: (task: TaskSnapshot) => void;
};

export type VideoStudioViewState = {
  readonly featureEnabled: boolean;
  readonly backend: BackendState;
  readonly templates: readonly FrameTemplate[];
  readonly pipelines: readonly Pipeline[];
  readonly draft: DraftState;
  readonly currentTask: TaskSnapshot | null;
  readonly history: readonly TaskSnapshot[];
  readonly historyExpanded: boolean;
  readonly onToggleHistory: () => void;
  readonly callbacks: VideoStudioViewCallbacks;
};

const ASPECT_RATIOS: readonly AspectRatio[] = ["9:16", "16:9", "1:1"];

// ---------------------------------------------------------------------------
// Root entry — matches the function signature the placeholder exported so
// `app-render.ts` picks up the upgrade with no dispatch changes.
// ---------------------------------------------------------------------------

export function renderVideoStudioView(
  state: VideoStudioViewState | { readonly featureEnabled: boolean },
): TemplateResult | typeof nothing {
  // Back-compat path for the placeholder signature used during task 6.
  const full = "backend" in state ? (state as VideoStudioViewState) : null;
  const featureEnabled = full?.featureEnabled ?? state.featureEnabled;
  if (!featureEnabled) {
    return renderDisabledCard();
  }
  if (!full) {
    // Older call sites (task 6) pass only `{ featureEnabled: true }`; render
    // the "starting" skeleton so the UI degrades gracefully instead of
    // crashing on missing state.
    return renderStartingCard();
  }

  const mode = resolveViewMode({ featureEnabled, backend: full.backend });
  switch (mode.kind) {
    case "disabled":
      return renderDisabledCard();
    case "not-installed":
      return renderNotInstalledCard(full.callbacks.onInstall);
    case "starting":
      return renderStartingCard();
    case "error":
      return renderErrorCard(mode.reason, full.callbacks.onOpenLogs);
    case "studio":
      return renderStudio(full);
    default:
      return nothing;
  }
}

// ---------------------------------------------------------------------------
// Degraded / loading states.
// ---------------------------------------------------------------------------

function card(children: TemplateResult): TemplateResult {
  return html`
    <section
      class="video-studio-view"
      aria-labelledby="video-studio-title"
      style="display:flex;flex-direction:column;gap:1rem;padding:1.5rem;color:var(--text);background:var(--bg);min-height:100%;"
    >
      <header style="display:flex;align-items:center;gap:0.75rem;">
        ${renderIcon("film", "video-studio-view__icon")}
        <div>
          <h1 id="video-studio-title" style="margin:0;font-size:1.25rem;">
            ${t("tabs.videoStudio")}
          </h1>
          <p style="margin:0.25rem 0 0;color:var(--muted, var(--text));opacity:0.75;">
            ${t("subtitles.videoStudio")}
          </p>
        </div>
      </header>
      ${children}
    </section>
  `;
}

function infoBox(body: TemplateResult | string): TemplateResult {
  return html`
    <div
      style="border:1px dashed var(--border,rgba(128,128,128,0.5));border-radius:8px;padding:1rem;line-height:1.5;opacity:0.95;"
    >
      ${body}
    </div>
  `;
}

function renderDisabledCard(): TemplateResult {
  return card(infoBox(t("videoStudio.state.featureDisabled")));
}

function renderStartingCard(): TemplateResult {
  return card(infoBox(t("videoStudio.state.starting")));
}

function renderNotInstalledCard(onInstall: () => void): TemplateResult {
  return card(html`
    <div
      style="border:1px dashed var(--border,rgba(128,128,128,0.5));border-radius:8px;padding:1rem;display:flex;align-items:center;gap:1rem;"
    >
      <span style="flex:1;">${t("videoStudio.state.notInstalled")}</span>
      <button
        type="button"
        @click=${onInstall}
        style="padding:0.5rem 1rem;border-radius:6px;border:1px solid var(--border,rgba(128,128,128,0.5));background:var(--accent,#3a7afe);color:#fff;cursor:pointer;"
      >
        ${t("videoStudio.state.install")}
      </button>
    </div>
  `);
}

function renderErrorCard(reason: string, onOpenLogs: () => void): TemplateResult {
  return card(html`
    <div
      style="border:1px solid var(--danger,#d94c4c);border-radius:8px;padding:1rem;display:flex;flex-direction:column;gap:0.5rem;"
    >
      <strong style="color:var(--danger,#d94c4c);">${t("videoStudio.state.backendError")}</strong>
      <code style="opacity:0.8;word-break:break-word;">${reason}</code>
      <button
        type="button"
        @click=${onOpenLogs}
        style="align-self:flex-start;padding:0.4rem 0.8rem;border-radius:6px;border:1px solid var(--border,rgba(128,128,128,0.5));background:transparent;color:var(--text);cursor:pointer;"
      >
        ${t("videoStudio.state.viewLogs")}
      </button>
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Full studio layout.
// ---------------------------------------------------------------------------

function renderStudio(s: VideoStudioViewState): TemplateResult {
  const main = html`
    <div style="display:flex;flex-direction:column;gap:1.25rem;flex:1;min-width:0;">
      ${renderTopicSection(s)} ${renderPipelineSection(s)} ${renderGenerateSection(s)}
      ${renderResultSection(s)}
    </div>
  `;
  // The history sidebar lives at the right >=900px and collapses into a
  // togglable drawer below that breakpoint. We use inline styles so the
  // component stays zero-dep — the larger style sheet can be extracted in
  // task 10 if needed.
  return card(html`
    <div
      style="display:flex;gap:1.5rem;align-items:flex-start;flex-wrap:wrap;"
      class="video-studio-view__layout"
    >
      ${main} ${renderHistorySection(s)}
    </div>
  `);
}

// ---------------------------------------------------------------------------
// (A) Topic.
// ---------------------------------------------------------------------------

function renderTopicSection(s: VideoStudioViewState): TemplateResult {
  const { draft } = s;
  const emit = s.callbacks.onDraftChange;
  return html`
    <section style="display:flex;flex-direction:column;gap:0.5rem;">
      <h2 style="margin:0;font-size:1rem;">${t("videoStudio.topic.title")}</h2>
      <label style="display:flex;flex-direction:column;gap:0.25rem;">
        <span style="opacity:0.75;font-size:0.875rem;">${t("videoStudio.topic.titleLabel")}</span>
        <input
          type="text"
          .value=${draft.title}
          placeholder=${t("videoStudio.topic.titlePlaceholder")}
          @input=${(e: Event) => emit({ title: (e.target as HTMLInputElement).value })}
          style="padding:0.5rem;border-radius:6px;border:1px solid var(--border,rgba(128,128,128,0.5));background:var(--bg);color:var(--text);"
        />
      </label>
      <label style="display:flex;flex-direction:column;gap:0.25rem;">
        <span style="opacity:0.75;font-size:0.875rem;"
          >${t("videoStudio.topic.narrationLabel")}</span
        >
        <textarea
          rows="4"
          .value=${draft.narration}
          placeholder=${t("videoStudio.topic.narrationPlaceholder")}
          @input=${(e: Event) => emit({ narration: (e.target as HTMLTextAreaElement).value })}
          style="padding:0.5rem;border-radius:6px;border:1px solid var(--border,rgba(128,128,128,0.5));background:var(--bg);color:var(--text);resize:vertical;"
        ></textarea>
      </label>
      <div style="display:flex;gap:1rem;flex-wrap:wrap;">
        <fieldset
          style="border:1px solid var(--border,rgba(128,128,128,0.5));border-radius:6px;padding:0.5rem 0.75rem;"
        >
          <legend style="opacity:0.75;font-size:0.875rem;padding:0 0.25rem;">
            ${t("videoStudio.topic.aspectRatio")}
          </legend>
          <div style="display:flex;gap:0.75rem;">
            ${ASPECT_RATIOS.map(
              (ratio) => html`
                <label style="display:inline-flex;gap:0.25rem;align-items:center;cursor:pointer;">
                  <input
                    type="radio"
                    name="video-studio-aspect"
                    .checked=${draft.aspectRatio === ratio}
                    @change=${() => emit({ aspectRatio: ratio })}
                  />
                  <span>${ratio}</span>
                </label>
              `,
            )}
          </div>
        </fieldset>
        <label style="display:flex;flex-direction:column;gap:0.25rem;flex:1;min-width:220px;">
          <span style="opacity:0.75;font-size:0.875rem;"
            >${t("videoStudio.topic.frameTemplate")}</span
          >
          <select
            .value=${draft.frameTemplate ?? ""}
            @change=${(e: Event) => {
              const value = (e.target as HTMLSelectElement).value;
              emit({ frameTemplate: value === "" ? null : value });
            }}
            style="padding:0.5rem;border-radius:6px;border:1px solid var(--border,rgba(128,128,128,0.5));background:var(--bg);color:var(--text);"
          >
            <option value="">${t("videoStudio.topic.frameTemplatePlaceholder")}</option>
            ${s.templates.map(
              (tpl) => html`
                <option value=${tpl.key} ?selected=${draft.frameTemplate === tpl.key}>
                  ${tpl.label ?? tpl.key}
                </option>
              `,
            )}
          </select>
        </label>
      </div>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// (B) Pipeline.
// ---------------------------------------------------------------------------

function pipelineLabel(pipeline: Pipeline): string {
  switch (pipeline) {
    case "standard":
      return t("videoStudio.pipeline.standard");
    case "asset-based":
      return t("videoStudio.pipeline.assetBased");
    case "linear":
      return t("videoStudio.pipeline.linear");
    case "custom":
      return t("videoStudio.pipeline.custom");
    default:
      return pipeline;
  }
}

function renderPipelineSection(s: VideoStudioViewState): TemplateResult {
  const { draft, pipelines } = s;
  const emit = s.callbacks.onDraftChange;
  return html`
    <section style="display:flex;flex-direction:column;gap:0.5rem;">
      <h2 style="margin:0;font-size:1rem;">${t("videoStudio.pipeline.title")}</h2>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        ${pipelines.map(
          (p) => html`
            <label
              style="display:inline-flex;gap:0.35rem;align-items:center;padding:0.4rem 0.8rem;border:1px solid var(--border,rgba(128,128,128,0.5));border-radius:999px;cursor:pointer;background:${draft.pipeline ===
              p
                ? "var(--accent,#3a7afe)"
                : "transparent"};color:${draft.pipeline === p ? "#fff" : "var(--text)"};"
            >
              <input
                type="radio"
                name="video-studio-pipeline"
                .checked=${draft.pipeline === p}
                @change=${() => emit({ pipeline: p })}
                style="display:none;"
              />
              <span>${pipelineLabel(p)}</span>
            </label>
          `,
        )}
      </div>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// (C) Generate + progress.
// ---------------------------------------------------------------------------

function renderGenerateSection(s: VideoStudioViewState): TemplateResult {
  const rows = computePhaseRows(s.currentTask);
  const active = isTaskActive(s.currentTask?.status);
  return html`
    <section style="display:flex;flex-direction:column;gap:0.75rem;">
      <button
        type="button"
        ?disabled=${active}
        @click=${s.callbacks.onGenerate}
        style="align-self:flex-start;padding:0.6rem 1.2rem;border-radius:6px;border:1px solid var(--accent,#3a7afe);background:${active
          ? "transparent"
          : "var(--accent,#3a7afe)"};color:${active ? "var(--text)" : "#fff"};cursor:${active
          ? "progress"
          : "pointer"};font-weight:600;"
      >
        ${active ? t("videoStudio.generate.generating") : t("videoStudio.generate.button")}
      </button>
      <div
        style="display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:0.5rem;"
        aria-live="polite"
      >
        ${rows.map(
          (r: {
            readonly phase: TaskPhase;
            readonly state: "pending" | "active" | "done" | "failed";
          }) => renderPhaseChip(r.phase, r.state),
        )}
      </div>
    </section>
  `;
}

function renderPhaseChip(phase: TaskPhase, state: "pending" | "active" | "done" | "failed") {
  const color =
    state === "done"
      ? "var(--success,#2fa56a)"
      : state === "active"
        ? "var(--accent,#3a7afe)"
        : state === "failed"
          ? "var(--danger,#d94c4c)"
          : "var(--border,rgba(128,128,128,0.5))";
  return html`
    <div
      style="padding:0.4rem 0.6rem;border:1px solid ${color};border-radius:6px;text-align:center;font-size:0.875rem;opacity:${state ===
      "pending"
        ? 0.6
        : 1};"
    >
      <div style="font-weight:600;">${t(`videoStudio.generate.phases.${phase}`)}</div>
      <div style="font-size:0.75rem;opacity:0.8;">${state}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// (D) Result.
// ---------------------------------------------------------------------------

function renderResultSection(s: VideoStudioViewState): TemplateResult {
  const task = s.currentTask;
  const videoUrl = task?.output?.videoUrl ?? null;
  return html`
    <section style="display:flex;flex-direction:column;gap:0.5rem;">
      <h2 style="margin:0;font-size:1rem;">${t("videoStudio.result.title")}</h2>
      ${videoUrl
        ? html`
            <video
              controls
              src=${videoUrl}
              style="max-width:100%;border-radius:8px;border:1px solid var(--border,rgba(128,128,128,0.5));background:#000;"
            ></video>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
              ${resultButton(
                t("videoStudio.result.download"),
                () => task && s.callbacks.onDownload(task),
              )}
              ${resultButton(
                t("videoStudio.result.copyLink"),
                () => task && s.callbacks.onCopyLink(task),
              )}
              ${resultButton(
                t("videoStudio.result.openInFinder"),
                () => task && s.callbacks.onOpenInFinder(task),
              )}
              ${resultButton(t("videoStudio.result.regenerate"), s.callbacks.onRegenerate)}
            </div>
          `
        : infoBox(t("videoStudio.result.empty"))}
    </section>
  `;
}

function resultButton(label: string, onClick: () => void): TemplateResult {
  return html`
    <button
      type="button"
      @click=${onClick}
      style="padding:0.4rem 0.8rem;border-radius:6px;border:1px solid var(--border,rgba(128,128,128,0.5));background:transparent;color:var(--text);cursor:pointer;"
    >
      ${label}
    </button>
  `;
}

// ---------------------------------------------------------------------------
// (E) History sidebar.
// ---------------------------------------------------------------------------

function renderHistorySection(s: VideoStudioViewState): TemplateResult {
  return html`
    <aside
      class="video-studio-view__history"
      style="flex:0 0 260px;min-width:220px;display:flex;flex-direction:column;gap:0.5rem;border:1px solid var(--border,rgba(128,128,128,0.5));border-radius:8px;padding:0.75rem;max-height:70vh;overflow:auto;"
      ?hidden=${!s.historyExpanded}
    >
      <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;">
        <h2 style="margin:0;font-size:1rem;">${t("videoStudio.history.title")}</h2>
        <button
          type="button"
          @click=${s.onToggleHistory}
          aria-label=${t("videoStudio.history.toggle")}
          style="background:transparent;border:none;cursor:pointer;color:var(--text);opacity:0.7;"
        >
          —
        </button>
      </div>
      ${s.history.length === 0
        ? infoBox(t("videoStudio.history.empty"))
        : html`
            <ul
              style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:0.35rem;"
            >
              ${s.history.map(
                (task) => html`
                  <li>
                    <button
                      type="button"
                      @click=${() => s.callbacks.onSelectHistory(task.id)}
                      style="width:100%;text-align:left;padding:0.5rem;border-radius:6px;border:1px solid var(--border,rgba(128,128,128,0.5));background:${s
                        .currentTask?.id === task.id
                        ? "var(--accent,#3a7afe)"
                        : "transparent"};color:${s.currentTask?.id === task.id
                        ? "#fff"
                        : "var(--text)"};cursor:pointer;"
                    >
                      <div style="font-weight:600;font-size:0.9rem;">${task.id}</div>
                      <div style="opacity:0.8;font-size:0.75rem;">${task.status}</div>
                    </button>
                  </li>
                `,
              )}
            </ul>
          `}
    </aside>
  `;
}
