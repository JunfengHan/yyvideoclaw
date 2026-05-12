// Library tab — Lit view.
//
// Source-agnostic "local resource browser". M1 surface: remotion-ai
// workspaces. The view renders a uniform grid + top-bar controls
// (source filter, search, live-toggle) + per-item action strip
// (open path, copy, delete).
//
// This is a pure render function in the same style as
// `remotion-studio-view.ts`; all mutation happens through callbacks
// (`state.callbacks`) and is wired in `app-render.ts`.

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import type { LibraryFilter, LibraryItem, LibrarySourceStatus } from "../controllers/library.ts";
import { renderIcon } from "../icons.ts";

export type LibraryViewCallbacks = {
  readonly onRefresh: () => void;
  readonly onFilterChange: (patch: Partial<LibraryFilter>) => void;
  readonly onCopyPath: (path: string) => void;
  readonly onDelete: (itemId: string) => void;
  readonly onGoToRemotionStudio: () => void;
};

export type LibraryViewState = {
  readonly items: readonly LibraryItem[];
  readonly filteredItems: readonly LibraryItem[];
  readonly filter: LibraryFilter;
  readonly sourceStatus: Readonly<Record<string, LibrarySourceStatus>>;
  readonly deletingId: string | null;
  readonly callbacks: LibraryViewCallbacks;
};

export function renderLibraryView(s: LibraryViewState): TemplateResult {
  return html`
    <section
      class="library-view"
      aria-labelledby="library-view-title"
      style="
        display:flex;flex-direction:column;gap:1rem;
        padding:1.5rem;color:var(--text);background:var(--bg);min-height:100%;
      "
    >
      ${renderHeader(s)} ${renderToolbar(s)} ${renderSourceBanners(s)} ${renderList(s)}
    </section>
  `;
}

function renderHeader(s: LibraryViewState): TemplateResult {
  const remotionAiRoot = s.sourceStatus["remotion-ai"]?.libraryRoot ?? null;
  return html`
    <header style="display:flex;align-items:flex-start;gap:0.75rem;">
      ${renderIcon("folder", "library-view__icon")}
      <div style="flex:1;min-width:0;">
        <h1 id="library-view-title" style="margin:0;font-size:1.25rem;">${t("library.heading")}</h1>
        <p style="margin:0.25rem 0 0;color:var(--muted, var(--text));opacity:0.75;">
          ${t("library.description")}
        </p>
        ${remotionAiRoot
          ? html`<p style="margin:0.2rem 0 0;font-size:0.78rem;opacity:0.6;font-family:monospace;">
              ${remotionAiRoot}
            </p>`
          : nothing}
      </div>
      <button
        type="button"
        data-testid="library-refresh"
        @click=${() => s.callbacks.onRefresh()}
        style="
          font:inherit;padding:0.45rem 0.75rem;border-radius:0.35rem;cursor:pointer;
          background:transparent;color:inherit;
          border:1px solid var(--border, rgba(127,127,127,0.35));
        "
      >
        ${t("library.actions.refresh")}
      </button>
    </header>
  `;
}

function renderToolbar(s: LibraryViewState): TemplateResult {
  return html`
    <div
      style="
        display:flex;gap:0.6rem;flex-wrap:wrap;align-items:center;
        padding:0.5rem 0.6rem;border-radius:0.4rem;
        background:var(--card, rgba(127,127,127,0.06));
        border:1px solid var(--border, rgba(127,127,127,0.18));
      "
    >
      <input
        type="search"
        data-testid="library-search"
        placeholder=${t("library.filter.searchPlaceholder")}
        .value=${s.filter.search}
        @input=${(e: Event) =>
          s.callbacks.onFilterChange({ search: (e.target as HTMLInputElement).value })}
        style="
          flex:1;min-width:160px;font:inherit;padding:0.4rem 0.55rem;
          border-radius:0.3rem;border:1px solid var(--border, rgba(127,127,127,0.25));
          background:var(--input-bg, transparent);color:inherit;
        "
      />
      <label style="display:flex;align-items:center;gap:0.35rem;font-size:0.8rem;opacity:0.8;">
        <input
          type="checkbox"
          data-testid="library-include-live"
          .checked=${s.filter.includeLive}
          @change=${(e: Event) =>
            s.callbacks.onFilterChange({
              includeLive: (e.target as HTMLInputElement).checked,
            })}
        />
        ${t("library.filter.includeLive")}
      </label>
      <select
        data-testid="library-source"
        .value=${s.filter.sourceId}
        @change=${(e: Event) =>
          s.callbacks.onFilterChange({
            sourceId: (e.target as HTMLSelectElement).value as LibraryFilter["sourceId"],
          })}
        style="
          font:inherit;padding:0.35rem 0.45rem;border-radius:0.3rem;
          border:1px solid var(--border, rgba(127,127,127,0.25));
          background:var(--input-bg, transparent);color:inherit;
        "
      >
        <option value="all" ?selected=${s.filter.sourceId === "all"}>
          ${t("library.sources.all")}
        </option>
        <option value="remotion-ai" ?selected=${s.filter.sourceId === "remotion-ai"}>
          ${t("library.sources.remotionAi")}
        </option>
      </select>
    </div>
  `;
}

function renderSourceBanners(s: LibraryViewState): TemplateResult | typeof nothing {
  const entries = Object.entries(s.sourceStatus).filter(([, st]) => st.error !== null);
  if (entries.length === 0) {
    return nothing;
  }
  return html`
    <div style="display:flex;flex-direction:column;gap:0.35rem;">
      ${entries.map(
        ([id, st]) => html`
          <div
            data-testid="library-source-error"
            style="
              font-size:0.8rem;padding:0.5rem 0.65rem;border-radius:0.35rem;
              color:var(--danger, #b00020);
              background:var(--danger-bg, rgba(176,0,32,0.08));
              border:1px solid var(--danger, rgba(176,0,32,0.25));
            "
          >
            <strong>${id}</strong>: ${st.error}
          </div>
        `,
      )}
    </div>
  `;
}

function renderList(s: LibraryViewState): TemplateResult {
  if (s.filteredItems.length === 0) {
    return html`
      <div
        data-testid="library-empty"
        style="
          padding:1.5rem;border-radius:0.4rem;text-align:center;
          color:var(--muted, var(--text));opacity:0.7;
          background:var(--card, rgba(127,127,127,0.04));
          border:1px dashed var(--border, rgba(127,127,127,0.25));
        "
      >
        ${s.items.length === 0 ? renderEmptyZero(s) : t("library.empty.filtered")}
      </div>
    `;
  }
  return html`
    <ul
      data-testid="library-list"
      style="
        list-style:none;margin:0;padding:0;display:grid;gap:0.6rem;
        grid-template-columns:repeat(auto-fill,minmax(320px,1fr));
      "
    >
      ${s.filteredItems.map((item) => renderCard(s, item))}
    </ul>
  `;
}

function renderEmptyZero(s: LibraryViewState): TemplateResult {
  return html`
    <div style="display:flex;flex-direction:column;gap:0.5rem;align-items:center;">
      <div style="font-size:0.95rem;">${t("library.empty.zero")}</div>
      <button
        type="button"
        data-testid="library-empty-goto-studio"
        @click=${() => s.callbacks.onGoToRemotionStudio()}
        style="
          font:inherit;padding:0.45rem 0.9rem;border-radius:0.35rem;cursor:pointer;
          background:var(--accent, #3b82f6);color:var(--accent-fg, #fff);
          border:1px solid transparent;font-weight:600;
        "
      >
        ${t("library.empty.cta")}
      </button>
    </div>
  `;
}

function renderCard(s: LibraryViewState, item: LibraryItem): TemplateResult {
  const isDeleting = s.deletingId === item.id;
  return html`
    <li
      data-testid="library-item"
      data-item-id=${item.id}
      style="
        display:flex;flex-direction:column;gap:0.45rem;
        padding:0.7rem 0.8rem;border-radius:0.45rem;
        background:var(--card, rgba(127,127,127,0.06));
        border:1px solid var(--border, rgba(127,127,127,0.2));
        ${item.live ? "outline:1px dashed var(--accent, #3b82f6);outline-offset:-2px;" : ""}
      "
    >
      <div style="display:flex;align-items:baseline;gap:0.4rem;">
        <strong
          data-testid="library-item-title"
          style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
        >
          ${item.title || t("library.item.untitled")}
        </strong>
        ${item.live
          ? html`<span
              data-testid="library-item-live-badge"
              style="
                font-size:0.7rem;padding:0.15rem 0.4rem;border-radius:9999px;
                background:var(--accent, #3b82f6);color:var(--accent-fg, #fff);
              "
              >${t("library.item.liveBadge")}</span
            >`
          : nothing}
      </div>
      <div style="font-size:0.75rem;opacity:0.75;">${item.subtitle}</div>
      ${item.workspaceDir
        ? html`<code
            style="
              font-size:0.72rem;opacity:0.7;
              overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
            "
            >${item.workspaceDir}</code
          >`
        : nothing}
      <div style="font-size:0.7rem;opacity:0.6;">
        ${t("library.item.created", { ts: formatTs(item.createdAt) })}
        ${item.sizeBytes !== null ? html` · ${formatBytes(item.sizeBytes)}` : nothing}
      </div>
      <div style="display:flex;gap:0.35rem;flex-wrap:wrap;">
        ${item.workspaceDir
          ? html`<button
              type="button"
              data-testid="library-item-copy"
              @click=${() => s.callbacks.onCopyPath(item.workspaceDir!)}
              style=${miniButtonStyle()}
            >
              ${t("library.item.copyPath")}
            </button>`
          : nothing}
        ${item.live
          ? nothing
          : html`<button
              type="button"
              data-testid="library-item-delete"
              ?disabled=${isDeleting}
              @click=${() => s.callbacks.onDelete(item.id)}
              style=${miniButtonStyle({ danger: true })}
            >
              ${isDeleting ? t("library.item.deleting") : t("library.item.delete")}
            </button>`}
      </div>
    </li>
  `;
}

function miniButtonStyle(opts: { danger?: boolean } = {}): string {
  const colour = opts.danger ? "var(--danger, #b00020)" : "inherit";
  return `
    font:inherit;font-size:0.75rem;padding:0.25rem 0.55rem;border-radius:0.3rem;
    cursor:pointer;background:transparent;color:${colour};
    border:1px solid var(--border, rgba(127,127,127,0.35));
  `;
}

function formatTs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "—";
  }
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
