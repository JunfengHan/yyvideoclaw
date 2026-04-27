// Video Studio Settings section — renders the form block the host Settings
// panel can slot in "after AI Agents" (requirements §7.1).
//
// The renderer is a pure function returning a Lit `TemplateResult`; the
// host owns the surrounding scaffold (sidebar, save button, etc.) so we
// stay compatible with the existing `app-settings.ts` layout without
// touching its render tree.
//
// No HTTP calls live here — the Backend Status block is driven by a
// snapshot passed in by the caller (usually projected from
// `PixelleBackendSupervisor.getStatus()`). Similarly, the model list
// comes from the caller since yyvideoclaw has its own model catalog and
// LLM-capability filter that we should not re-implement.

import { html, type TemplateResult } from "lit";
// We intentionally import type-only from src/video-studio/settings.ts so
// the UI bundle does not pull in the main-process module graph.
import type {
  VideoStudioBackendStatusSnapshot,
  VideoStudioSettings,
} from "../../../../src/video-studio/settings.ts";
import { t } from "../../i18n/index.ts";
import type { AspectRatio, Pipeline } from "./client.ts";

// ---------------------------------------------------------------------------
// Public props.
// ---------------------------------------------------------------------------

export type ModelOption = {
  readonly id: string;
  readonly label?: string;
};

export type FrameTemplateOption = {
  readonly key: string;
  readonly label?: string;
};

export type VideoStudioSettingsSectionProps = {
  readonly settings: VideoStudioSettings;
  readonly modelOptions: readonly ModelOption[];
  readonly templateOptions: readonly FrameTemplateOption[];
  readonly backendStatus: VideoStudioBackendStatusSnapshot;
  readonly onChange: (patch: Partial<VideoStudioSettings>) => void;
  readonly onInstall: () => void;
  readonly onReinstall: () => void;
  readonly onUninstall: () => void;
  readonly onOpenLogs: () => void;
};

const ASPECT_RATIOS: readonly AspectRatio[] = ["9:16", "16:9", "1:1"];
const PIPELINES: readonly Pipeline[] = ["standard", "asset-based", "linear", "custom"];

// ---------------------------------------------------------------------------
// Helpers — pure, unit-tested via `settings-section.test.ts`.
// ---------------------------------------------------------------------------

export function formatBackendStatus(snapshot: VideoStudioBackendStatusSnapshot): string {
  const bits: string[] = [snapshot.state];
  if (snapshot.pid != null) bits.push(`pid=${snapshot.pid}`);
  if (snapshot.port != null) bits.push(`port=${snapshot.port}`);
  if (snapshot.uptimeMs != null && Number.isFinite(snapshot.uptimeMs) && snapshot.uptimeMs > 0) {
    bits.push(`uptime=${Math.round(snapshot.uptimeMs / 1000)}s`);
  }
  return bits.join(" · ");
}

function pipelineLabel(p: Pipeline): string {
  switch (p) {
    case "standard":
      return t("videoStudio.pipeline.standard");
    case "asset-based":
      return t("videoStudio.pipeline.assetBased");
    case "linear":
      return t("videoStudio.pipeline.linear");
    case "custom":
      return t("videoStudio.pipeline.custom");
    default:
      return p;
  }
}

// ---------------------------------------------------------------------------
// Renderer.
// ---------------------------------------------------------------------------

export function renderVideoStudioSettingsSection(
  props: VideoStudioSettingsSectionProps,
): TemplateResult {
  const { settings, onChange } = props;
  const row = (label: string, control: TemplateResult) => html`
    <label
      style="display:grid;grid-template-columns:minmax(180px,30%) 1fr;gap:0.75rem;align-items:center;padding:0.35rem 0;"
    >
      <span style="opacity:0.8;">${label}</span>
      ${control}
    </label>
  `;

  return html`
    <section
      class="settings-section settings-section--video-studio"
      aria-labelledby="video-studio-settings-heading"
      style="display:flex;flex-direction:column;gap:0.75rem;padding:1rem 1.25rem;color:var(--text);background:var(--bg);"
    >
      <header style="display:flex;flex-direction:column;gap:0.25rem;">
        <h2 id="video-studio-settings-heading" style="margin:0;font-size:1.1rem;">
          ${t("videoStudio.heading")}
        </h2>
        <p style="margin:0;opacity:0.75;font-size:0.875rem;">${t("subtitles.videoStudio")}</p>
      </header>

      ${row(
        t("videoStudio.state.featureDisabled"),
        html`
          <input
            type="checkbox"
            .checked=${settings.enabled}
            @change=${(e: Event) => onChange({ enabled: (e.target as HTMLInputElement).checked })}
          />
        `,
      )}
      ${row(
        "Default LLM Model",
        html`
          <select
            .value=${settings.defaultModel}
            @change=${(e: Event) =>
              onChange({ defaultModel: (e.target as HTMLSelectElement).value })}
            style="padding:0.4rem;border-radius:6px;border:1px solid var(--border,rgba(128,128,128,0.5));background:var(--bg);color:var(--text);"
          >
            ${props.modelOptions.length === 0
              ? html`<option value=${settings.defaultModel} selected>
                  ${settings.defaultModel}
                </option>`
              : props.modelOptions.map(
                  (m) => html`
                    <option value=${m.id} ?selected=${settings.defaultModel === m.id}>
                      ${m.label ?? m.id}
                    </option>
                  `,
                )}
          </select>
        `,
      )}
      ${row(
        t("videoStudio.topic.aspectRatio"),
        html`
          <div style="display:flex;gap:0.75rem;">
            ${ASPECT_RATIOS.map(
              (ratio) => html`
                <label style="display:inline-flex;gap:0.25rem;align-items:center;cursor:pointer;">
                  <input
                    type="radio"
                    name="video-studio-settings-aspect"
                    .checked=${settings.defaultAspectRatio === ratio}
                    @change=${() => onChange({ defaultAspectRatio: ratio })}
                  />
                  <span>${ratio}</span>
                </label>
              `,
            )}
          </div>
        `,
      )}
      ${row(
        t("videoStudio.pipeline.title"),
        html`
          <select
            .value=${settings.defaultPipeline}
            @change=${(e: Event) =>
              onChange({ defaultPipeline: (e.target as HTMLSelectElement).value as Pipeline })}
            style="padding:0.4rem;border-radius:6px;border:1px solid var(--border,rgba(128,128,128,0.5));background:var(--bg);color:var(--text);"
          >
            ${PIPELINES.map(
              (p) => html`
                <option value=${p} ?selected=${settings.defaultPipeline === p}>
                  ${pipelineLabel(p)}
                </option>
              `,
            )}
          </select>
        `,
      )}
      ${row(
        t("videoStudio.topic.frameTemplate"),
        html`
          <select
            .value=${settings.defaultFrameTemplate ?? ""}
            @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              onChange({ defaultFrameTemplate: v === "" ? null : v });
            }}
            style="padding:0.4rem;border-radius:6px;border:1px solid var(--border,rgba(128,128,128,0.5));background:var(--bg);color:var(--text);"
          >
            <option value="">${t("videoStudio.topic.frameTemplatePlaceholder")}</option>
            ${props.templateOptions.map(
              (tpl) => html`
                <option value=${tpl.key} ?selected=${settings.defaultFrameTemplate === tpl.key}>
                  ${tpl.label ?? tpl.key}
                </option>
              `,
            )}
          </select>
        `,
      )}
      ${row(
        "Auto-stop after (minutes)",
        html`
          <input
            type="number"
            min="0"
            step="1"
            .value=${String(settings.autoStopIdleMinutes)}
            @change=${(e: Event) =>
              onChange({
                autoStopIdleMinutes: Math.max(
                  0,
                  Math.floor(Number((e.target as HTMLInputElement).value) || 0),
                ),
              })}
            style="padding:0.4rem;border-radius:6px;border:1px solid var(--border,rgba(128,128,128,0.5));background:var(--bg);color:var(--text);max-width:8rem;"
          />
        `,
      )}
      ${row(
        "Backend Status",
        html`<code style="opacity:0.9;">${formatBackendStatus(props.backendStatus)}</code>`,
      )}

      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;padding-top:0.5rem;">
        <button
          type="button"
          @click=${props.onInstall}
          style="padding:0.4rem 0.8rem;border-radius:6px;border:1px solid var(--border,rgba(128,128,128,0.5));background:var(--accent,#3a7afe);color:#fff;cursor:pointer;"
        >
          ${t("videoStudio.state.install")}
        </button>
        <button
          type="button"
          @click=${props.onReinstall}
          style="padding:0.4rem 0.8rem;border-radius:6px;border:1px solid var(--border,rgba(128,128,128,0.5));background:transparent;color:var(--text);cursor:pointer;"
        >
          Reinstall
        </button>
        <button
          type="button"
          @click=${props.onUninstall}
          style="padding:0.4rem 0.8rem;border-radius:6px;border:1px solid var(--danger,#d94c4c);background:transparent;color:var(--danger,#d94c4c);cursor:pointer;"
        >
          Uninstall
        </button>
        <button
          type="button"
          @click=${props.onOpenLogs}
          style="padding:0.4rem 0.8rem;border-radius:6px;border:1px solid var(--border,rgba(128,128,128,0.5));background:transparent;color:var(--text);cursor:pointer;"
        >
          ${t("videoStudio.state.viewLogs")}
        </button>
      </div>
    </section>
  `;
}
