// ui/src/ui/views/remotion-ai-auth-modal.ts
//
// "Choose your AI" modal for the AI Create panel. Renders six views:
//
//   1. chooser          — pick hosted vs byok (top-level chooser)
//   2. hosted           — email + password form (yyvideoclaw account)
//   3. byok-pick        — sub-chooser: OpenAI vs OpenRouter
//   4. byok-openai      — paste OpenAI key (sk-…)
//   5. byok-openrouter  — paste OpenRouter key (sk-or-v1-…) + model dropdown
//
// The modal is mounted from `<remotion-ai-panel>` whenever the auth
// status is `unset`, OR when the user explicitly clicks the auth badge
// in the panel header.
//
// All copy comes from the `remotionAi.auth.*` i18n keys so 14 locales
// stay in sync. Inputs are kept controlled — every keystroke calls back
// into the controller so the panel's state (and form validation) live
// in one place.

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import type {
  OpenRouterModelWire,
  RemotionAiAuthModalView,
  RemotionAiAuthStatusWire,
} from "../controllers/remotion-ai-auth.ts";

// ---------------------------------------------------------------------------
// Public inputs.
// ---------------------------------------------------------------------------

export type RemotionAiAuthModalCallbacks = {
  /** User picks "hosted" in the chooser → switch to the hosted form. */
  readonly onPickHosted: () => void;
  /** User picks "byok" in the chooser → switch to the byok provider sub-chooser. */
  readonly onPickByok: () => void;
  /** User picks OpenAI in the byok sub-chooser. */
  readonly onPickByokOpenAi: () => void;
  /** User picks OpenRouter in the byok sub-chooser. Also triggers a
   *  model-list fetch so the dropdown is populated by the time the
   *  user types a key. */
  readonly onPickByokOpenRouter: () => void;
  /** User clicks back/cancel in any sub-form → walk one step back in
   *  the modal's nav stack. The view computes the right destination
   *  based on the current view. */
  readonly onBackToChooser: () => void;
  /** User dismisses the whole modal (clicks ✕ or the backdrop). The
   *  panel disables this when auth is `unset` so the user can't dodge
   *  the gate by closing the modal. */
  readonly onClose: () => void;
  /** Submit hosted login form. */
  readonly onSubmitHosted: (email: string, password: string) => void;
  /** Submit byok form for the OpenAI provider. */
  readonly onSubmitByokOpenAi: (apiKey: string, displayName?: string) => void;
  /** Submit byok form for the OpenRouter provider. */
  readonly onSubmitByokOpenRouter: (apiKey: string, model: string, displayName?: string) => void;
};

export type RemotionAiAuthModalState = {
  readonly view: RemotionAiAuthModalView;
  readonly pending: boolean;
  readonly error: string | null;
  /** When the auth status is `unset`, dismissing the modal is forbidden:
   *  the orchestrator rejects every job submission until the user picks. */
  readonly currentStatus: RemotionAiAuthStatusWire | null;
  /** Cached OpenRouter model list. `null` = "still fetching"; an empty
   *  array means the request finished but returned nothing. */
  readonly openRouterModels: ReadonlyArray<OpenRouterModelWire> | null;
  readonly callbacks: RemotionAiAuthModalCallbacks;
};

// ---------------------------------------------------------------------------
// Root entry.
// ---------------------------------------------------------------------------

export function renderRemotionAiAuthModal(
  state: RemotionAiAuthModalState,
): TemplateResult | typeof nothing {
  if (state.view === "closed") {
    return nothing;
  }
  const dismissable = state.currentStatus !== null && state.currentStatus.mode !== "unset";
  return html`
    <div
      class="remotion-ai-auth-modal__backdrop"
      data-testid="remotion-ai-auth-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="remotion-ai-auth-modal-title"
      @click=${(e: Event) => {
        if (!dismissable) return;
        if (e.target === e.currentTarget) {
          state.callbacks.onClose();
        }
      }}
      style="
        position:fixed;inset:0;z-index:1000;
        background:rgba(0,0,0,0.5);
        display:flex;align-items:center;justify-content:center;
        padding:1rem;
      "
    >
      <div
        class="remotion-ai-auth-modal"
        @click=${(e: Event) => e.stopPropagation()}
        style="
          width:100%;max-width:520px;
          background:var(--card, var(--bg, #fff));
          color:var(--fg, #111);
          border-radius:0.5rem;
          border:1px solid var(--border, rgba(127,127,127,0.25));
          box-shadow:0 12px 32px rgba(0,0,0,0.25);
          display:flex;flex-direction:column;overflow:hidden;
        "
      >
        ${renderChrome(state, dismissable)} ${renderViewBody(state)}
      </div>
    </div>
  `;
}

function renderViewBody(state: RemotionAiAuthModalState): TemplateResult {
  switch (state.view) {
    case "chooser":
      return renderChooser(state);
    case "hosted":
      return renderHostedForm(state);
    case "byok-pick":
      return renderByokPicker(state);
    case "byok-openai":
      return renderByokOpenAiForm(state);
    case "byok-openrouter":
      return renderByokOpenRouterForm(state);
    default:
      return html``;
  }
}

// ---------------------------------------------------------------------------
// Chrome: title bar shared by all sub-views.
// ---------------------------------------------------------------------------

function renderChrome(state: RemotionAiAuthModalState, dismissable: boolean): TemplateResult {
  const titleKey =
    state.view === "hosted"
      ? "remotionAi.auth.modal.hosted.title"
      : state.view === "byok-pick"
        ? "remotionAi.auth.modal.byokPick.title"
        : state.view === "byok-openai"
          ? "remotionAi.auth.modal.byokOpenai.title"
          : state.view === "byok-openrouter"
            ? "remotionAi.auth.modal.byokOpenrouter.title"
            : "remotionAi.auth.modal.chooser.title";
  return html`
    <header
      style="
        display:flex;align-items:center;gap:0.5rem;
        padding:0.85rem 1rem;
        border-bottom:1px solid var(--border, rgba(127,127,127,0.18));
      "
    >
      <h2
        id="remotion-ai-auth-modal-title"
        data-testid="remotion-ai-auth-modal-title"
        style="margin:0;font-size:1rem;font-weight:600;flex:1;"
      >
        ${t(titleKey)}
      </h2>
      ${dismissable
        ? html`
            <button
              type="button"
              data-testid="remotion-ai-auth-modal-close"
              aria-label=${t("remotionAi.auth.modal.close")}
              @click=${() => state.callbacks.onClose()}
              style="
                background:transparent;border:0;cursor:pointer;
                font-size:1.1rem;line-height:1;padding:0.2rem 0.4rem;
                color:var(--fg, inherit);opacity:0.7;
              "
            >
              ✕
            </button>
          `
        : nothing}
    </header>
  `;
}

// ---------------------------------------------------------------------------
// View 1: top-level chooser (hosted vs byok).
// ---------------------------------------------------------------------------

function renderChooser(state: RemotionAiAuthModalState): TemplateResult {
  return html`
    <div style="padding:1rem;display:flex;flex-direction:column;gap:0.75rem;">
      <p style="margin:0 0 0.25rem 0;font-size:0.85rem;opacity:0.85;">
        ${t("remotionAi.auth.modal.chooser.intro")}
      </p>
      <button
        type="button"
        data-testid="remotion-ai-auth-pick-hosted"
        @click=${() => state.callbacks.onPickHosted()}
        style="
          text-align:left;padding:0.85rem;border-radius:0.4rem;
          border:1px solid var(--accent, #3b82f6);
          background:rgba(59,130,246,0.06);cursor:pointer;
          display:flex;flex-direction:column;gap:0.25rem;
        "
      >
        <strong style="font-size:0.95rem;">
          ${t("remotionAi.auth.modal.chooser.hostedTitle")}
          <span
            style="
              font-size:0.7rem;font-weight:500;margin-left:0.5rem;
              padding:0.1rem 0.4rem;border-radius:1rem;
              background:var(--accent, #3b82f6);color:#fff;
            "
          >
            ${t("remotionAi.auth.modal.chooser.hostedBadge")}
          </span>
        </strong>
        <span style="font-size:0.8rem;opacity:0.85;">
          ${t("remotionAi.auth.modal.chooser.hostedDescription")}
        </span>
      </button>
      <button
        type="button"
        data-testid="remotion-ai-auth-pick-byok"
        @click=${() => state.callbacks.onPickByok()}
        style="
          text-align:left;padding:0.85rem;border-radius:0.4rem;
          border:1px solid var(--border, rgba(127,127,127,0.25));
          background:transparent;cursor:pointer;
          display:flex;flex-direction:column;gap:0.25rem;
        "
      >
        <strong style="font-size:0.95rem;">
          ${t("remotionAi.auth.modal.chooser.byokTitle")}
        </strong>
        <span style="font-size:0.8rem;opacity:0.85;">
          ${t("remotionAi.auth.modal.chooser.byokDescription")}
        </span>
      </button>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// View 2: hosted login.
// ---------------------------------------------------------------------------

function renderHostedForm(state: RemotionAiAuthModalState): TemplateResult {
  // Read values straight from the live DOM at submit time. Any closure-
  // captured locals would be reset on every re-render (e.g. when an
  // async fetch lands and triggers a `requestUpdate`), silently dropping
  // the user's input. FormData side-steps that entirely.
  const submit = (form: HTMLFormElement): void => {
    if (state.pending) return;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    if (!email || !password) return;
    state.callbacks.onSubmitHosted(email, password);
  };
  return html`
    <form
      data-testid="remotion-ai-auth-hosted-form"
      @submit=${(e: Event) => {
        e.preventDefault();
        submit(e.currentTarget as HTMLFormElement);
      }}
      style="padding:1rem;display:flex;flex-direction:column;gap:0.75rem;"
    >
      <p style="margin:0;font-size:0.85rem;opacity:0.85;">
        ${t("remotionAi.auth.modal.hosted.intro")}
      </p>
      <label style="display:flex;flex-direction:column;gap:0.3rem;">
        <span style="font-size:0.8rem;opacity:0.85;">
          ${t("remotionAi.auth.modal.hosted.emailLabel")}
        </span>
        <input
          type="email"
          name="email"
          required
          autocomplete="email"
          data-testid="remotion-ai-auth-hosted-email"
          ?disabled=${state.pending}
          style="
            padding:0.5rem;border-radius:0.35rem;font:inherit;
            border:1px solid var(--border, rgba(127,127,127,0.25));
            background:var(--bg, #fff);color:var(--fg, inherit);
          "
        />
      </label>
      <label style="display:flex;flex-direction:column;gap:0.3rem;">
        <span style="font-size:0.8rem;opacity:0.85;">
          ${t("remotionAi.auth.modal.hosted.passwordLabel")}
        </span>
        <input
          type="password"
          name="password"
          required
          autocomplete="current-password"
          data-testid="remotion-ai-auth-hosted-password"
          ?disabled=${state.pending}
          style="
            padding:0.5rem;border-radius:0.35rem;font:inherit;
            border:1px solid var(--border, rgba(127,127,127,0.25));
            background:var(--bg, #fff);color:var(--fg, inherit);
          "
        />
      </label>
      ${renderInlineError(state)}
      ${renderFormButtons(state, t("remotionAi.auth.modal.hosted.submit"))}
    </form>
  `;
}

// ---------------------------------------------------------------------------
// View 3: BYOK provider sub-picker (OpenAI vs OpenRouter).
// ---------------------------------------------------------------------------

function renderByokPicker(state: RemotionAiAuthModalState): TemplateResult {
  // OpenRouter direct connect is disabled while the codex CLI requires
  // `wire_api = "responses"` (PR openai/codex#10157). The UI keeps the
  // entry visible — but greyed out + with a clear "unsupported" badge —
  // so users coming from older builds or other docs aren't left guessing
  // why the option vanished. See discussion #7782 in openai/codex.
  return html`
    <div style="padding:1rem;display:flex;flex-direction:column;gap:0.75rem;">
      <p style="margin:0 0 0.25rem 0;font-size:0.85rem;opacity:0.85;">
        ${t("remotionAi.auth.modal.byokPick.intro")}
      </p>
      <button
        type="button"
        data-testid="remotion-ai-auth-pick-byok-openai"
        @click=${() => state.callbacks.onPickByokOpenAi()}
        style="
          text-align:left;padding:0.85rem;border-radius:0.4rem;
          border:1px solid var(--border, rgba(127,127,127,0.25));
          background:transparent;cursor:pointer;
          display:flex;flex-direction:column;gap:0.25rem;
        "
      >
        <strong style="font-size:0.95rem;">
          ${t("remotionAi.auth.modal.byokPick.openaiTitle")}
        </strong>
        <span style="font-size:0.8rem;opacity:0.85;">
          ${t("remotionAi.auth.modal.byokPick.openaiDescription")}
        </span>
      </button>
      <button
        type="button"
        disabled
        aria-disabled="true"
        data-testid="remotion-ai-auth-pick-byok-openrouter"
        title=${t("remotionAi.auth.modal.byokPick.openrouterUnsupportedHint")}
        style="
          text-align:left;padding:0.85rem;border-radius:0.4rem;
          border:1px solid var(--border, rgba(127,127,127,0.25));
          background:transparent;cursor:not-allowed;opacity:0.55;
          display:flex;flex-direction:column;gap:0.25rem;
        "
      >
        <strong style="font-size:0.95rem;">
          ${t("remotionAi.auth.modal.byokPick.openrouterTitle")}
          <span
            style="
              font-size:0.7rem;font-weight:500;margin-left:0.5rem;
              padding:0.1rem 0.4rem;border-radius:1rem;
              background:rgba(127,127,127,0.25);color:var(--fg, inherit);
            "
          >
            ${t("remotionAi.auth.modal.byokPick.openrouterUnsupportedBadge")}
          </span>
        </strong>
        <span style="font-size:0.8rem;opacity:0.85;">
          ${t("remotionAi.auth.modal.byokPick.openrouterUnsupportedHint")}
        </span>
      </button>
      <div style="display:flex;gap:0.5rem;justify-content:flex-end;">
        <button
          type="button"
          ?disabled=${state.pending}
          @click=${() => state.callbacks.onBackToChooser()}
          style="
            padding:0.5rem 0.85rem;border-radius:0.35rem;cursor:pointer;
            background:transparent;
            border:1px solid var(--border, rgba(127,127,127,0.25));
            color:var(--fg, inherit);
          "
        >
          ${t("remotionAi.auth.modal.back")}
        </button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// View 4: byok-openai (paste OpenAI key).
// ---------------------------------------------------------------------------

function renderByokOpenAiForm(state: RemotionAiAuthModalState): TemplateResult {
  const submit = (form: HTMLFormElement): void => {
    if (state.pending) return;
    const data = new FormData(form);
    const apiKey = String(data.get("apiKey") ?? "").trim();
    const displayName = String(data.get("displayName") ?? "").trim();
    if (!apiKey.startsWith("sk-")) return;
    state.callbacks.onSubmitByokOpenAi(apiKey, displayName || undefined);
  };
  return html`
    <form
      data-testid="remotion-ai-auth-byok-openai-form"
      @submit=${(e: Event) => {
        e.preventDefault();
        submit(e.currentTarget as HTMLFormElement);
      }}
      style="padding:1rem;display:flex;flex-direction:column;gap:0.75rem;"
    >
      <p style="margin:0;font-size:0.85rem;opacity:0.85;">
        ${t("remotionAi.auth.modal.byokOpenai.intro")}
      </p>
      <label style="display:flex;flex-direction:column;gap:0.3rem;">
        <span style="font-size:0.8rem;opacity:0.85;">
          ${t("remotionAi.auth.modal.byokOpenai.apiKeyLabel")}
        </span>
        <input
          type="password"
          name="apiKey"
          required
          autocomplete="off"
          spellcheck="false"
          placeholder="sk-…"
          data-testid="remotion-ai-auth-byok-openai-api-key"
          ?disabled=${state.pending}
          style="
            padding:0.5rem;border-radius:0.35rem;font:inherit;
            font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;
            border:1px solid var(--border, rgba(127,127,127,0.25));
            background:var(--bg, #fff);color:var(--fg, inherit);
          "
        />
        <span style="font-size:0.7rem;opacity:0.7;">
          ${t("remotionAi.auth.modal.byokOpenai.apiKeyHint")}
        </span>
      </label>
      <label style="display:flex;flex-direction:column;gap:0.3rem;">
        <span style="font-size:0.8rem;opacity:0.85;">
          ${t("remotionAi.auth.modal.byokOpenai.displayNameLabel")}
        </span>
        <input
          type="text"
          name="displayName"
          autocomplete="off"
          placeholder=${t("remotionAi.auth.modal.byokOpenai.displayNamePlaceholder")}
          data-testid="remotion-ai-auth-byok-openai-display-name"
          ?disabled=${state.pending}
          style="
            padding:0.5rem;border-radius:0.35rem;font:inherit;
            border:1px solid var(--border, rgba(127,127,127,0.25));
            background:var(--bg, #fff);color:var(--fg, inherit);
          "
        />
      </label>
      ${renderInlineError(state)}
      ${renderFormButtons(state, t("remotionAi.auth.modal.byokOpenai.submit"))}
    </form>
  `;
}

// ---------------------------------------------------------------------------
// View 5: byok-openrouter (paste OpenRouter key + pick model).
// ---------------------------------------------------------------------------

/**
 * Curated default list of OpenRouter models — used as a placeholder
 * before the live `/auth/openrouter/models` reply lands. Picked to span
 * the price/quality range so the dropdown is useful even if the network
 * call fails.
 */
const OPENROUTER_FALLBACK_MODELS: ReadonlyArray<OpenRouterModelWire> = [
  {
    id: "anthropic/claude-3.5-sonnet",
    name: "Anthropic: Claude 3.5 Sonnet",
    contextLength: null,
    pricing: null,
  },
  { id: "openai/gpt-4.1", name: "OpenAI: GPT-4.1", contextLength: null, pricing: null },
  {
    id: "deepseek/deepseek-chat-v3",
    name: "DeepSeek: V3 Chat",
    contextLength: null,
    pricing: null,
  },
];

function renderByokOpenRouterForm(state: RemotionAiAuthModalState): TemplateResult {
  const defaultModel = state.currentStatus?.byokModel ?? "anthropic/claude-3.5-sonnet";
  const submit = (form: HTMLFormElement): void => {
    if (state.pending) return;
    const data = new FormData(form);
    const apiKey = String(data.get("apiKey") ?? "").trim();
    const model = String(data.get("model") ?? "").trim();
    const displayName = String(data.get("displayName") ?? "").trim();
    if (!apiKey.startsWith("sk-or-v1-")) return;
    if (!model.includes("/")) return;
    state.callbacks.onSubmitByokOpenRouter(apiKey, model, displayName || undefined);
  };
  // Live list takes precedence; null = still loading; empty array =
  // backend reachable but zero models (treat as "use fallback" too so
  // the dropdown is never empty).
  const live = state.openRouterModels;
  const models = live === null || live.length === 0 ? OPENROUTER_FALLBACK_MODELS : live;
  const isLoading = live === null;
  // Pick the option that should be selected on first paint: the
  // previously-saved model if the user already has BYOK configured,
  // otherwise the first entry in `models`. Without this, the visual
  // selection (browser default = first option) and the form value
  // (whatever DOM has) could disagree on first frame.
  const selectedId = models.some((m) => m.id === defaultModel)
    ? defaultModel
    : (models[0]?.id ?? defaultModel);
  return html`
    <form
      data-testid="remotion-ai-auth-byok-openrouter-form"
      @submit=${(e: Event) => {
        e.preventDefault();
        submit(e.currentTarget as HTMLFormElement);
      }}
      style="padding:1rem;display:flex;flex-direction:column;gap:0.75rem;"
    >
      <p style="margin:0;font-size:0.85rem;opacity:0.85;">
        ${t("remotionAi.auth.modal.byokOpenrouter.intro")}
      </p>
      <label style="display:flex;flex-direction:column;gap:0.3rem;">
        <span style="font-size:0.8rem;opacity:0.85;">
          ${t("remotionAi.auth.modal.byokOpenrouter.apiKeyLabel")}
        </span>
        <input
          type="password"
          name="apiKey"
          required
          autocomplete="off"
          spellcheck="false"
          placeholder="sk-or-v1-…"
          data-testid="remotion-ai-auth-byok-openrouter-api-key"
          ?disabled=${state.pending}
          style="
            padding:0.5rem;border-radius:0.35rem;font:inherit;
            font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;
            border:1px solid var(--border, rgba(127,127,127,0.25));
            background:var(--bg, #fff);color:var(--fg, inherit);
          "
        />
        <span style="font-size:0.7rem;opacity:0.7;">
          ${t("remotionAi.auth.modal.byokOpenrouter.apiKeyHint")}
        </span>
      </label>
      <label style="display:flex;flex-direction:column;gap:0.3rem;">
        <span style="font-size:0.8rem;opacity:0.85;">
          ${t("remotionAi.auth.modal.byokOpenrouter.modelLabel")}
          ${isLoading
            ? html`<span style="opacity:0.6;font-weight:400;">
                — ${t("remotionAi.auth.modal.byokOpenrouter.modelLoading")}
              </span>`
            : nothing}
        </span>
        <select
          name="model"
          required
          data-testid="remotion-ai-auth-byok-openrouter-model"
          ?disabled=${state.pending}
          style="
            padding:0.5rem;border-radius:0.35rem;font:inherit;
            border:1px solid var(--border, rgba(127,127,127,0.25));
            background:var(--bg, #fff);color:var(--fg, inherit);
          "
        >
          ${models.map(
            (m) => html`
              <option value=${m.id} ?selected=${m.id === selectedId}>
                ${m.name}${formatModelPricing(m)}
              </option>
            `,
          )}
        </select>
        <span style="font-size:0.7rem;opacity:0.7;">
          ${t("remotionAi.auth.modal.byokOpenrouter.modelHint")}
        </span>
      </label>
      <label style="display:flex;flex-direction:column;gap:0.3rem;">
        <span style="font-size:0.8rem;opacity:0.85;">
          ${t("remotionAi.auth.modal.byokOpenrouter.displayNameLabel")}
        </span>
        <input
          type="text"
          name="displayName"
          autocomplete="off"
          placeholder=${t("remotionAi.auth.modal.byokOpenrouter.displayNamePlaceholder")}
          data-testid="remotion-ai-auth-byok-openrouter-display-name"
          ?disabled=${state.pending}
          style="
            padding:0.5rem;border-radius:0.35rem;font:inherit;
            border:1px solid var(--border, rgba(127,127,127,0.25));
            background:var(--bg, #fff);color:var(--fg, inherit);
          "
        />
      </label>
      ${renderInlineError(state)}
      ${renderFormButtons(state, t("remotionAi.auth.modal.byokOpenrouter.submit"))}
    </form>
  `;
}

/**
 * Format the per-token price into a tasteful suffix:
 *   `Anthropic: Claude 3.5 Sonnet  ($3.00 in / $15.00 out per 1M)`
 *
 * OpenRouter returns prices as USD-per-token strings, so we multiply by
 * 1M to get human-readable numbers. Models with missing pricing data
 * (the fallback list) just get an empty suffix.
 */
function formatModelPricing(m: OpenRouterModelWire): string {
  if (!m.pricing) return "";
  const inUsd = Number(m.pricing.prompt) * 1_000_000;
  const outUsd = Number(m.pricing.completion) * 1_000_000;
  if (!Number.isFinite(inUsd) || !Number.isFinite(outUsd)) return "";
  if (inUsd === 0 && outUsd === 0) return "  (free)";
  return `  ($${inUsd.toFixed(2)} in / $${outUsd.toFixed(2)} out per 1M)`;
}

// ---------------------------------------------------------------------------
// Shared form chrome: error row + Back/Submit buttons.
// ---------------------------------------------------------------------------

function renderInlineError(state: RemotionAiAuthModalState): TemplateResult | typeof nothing {
  if (!state.error) return nothing;
  return html`
    <div
      role="alert"
      data-testid="remotion-ai-auth-modal-error"
      style="
        font-size:0.8rem;color:var(--danger, #b00020);
        padding:0.5rem 0.6rem;border-radius:0.35rem;
        background:rgba(176,0,32,0.08);
      "
    >
      ${state.error}
    </div>
  `;
}

function renderFormButtons(state: RemotionAiAuthModalState, submitLabel: string): TemplateResult {
  return html`
    <div style="display:flex;gap:0.5rem;justify-content:flex-end;">
      <button
        type="button"
        ?disabled=${state.pending}
        @click=${() => state.callbacks.onBackToChooser()}
        style="
          padding:0.5rem 0.85rem;border-radius:0.35rem;cursor:pointer;
          background:transparent;
          border:1px solid var(--border, rgba(127,127,127,0.25));
          color:var(--fg, inherit);
        "
      >
        ${t("remotionAi.auth.modal.back")}
      </button>
      <button
        type="submit"
        data-testid="remotion-ai-auth-modal-submit"
        ?disabled=${state.pending}
        style="
          padding:0.5rem 1rem;border-radius:0.35rem;cursor:pointer;
          background:var(--accent, #3b82f6);color:#fff;border:0;
          font-weight:600;
        "
      >
        ${state.pending ? t("remotionAi.auth.modal.submitting") : submitLabel}
      </button>
    </div>
  `;
}
