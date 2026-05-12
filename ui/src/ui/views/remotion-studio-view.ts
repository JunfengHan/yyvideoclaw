// Remotion Studio — Lit view.
//
// Pure-function view (matches `video-studio-view.ts` style) plugged into
// `app-render.ts` via the `${state.tab === "remotionStudio" ? ... : nothing}`
// dispatch. No custom-element registration, no shadow DOM — keeps wiring
// trivial and stays consistent with the rest of yyvideoclaw's tab views.
//
// Layout (4 panes):
//
//   ┌─────────────┬───────────────────────────────────────┐
//   │ Templates   │ Render form (JSON or schema-form)     │
//   │ list (L)    │   ┌─────────────────────────────────┐ │
//   │             │   │ Preview (<video> blob URL)       │ │
//   │             │   └─────────────────────────────────┘ │
//   │             │ History (recent jobs)                  │
//   └─────────────┴───────────────────────────────────────┘
//
// Schema-form is a *progressive enhancement*: when `metadata.inputPropsSchema`
// describes a flat object of primitives we render typed inputs; otherwise we
// fall back to the JSON textarea automatically.
//
// Preview strategy: the artifact route is gateway-authenticated, so we cannot
// hand a bare URL to `<video src=…>`. The view fetches the bytes through the
// authenticated helper, wraps them in `URL.createObjectURL`, and stashes the
// blob URL on the view state. We revoke when switching jobs to keep memory
// bounded.

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import {
  buildRemotionArtifactUrl,
  type RemotionJobResponseWire,
  type RemotionJobSnapshotWire,
  type RemotionStatusWire,
  type RemotionStudioCompositionMetadata,
  type RemotionStudioDraft,
  type RemotionTemplateCompositionWire,
  type RemotionTemplateWire,
} from "../controllers/remotion-studio.ts";
import { renderIcon } from "../icons.ts";
import { renderRemotionAiPanel, type RemotionAiPanelViewState } from "./remotion-ai-panel.ts";

// ---------------------------------------------------------------------------
// Public inputs.
// ---------------------------------------------------------------------------

export type RemotionStudioViewCallbacks = {
  readonly onSelectComposition: (entryPoint: string, compositionId: string) => void;
  readonly onDraftChange: (patch: Partial<RemotionStudioDraft>) => void;
  readonly onSubmit: () => void;
  readonly onSelectHistory: (jobId: string) => void;
  readonly onRefreshTemplates: () => void;
  readonly onCopyOutputPath: (path: string) => void;
};

export type RemotionStudioViewState = {
  readonly status: RemotionStatusWire | null;
  readonly statusError: string | null;
  readonly templates: readonly RemotionTemplateWire[];
  readonly templatesErrors: ReadonlyArray<{ entryPoint: string; reason: string }>;
  readonly templatesLoading: boolean;
  readonly templatesError: string | null;
  readonly draft: RemotionStudioDraft;
  readonly currentJob: RemotionJobResponseWire | null;
  readonly history: readonly RemotionJobResponseWire[];
  readonly submitting: boolean;
  readonly submitError: string | null;
  /** URL.createObjectURL() result for the current job's artifact, if loaded. */
  readonly previewBlobUrl: string | null;
  /** basePath used to build the (unauthenticated) "open externally" link. */
  readonly basePath: string;
  readonly callbacks: RemotionStudioViewCallbacks;
  /**
   * Optional Remotion AI Create panel state. When provided, the panel is
   * rendered above the templates+form layout. When `undefined` (the
   * default), the legacy view renders unchanged. This keeps the AI panel
   * a fully optional, opt-in surface that callers wire in once they're
   * ready to expose Remotion AI to users.
   */
  readonly aiPanel?: RemotionAiPanelViewState;
};

// ---------------------------------------------------------------------------
// Root entry.
// ---------------------------------------------------------------------------

export function renderRemotionStudioView(
  s: RemotionStudioViewState,
): TemplateResult | typeof nothing {
  const aiPanel = renderRemotionAiPanel(s.aiPanel);
  if (!s.status && s.statusError) {
    return shell(html`${aiPanel} ${infoBox(s.statusError)}`);
  }
  if (!s.status) {
    return shell(html`${aiPanel} ${infoBox(t("remotionStudio.state.loadingTemplates"))}`);
  }
  return shell(html`
    ${aiPanel}
    <div
      class="remotion-studio-view__layout"
      style="display:grid;grid-template-columns:minmax(220px,260px) minmax(0,1fr);gap:1.25rem;align-items:start;"
    >
      ${renderTemplatesPane(s)} ${renderRightColumn(s)}
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Outer chrome (matches video-studio-view.ts style).
// ---------------------------------------------------------------------------

function shell(children: TemplateResult): TemplateResult {
  return html`
    <section
      class="remotion-studio-view"
      aria-labelledby="remotion-studio-title"
      style="display:flex;flex-direction:column;gap:1rem;padding:1.5rem;color:var(--text);background:var(--bg);min-height:100%;"
    >
      <header style="display:flex;align-items:flex-start;gap:0.75rem;">
        ${renderIcon("film", "remotion-studio-view__icon")}
        <div style="flex:1;min-width:0;">
          <h1 id="remotion-studio-title" style="margin:0;font-size:1.25rem;">
            ${t("remotionStudio.heading")}
          </h1>
          <p style="margin:0.25rem 0 0;color:var(--muted, var(--text));opacity:0.75;">
            ${t("remotionStudio.description")}
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

// ---------------------------------------------------------------------------
// Left pane — templates list.
// ---------------------------------------------------------------------------

function renderTemplatesPane(s: RemotionStudioViewState): TemplateResult {
  return html`
    <aside
      style="display:flex;flex-direction:column;gap:0.75rem;border:1px solid var(--border,rgba(128,128,128,0.3));border-radius:8px;padding:0.75rem;background:var(--bg-elev,transparent);position:sticky;top:0.5rem;max-height:calc(100vh - 6rem);overflow:auto;"
    >
      <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;">
        <strong style="font-size:0.95rem;">${t("remotionStudio.panes.templates")}</strong>
        <button
          type="button"
          @click=${s.callbacks.onRefreshTemplates}
          ?disabled=${s.templatesLoading}
          style="padding:0.25rem 0.5rem;border-radius:4px;border:1px solid var(--border,rgba(128,128,128,0.5));background:transparent;color:var(--text);cursor:pointer;font-size:0.8rem;"
          aria-label="refresh templates"
        >
          ${s.templatesLoading ? "…" : "↻"}
        </button>
      </div>
      ${s.templatesError
        ? infoBox(t("remotionStudio.state.loadFailed") + ": " + s.templatesError)
        : nothing}
      ${s.templates.length === 0 && !s.templatesLoading
        ? infoBox(html`
            <div>${t("remotionStudio.state.noTemplates")}</div>
            <div style="margin-top:0.25rem;font-size:0.85rem;opacity:0.75;">
              ${t("remotionStudio.state.noTemplatesHint")}
            </div>
          `)
        : nothing}
      ${s.templates.map((tpl) => renderTemplateGroup(s, tpl))}
      ${s.templatesErrors.length > 0
        ? html`<details style="font-size:0.8rem;opacity:0.75;">
            <summary>load errors (${s.templatesErrors.length})</summary>
            <ul style="margin:0.25rem 0 0 1rem;padding:0;">
              ${s.templatesErrors.map(
                (e) => html`<li><code>${e.entryPoint}</code>: ${e.reason}</li>`,
              )}
            </ul>
          </details>`
        : nothing}
    </aside>
  `;
}

function renderTemplateGroup(
  s: RemotionStudioViewState,
  tpl: RemotionTemplateWire,
): TemplateResult {
  return html`
    <div style="display:flex;flex-direction:column;gap:0.25rem;">
      <div
        style="font-size:0.75rem;opacity:0.7;font-family:var(--font-mono,monospace);word-break:break-all;"
        title=${tpl.entryPoint}
      >
        ${shortenEntryPoint(tpl.entryPoint)}
      </div>
      <ul
        style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0.25rem;"
      >
        ${tpl.compositions.map((c) => renderCompositionRow(s, tpl.entryPoint, c))}
      </ul>
    </div>
  `;
}

function renderCompositionRow(
  s: RemotionStudioViewState,
  entryPoint: string,
  c: RemotionTemplateCompositionWire,
): TemplateResult {
  const selected = s.draft.entryPoint === entryPoint && s.draft.compositionId === c.compositionId;
  const label = c.metadata?.label ?? c.compositionId;
  const sizeBadge = t("remotionStudio.template.sizeBadge", {
    width: String(c.width),
    height: String(c.height),
    fps: String(c.fps),
    duration: String(c.durationInFrames),
  });
  return html`
    <li>
      <button
        type="button"
        @click=${() => s.callbacks.onSelectComposition(entryPoint, c.compositionId)}
        aria-pressed=${selected ? "true" : "false"}
        style="
          width:100%;text-align:left;display:flex;flex-direction:column;gap:0.125rem;
          padding:0.4rem 0.5rem;border-radius:6px;cursor:pointer;
          border:1px solid ${selected
          ? "var(--accent,#3a7afe)"
          : "var(--border,rgba(128,128,128,0.3))"};
          background:${selected ? "var(--accent-soft,rgba(58,122,254,0.12))" : "transparent"};
          color:var(--text);
        "
      >
        <span style="font-weight:${selected ? "600" : "400"};">${label}</span>
        <span style="font-size:0.7rem;opacity:0.7;font-family:var(--font-mono,monospace);">
          ${c.compositionId} · ${sizeBadge}
        </span>
      </button>
    </li>
  `;
}

function shortenEntryPoint(entryPoint: string): string {
  // ~/.openclaw/... or absolute → keep last 2 segments + filename for context
  const parts = entryPoint.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return entryPoint;
  }
  return ".../" + parts.slice(-3).join("/");
}

// ---------------------------------------------------------------------------
// Right column — form, preview, history.
// ---------------------------------------------------------------------------

function renderRightColumn(s: RemotionStudioViewState): TemplateResult {
  return html`
    <div style="display:flex;flex-direction:column;gap:1rem;min-width:0;">
      ${renderFormSection(s)} ${renderPreviewSection(s)} ${renderHistorySection(s)}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Form section.
// ---------------------------------------------------------------------------

function renderFormSection(s: RemotionStudioViewState): TemplateResult {
  const composition = currentComposition(s);
  if (!composition) {
    return panelCard(t("remotionStudio.panes.form"), infoBox(t("remotionStudio.template.empty")));
  }

  const schema = composition.metadata?.inputPropsSchema;
  const schemaSupported = schema ? isSimpleObjectSchema(schema) : false;
  const effectiveMode: "form" | "json" =
    s.draft.mode === "form" && schemaSupported ? "form" : "json";
  const showFallbackHint = s.draft.mode === "form" && schema !== undefined && !schemaSupported;

  return panelCard(
    t("remotionStudio.panes.form"),
    html`
      ${renderCompositionHeader(composition)} ${renderFormToggle(s, schemaSupported)}
      ${showFallbackHint ? infoBox(t("remotionStudio.form.schemaTooComplex")) : nothing}
      ${effectiveMode === "form" && schema ? renderSchemaForm(s, schema) : renderJsonTextarea(s)}
      ${renderOutputControls(s, composition)}
      ${s.submitError
        ? html`<div style="color:var(--danger,#d94c4c);font-size:0.85rem;">
            ${t("remotionStudio.errors.submitFailed", { detail: s.submitError })}
          </div>`
        : nothing}
      <div>
        <button
          type="button"
          @click=${s.callbacks.onSubmit}
          ?disabled=${s.submitting || !s.draft.entryPoint || !s.draft.compositionId}
          style="padding:0.5rem 1.1rem;border-radius:6px;border:1px solid var(--accent,#3a7afe);background:var(--accent,#3a7afe);color:#fff;cursor:pointer;font-weight:500;"
        >
          ${s.submitting ? t("remotionStudio.form.submitting") : t("remotionStudio.form.submit")}
        </button>
      </div>
    `,
  );
}

function renderCompositionHeader(c: RemotionTemplateCompositionWire): TemplateResult {
  const label = c.metadata?.label ?? c.compositionId;
  const desc = c.metadata?.description;
  const sizeBadge = t("remotionStudio.template.sizeBadge", {
    width: String(c.width),
    height: String(c.height),
    fps: String(c.fps),
    duration: String(c.durationInFrames),
  });
  return html`
    <div
      style="border:1px solid var(--border,rgba(128,128,128,0.3));border-radius:6px;padding:0.5rem 0.75rem;background:var(--bg-elev,transparent);"
    >
      <div style="font-weight:600;">${label}</div>
      <div style="font-size:0.8rem;opacity:0.75;font-family:var(--font-mono,monospace);">
        ${c.compositionId} · ${sizeBadge}
      </div>
      ${desc
        ? html`<div style="font-size:0.85rem;opacity:0.85;margin-top:0.25rem;">${desc}</div>`
        : nothing}
    </div>
  `;
}

function renderFormToggle(s: RemotionStudioViewState, schemaSupported: boolean): TemplateResult {
  const buttonStyle = (active: boolean): string =>
    `padding:0.3rem 0.7rem;border-radius:4px;cursor:pointer;font-size:0.8rem;` +
    `border:1px solid ${active ? "var(--accent,#3a7afe)" : "var(--border,rgba(128,128,128,0.4))"};` +
    `background:${active ? "var(--accent,#3a7afe)" : "transparent"};` +
    `color:${active ? "#fff" : "var(--text)"};`;
  return html`
    <div role="tablist" style="display:flex;gap:0.4rem;">
      <button
        type="button"
        role="tab"
        aria-selected=${s.draft.mode === "form" ? "true" : "false"}
        ?disabled=${!schemaSupported}
        @click=${() => s.callbacks.onDraftChange({ mode: "form" })}
        style=${buttonStyle(s.draft.mode === "form" && schemaSupported)}
      >
        ${t("remotionStudio.form.schemaForm")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected=${s.draft.mode === "json" ? "true" : "false"}
        @click=${() => s.callbacks.onDraftChange({ mode: "json" })}
        style=${buttonStyle(s.draft.mode === "json" || !schemaSupported)}
      >
        ${t("remotionStudio.form.jsonMode")}
      </button>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// JSON textarea.
// ---------------------------------------------------------------------------

function renderJsonTextarea(s: RemotionStudioViewState): TemplateResult {
  const validation = validateJson(s.draft.inputPropsJson);
  return html`
    <label style="display:flex;flex-direction:column;gap:0.25rem;">
      <span style="font-size:0.85rem;font-weight:500;"
        >${t("remotionStudio.form.inputPropsLabel")}</span
      >
      <textarea
        rows="8"
        spellcheck="false"
        autocapitalize="off"
        autocorrect="off"
        .value=${s.draft.inputPropsJson}
        placeholder=${t("remotionStudio.form.inputPropsPlaceholder")}
        @input=${(e: Event) => {
          const value = (e.target as HTMLTextAreaElement).value;
          s.callbacks.onDraftChange({ inputPropsJson: value });
        }}
        style="
          font-family:var(--font-mono,ui-monospace,SFMono-Regular,monospace);
          font-size:0.85rem;
          padding:0.5rem;
          border-radius:6px;
          border:1px solid ${validation.ok
          ? "var(--border,rgba(128,128,128,0.4))"
          : "var(--danger,#d94c4c)"};
          background:var(--bg);
          color:var(--text);
          resize:vertical;
        "
      ></textarea>
      ${validation.ok
        ? html`<button
            type="button"
            @click=${() => formatJson(s)}
            style="align-self:flex-start;font-size:0.75rem;padding:0.2rem 0.5rem;border-radius:4px;border:1px solid var(--border,rgba(128,128,128,0.4));background:transparent;color:var(--text);cursor:pointer;"
          >
            ${t("remotionStudio.form.formatJson")}
          </button>`
        : html`<span style="color:var(--danger,#d94c4c);font-size:0.8rem;">
            ${t("remotionStudio.form.invalidJson", { error: validation.error })}
          </span>`}
    </label>
  `;
}

function formatJson(s: RemotionStudioViewState): void {
  try {
    const parsed = JSON.parse(s.draft.inputPropsJson || "{}");
    s.callbacks.onDraftChange({ inputPropsJson: JSON.stringify(parsed, null, 2) });
  } catch {
    /* validation already shown */
  }
}

function validateJson(raw: string): { ok: true } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "must be an object" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Schema-form (progressive enhancement for flat object-of-primitives schemas).
//
// Only handles the JSON-Schema subset that's commonly produced by zod's
// `.toJsonSchema()`:
//   - top-level `type: "object"` with a `properties` map
//   - each property has `type: "string" | "number" | "integer" | "boolean"`
//   - optional `enum` array (renders <select>)
//   - optional `default` value
// Anything else trips `isSimpleObjectSchema()` → falls back to JSON mode.
// ---------------------------------------------------------------------------

type FormFieldType = "string" | "number" | "integer" | "boolean";

type FormField = {
  readonly key: string;
  readonly type: FormFieldType;
  readonly enumValues?: readonly (string | number)[];
  readonly description?: string;
  readonly required: boolean;
};

function isSimpleObjectSchema(schema: Record<string, unknown>): boolean {
  if (schema.type !== "object") {
    return false;
  }
  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props || typeof props !== "object") {
    return false;
  }
  for (const value of Object.values(props)) {
    if (!value || typeof value !== "object") {
      return false;
    }
    const propType = (value as Record<string, unknown>).type;
    if (
      propType !== "string" &&
      propType !== "number" &&
      propType !== "integer" &&
      propType !== "boolean"
    ) {
      return false;
    }
  }
  return true;
}

function extractFields(schema: Record<string, unknown>): readonly FormField[] {
  const props = (schema.properties as Record<string, Record<string, unknown>>) ?? {};
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(props).map(([key, def]) => ({
    key,
    type: def.type as FormFieldType,
    enumValues: Array.isArray(def.enum) ? (def.enum as (string | number)[]) : undefined,
    description: typeof def.description === "string" ? def.description : undefined,
    required: required.has(key),
  }));
}

function renderSchemaForm(
  s: RemotionStudioViewState,
  schema: Record<string, unknown>,
): TemplateResult {
  const fields = extractFields(schema);
  const current = parseDraftJson(s.draft.inputPropsJson);

  const updateField = (key: string, value: unknown) => {
    const next = { ...current, [key]: value };
    s.callbacks.onDraftChange({ inputPropsJson: JSON.stringify(next, null, 2) });
  };

  return html`
    <div style="display:flex;flex-direction:column;gap:0.6rem;">
      ${fields.map((f) => renderField(f, current[f.key], updateField))}
    </div>
  `;
}

function parseDraftJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function safePrimitiveString(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  // Object/array fallback: stringify with JSON instead of triggering [object Object].
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function renderField(
  field: FormField,
  currentValue: unknown,
  set: (key: string, value: unknown) => void,
): TemplateResult {
  const labelText = field.required ? `${field.key} *` : field.key;
  const labelEl = html`
    <span style="font-size:0.85rem;font-weight:500;">${labelText}</span>
    ${field.description
      ? html`<span style="font-size:0.75rem;opacity:0.7;">${field.description}</span>`
      : nothing}
  `;
  if (field.enumValues && field.enumValues.length > 0) {
    const stringValue = safePrimitiveString(currentValue);
    return html`
      <label style="display:flex;flex-direction:column;gap:0.2rem;">
        ${labelEl}
        <select
          .value=${stringValue}
          @change=${(e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            set(field.key, field.type === "number" || field.type === "integer" ? Number(v) : v);
          }}
          style="padding:0.4rem;border-radius:4px;border:1px solid var(--border,rgba(128,128,128,0.4));background:var(--bg);color:var(--text);"
        >
          <option value="" ?selected=${stringValue === ""}></option>
          ${field.enumValues.map(
            (opt) =>
              html`<option value=${String(opt)} ?selected=${stringValue === String(opt)}>
                ${String(opt)}
              </option>`,
          )}
        </select>
      </label>
    `;
  }

  if (field.type === "boolean") {
    const checked = currentValue === true;
    return html`
      <label style="display:flex;align-items:center;gap:0.5rem;">
        <input
          type="checkbox"
          .checked=${checked}
          @change=${(e: Event) => set(field.key, (e.target as HTMLInputElement).checked)}
        />
        ${labelEl}
      </label>
    `;
  }

  if (field.type === "number" || field.type === "integer") {
    const stringValue = safePrimitiveString(currentValue);
    return html`
      <label style="display:flex;flex-direction:column;gap:0.2rem;">
        ${labelEl}
        <input
          type="number"
          step=${field.type === "integer" ? "1" : "any"}
          .value=${stringValue}
          @input=${(e: Event) => {
            const raw = (e.target as HTMLInputElement).value;
            if (raw === "") {
              set(field.key, undefined);
              return;
            }
            const num = Number(raw);
            if (!Number.isFinite(num)) {
              return;
            }
            set(field.key, field.type === "integer" ? Math.trunc(num) : num);
          }}
          style="padding:0.4rem;border-radius:4px;border:1px solid var(--border,rgba(128,128,128,0.4));background:var(--bg);color:var(--text);"
        />
      </label>
    `;
  }

  // string
  const stringValue = safePrimitiveString(currentValue);
  return html`
    <label style="display:flex;flex-direction:column;gap:0.2rem;">
      ${labelEl}
      <input
        type="text"
        .value=${stringValue}
        @input=${(e: Event) => set(field.key, (e.target as HTMLInputElement).value)}
        style="padding:0.4rem;border-radius:4px;border:1px solid var(--border,rgba(128,128,128,0.4));background:var(--bg);color:var(--text);"
      />
    </label>
  `;
}

// ---------------------------------------------------------------------------
// Output controls (kind / codec / image format / frame).
// ---------------------------------------------------------------------------

function renderOutputControls(
  s: RemotionStudioViewState,
  _composition: RemotionTemplateCompositionWire,
): TemplateResult {
  const { draft } = s;
  const labelStyle =
    "font-size:0.8rem;font-weight:500;display:flex;flex-direction:column;gap:0.2rem;";
  const inputStyle =
    "padding:0.35rem;border-radius:4px;border:1px solid var(--border,rgba(128,128,128,0.4));background:var(--bg);color:var(--text);";
  return html`
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0.6rem;">
      <label style=${labelStyle}>
        <span>${t("remotionStudio.form.kindLabel")}</span>
        <select
          .value=${draft.kind}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value as "video" | "still";
            s.callbacks.onDraftChange({ kind: value });
          }}
          style=${inputStyle}
        >
          <option value="video" ?selected=${draft.kind === "video"}>
            ${t("remotionStudio.form.kindVideo")}
          </option>
          <option value="still" ?selected=${draft.kind === "still"}>
            ${t("remotionStudio.form.kindStill")}
          </option>
        </select>
      </label>
      ${draft.kind === "video"
        ? html`<label style=${labelStyle}>
            <span>${t("remotionStudio.form.codecLabel")}</span>
            <select
              .value=${draft.codec}
              @change=${(e: Event) => {
                const value = (e.target as HTMLSelectElement).value as RemotionStudioDraft["codec"];
                s.callbacks.onDraftChange({ codec: value });
              }}
              style=${inputStyle}
            >
              ${(["h264", "h265", "vp8", "vp9"] as const).map(
                (codec) =>
                  html`<option value=${codec} ?selected=${draft.codec === codec}>${codec}</option>`,
              )}
            </select>
          </label>`
        : nothing}
      ${draft.kind === "still"
        ? html`<label style=${labelStyle}>
              <span>${t("remotionStudio.form.imageFormatLabel")}</span>
              <select
                .value=${draft.imageFormat}
                @change=${(e: Event) => {
                  const value = (e.target as HTMLSelectElement).value as "png" | "jpeg";
                  s.callbacks.onDraftChange({ imageFormat: value });
                }}
                style=${inputStyle}
              >
                <option value="png" ?selected=${draft.imageFormat === "png"}>png</option>
                <option value="jpeg" ?selected=${draft.imageFormat === "jpeg"}>jpeg</option>
              </select>
            </label>
            <label style=${labelStyle}>
              <span>${t("remotionStudio.form.frameLabel")}</span>
              <input
                type="number"
                min="0"
                step="1"
                .value=${draft.frame == null ? "" : String(draft.frame)}
                placeholder=${t("remotionStudio.form.framePlaceholder")}
                @input=${(e: Event) => {
                  const raw = (e.target as HTMLInputElement).value;
                  if (raw === "") {
                    s.callbacks.onDraftChange({ frame: null });
                    return;
                  }
                  const num = Number(raw);
                  if (Number.isFinite(num) && num >= 0) {
                    s.callbacks.onDraftChange({ frame: Math.trunc(num) });
                  }
                }}
                style=${inputStyle}
              />
            </label>`
        : nothing}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Preview section.
// ---------------------------------------------------------------------------

function renderPreviewSection(s: RemotionStudioViewState): TemplateResult {
  const job = s.currentJob?.job;
  if (!job) {
    return panelCard(t("remotionStudio.panes.preview"), infoBox(t("remotionStudio.preview.empty")));
  }
  return panelCard(
    t("remotionStudio.panes.preview"),
    html` ${renderJobMeta(s, job)} ${renderArtifact(s, job)} `,
  );
}

function renderJobMeta(s: RemotionStudioViewState, job: RemotionJobSnapshotWire): TemplateResult {
  const statusKey = `remotionStudio.job.status.${job.status}` as const;
  const statusColor =
    job.status === "done"
      ? "var(--success,#1f9d55)"
      : job.status === "error"
        ? "var(--danger,#d94c4c)"
        : "var(--muted,var(--text))";
  return html`
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:0.75rem;font-size:0.85rem;">
      <span
        style="padding:0.15rem 0.5rem;border-radius:999px;background:${statusColor};color:#fff;font-weight:500;"
      >
        ${t(statusKey)}
      </span>
      ${job.durationMs != null
        ? html`<span>
            ${t("remotionStudio.job.durationLabel")}: ${formatDuration(job.durationMs)}
          </span>`
        : nothing}
      ${job.sizeBytes != null
        ? html`<span> ${t("remotionStudio.job.sizeLabel")}: ${formatBytes(job.sizeBytes)} </span>`
        : nothing}
      ${job.outputPath
        ? html`<button
            type="button"
            @click=${() => s.callbacks.onCopyOutputPath(job.outputPath!)}
            style="font-size:0.75rem;padding:0.2rem 0.5rem;border-radius:4px;border:1px solid var(--border,rgba(128,128,128,0.4));background:transparent;color:var(--text);cursor:pointer;"
          >
            ${t("remotionStudio.job.copyPath")}
          </button>`
        : nothing}
      ${job.mediaLibraryPath
        ? html`<button
            type="button"
            @click=${() => s.callbacks.onCopyOutputPath(job.mediaLibraryPath!)}
            style="font-size:0.75rem;padding:0.2rem 0.5rem;border-radius:4px;border:1px solid var(--accent,#3a7afe);background:transparent;color:var(--accent,#3a7afe);cursor:pointer;"
            title=${job.mediaLibraryPath}
          >
            ${t("remotionStudio.job.copyMediaPath")}
          </button>`
        : nothing}
    </div>
    ${job.error
      ? html`<div
          style="margin-top:0.4rem;color:var(--danger,#d94c4c);font-size:0.8rem;font-family:var(--font-mono,monospace);"
        >
          ${job.error}
        </div>`
      : nothing}
  `;
}

function renderArtifact(s: RemotionStudioViewState, job: RemotionJobSnapshotWire): TemplateResult {
  if (job.status !== "done") {
    return html``;
  }
  const isVideo = job.kind === "video";
  if (isVideo) {
    if (s.previewBlobUrl) {
      return html`
        <video
          src=${s.previewBlobUrl}
          controls
          playsinline
          style="margin-top:0.5rem;max-width:100%;border-radius:6px;background:#000;"
        ></video>
      `;
    }
    return html`<div style="margin-top:0.5rem;font-size:0.85rem;opacity:0.75;">
      ${t("remotionStudio.preview.videoUnsupported")}
    </div>`;
  }
  // still: same blob url path, but rendered as <img>.
  if (s.previewBlobUrl) {
    return html`
      <img
        src=${s.previewBlobUrl}
        alt=${job.kind}
        style="margin-top:0.5rem;max-width:100%;border-radius:6px;background:#000;"
      />
    `;
  }
  // Fallback: link to gateway-authenticated artifact (will require browser
  // session auth; mostly here for "open in new tab" debug).
  const url = buildRemotionArtifactUrl({ basePath: s.basePath }, job.jobId);
  return html`<a href=${url} target="_blank" rel="noopener noreferrer">open artifact</a>`;
}

// ---------------------------------------------------------------------------
// History section.
// ---------------------------------------------------------------------------

function renderHistorySection(s: RemotionStudioViewState): TemplateResult {
  return panelCard(
    t("remotionStudio.panes.history"),
    s.history.length === 0
      ? infoBox(t("remotionStudio.history.empty"))
      : html`
          <ul
            style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0.4rem;"
          >
            ${s.history.map((entry) => renderHistoryRow(s, entry))}
          </ul>
        `,
  );
}

function renderHistoryRow(
  s: RemotionStudioViewState,
  entry: RemotionJobResponseWire,
): TemplateResult {
  const job = entry.job;
  const isCurrent = s.currentJob?.job.jobId === job.jobId;
  const compositionLabel = job.request.compositionId ?? "—";
  const timestamp = job.finishedAt ?? job.startedAt ?? job.enqueuedAt;
  const statusColor =
    job.status === "done"
      ? "var(--success,#1f9d55)"
      : job.status === "error"
        ? "var(--danger,#d94c4c)"
        : "var(--muted,var(--text))";
  return html`
    <li>
      <button
        type="button"
        @click=${() => s.callbacks.onSelectHistory(job.jobId)}
        style="
          width:100%;text-align:left;display:flex;align-items:center;gap:0.5rem;
          padding:0.4rem 0.6rem;border-radius:6px;cursor:pointer;
          border:1px solid ${isCurrent
          ? "var(--accent,#3a7afe)"
          : "var(--border,rgba(128,128,128,0.3))"};
          background:${isCurrent ? "var(--accent-soft,rgba(58,122,254,0.12))" : "transparent"};
          color:var(--text);
        "
      >
        <span
          style="width:0.5rem;height:0.5rem;border-radius:50%;background:${statusColor};flex-shrink:0;"
        ></span>
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${compositionLabel}
        </span>
        <span style="font-size:0.75rem;opacity:0.7;">${formatRelativeTime(timestamp)}</span>
      </button>
    </li>
  `;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function panelCard(title: string, body: TemplateResult): TemplateResult {
  return html`
    <section
      style="display:flex;flex-direction:column;gap:0.6rem;border:1px solid var(--border,rgba(128,128,128,0.3));border-radius:8px;padding:0.85rem 1rem;background:var(--bg-elev,transparent);"
    >
      <h2 style="margin:0;font-size:0.95rem;font-weight:600;">${title}</h2>
      ${body}
    </section>
  `;
}

function currentComposition(s: RemotionStudioViewState): RemotionTemplateCompositionWire | null {
  if (!s.draft.entryPoint || !s.draft.compositionId) {
    return null;
  }
  const tpl = s.templates.find((tt) => tt.entryPoint === s.draft.entryPoint);
  if (!tpl) {
    return null;
  }
  return tpl.compositions.find((c) => c.compositionId === s.draft.compositionId) ?? null;
}

function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  if (n < 1024 * 1024 * 1024) {
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatRelativeTime(iso: string): string {
  const t0 = Date.parse(iso);
  if (!Number.isFinite(t0)) {
    return "";
  }
  const delta = Date.now() - t0;
  if (delta < 60_000) {
    return "just now";
  }
  if (delta < 3_600_000) {
    return `${Math.floor(delta / 60_000)}m`;
  }
  if (delta < 86_400_000) {
    return `${Math.floor(delta / 3_600_000)}h`;
  }
  return `${Math.floor(delta / 86_400_000)}d`;
}

// Re-export to keep the metadata type local-import-friendly for callers.
export type { RemotionStudioCompositionMetadata };
