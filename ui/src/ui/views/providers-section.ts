import { html, nothing } from "lit";
import type { ModelsApiKeysStatusResult, ProviderApiKeyStatus } from "../types.ts";

/**
 * Props for {@link renderProvidersSection}.
 *
 * Consumers (config view) pass in already-loaded status plus imperative save
 * callbacks. The section itself is pure rendering — state lives in app.ts
 * and the `providers` controller.
 */
export type ProvidersSectionProps = {
  /** Null before the first load attempt; empty providers list after a failed load. */
  status: ModelsApiKeysStatusResult | null;
  loading: boolean;
  error: string | null;
  /** Per-provider in-flight flags (keyed by lowercase provider id). */
  saving: Record<string, boolean>;
  /** Per-provider save errors (keyed by lowercase provider id). */
  errors: Record<string, string | null>;
  onReload: () => void;
  onSaveApiKey: (provider: string, apiKey: string | null) => void;
  onSaveBaseUrl: (provider: string, baseUrl: string | null) => void;
};

function providerKey(provider: string): string {
  return provider.trim().toLowerCase();
}

function sourceBadgeClass(source: ProviderApiKeyStatus["source"]): string {
  switch (source) {
    case "credentials":
      return "providers-badge providers-badge--ok";
    case "env":
      return "providers-badge providers-badge--warn";
    case "config":
      return "providers-badge providers-badge--warn";
    case "none":
    default:
      return "providers-badge providers-badge--muted";
  }
}

function sourceLabel(source: ProviderApiKeyStatus["source"]): string {
  switch (source) {
    case "credentials":
      return "Configured";
    case "env":
      return "Inherited from .env";
    case "config":
      return "From openclaw.json";
    case "none":
    default:
      return "Not set";
  }
}

function providerInitial(row: ProviderApiKeyStatus): string {
  const name = (row.displayName || row.provider).trim();
  return name.length > 0 ? name[0].toUpperCase() : "?";
}

function extractKeyInputValue(card: Element): string {
  const input = card.querySelector<HTMLInputElement>('input[data-role="provider-api-key-input"]');
  return input?.value ?? "";
}

function extractBaseUrlInputValue(card: Element): string {
  const input = card.querySelector<HTMLInputElement>('input[data-role="provider-base-url-input"]');
  return input?.value ?? "";
}

function findProviderCard(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  return target.closest<HTMLElement>(".providers-card");
}

function renderEmptyCard(message: string) {
  return html`
    <div class="providers-empty">
      <div class="providers-empty__text">${message}</div>
    </div>
  `;
}

function renderHeader(props: ProvidersSectionProps) {
  return html`
    <div class="providers-section__header">
      <div>
        <h2 class="providers-section__title">Providers &amp; API Keys</h2>
        <p class="providers-section__desc">
          Configure API keys and base URLs for each model provider. Keys are stored under
          <code>~/.openclaw/credentials/</code> and are never written to
          <code>openclaw.json</code> or <code>.env</code>.
        </p>
      </div>
      <div class="providers-section__actions">
        <button
          class="providers-btn providers-btn--ghost"
          type="button"
          @click=${props.onReload}
          ?disabled=${props.loading}
          aria-label="Reload providers"
        >
          ${props.loading ? "Loading…" : "Reload"}
        </button>
      </div>
    </div>
  `;
}

function renderProviderCard(props: ProvidersSectionProps, row: ProviderApiKeyStatus) {
  const keyId = providerKey(row.provider);
  const busy = props.saving[keyId] ?? false;
  const err = props.errors[keyId] ?? null;
  const modelLabel =
    row.modelCount === 1 ? "1 model available" : `${row.modelCount} models available`;

  const handleSaveKey = (event: Event) => {
    const card = findProviderCard(event.target);
    if (!card) {
      return;
    }
    const value = extractKeyInputValue(card).trim();
    if (value.length === 0) {
      return;
    }
    props.onSaveApiKey(row.provider, value);
  };

  const handleClearKey = () => {
    props.onSaveApiKey(row.provider, null);
  };

  const handleSaveBaseUrl = (event: Event) => {
    const card = findProviderCard(event.target);
    if (!card) {
      return;
    }
    const value = extractBaseUrlInputValue(card).trim();
    props.onSaveBaseUrl(row.provider, value.length > 0 ? value : null);
  };

  const handleResetBaseUrl = () => {
    props.onSaveBaseUrl(row.provider, null);
  };

  return html`
    <article class="providers-card" data-provider=${row.provider}>
      <header class="providers-card__header">
        <span class="providers-card__chip" aria-hidden="true">${providerInitial(row)}</span>
        <div class="providers-card__titles">
          <h3 class="providers-card__title">${row.displayName}</h3>
          <div class="providers-card__meta">
            <span class=${sourceBadgeClass(row.source)}>${sourceLabel(row.source)}</span>
            ${row.masked
              ? html`<code class="providers-masked" title="Key preview">${row.masked}</code>`
              : nothing}
            <span class="providers-card__models">${modelLabel}</span>
          </div>
        </div>
      </header>

      <div class="providers-card__body">
        <label class="providers-field">
          <span class="providers-field__label">API Key</span>
          <div class="providers-field__row">
            <input
              type="password"
              autocomplete="off"
              spellcheck="false"
              placeholder=${row.isSet ? "Replace stored key…" : "Paste provider API key"}
              data-role="provider-api-key-input"
              ?disabled=${busy}
            />
            <button
              class="providers-btn providers-btn--primary"
              type="button"
              ?disabled=${busy}
              @click=${handleSaveKey}
            >
              Save
            </button>
            <button
              class="providers-btn providers-btn--danger"
              type="button"
              ?disabled=${busy || !row.isSet}
              @click=${handleClearKey}
            >
              Clear
            </button>
          </div>
        </label>

        <label class="providers-field">
          <span class="providers-field__label">Base URL</span>
          <div class="providers-field__row">
            <input
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="Default provider endpoint"
              data-role="provider-base-url-input"
              .value=${row.baseUrl ?? ""}
              ?disabled=${busy}
            />
            <button
              class="providers-btn providers-btn--secondary"
              type="button"
              ?disabled=${busy}
              @click=${handleSaveBaseUrl}
            >
              Save URL
            </button>
            <button
              class="providers-btn providers-btn--ghost"
              type="button"
              ?disabled=${busy || !row.baseUrl}
              @click=${handleResetBaseUrl}
            >
              Reset
            </button>
          </div>
        </label>

        ${err ? html`<div class="providers-card__error" role="alert">${err}</div>` : nothing}
      </div>
    </article>
  `;
}

export function renderProvidersSection(props: ProvidersSectionProps) {
  return html`
    <section class="providers-section">
      ${renderHeader(props)}
      ${props.error
        ? html`<div class="providers-section__banner" role="alert">${props.error}</div>`
        : nothing}
      ${props.status === null
        ? props.loading
          ? renderEmptyCard("Loading provider status…")
          : renderEmptyCard("No provider status available.")
        : props.status.providers.length === 0
          ? renderEmptyCard("No providers discovered. Check your plugin configuration.")
          : html`
              <div class="providers-grid">
                ${props.status.providers.map((row) => renderProviderCard(props, row))}
              </div>
            `}
    </section>
  `;
}
