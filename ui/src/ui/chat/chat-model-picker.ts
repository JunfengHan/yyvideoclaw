import { LitElement, css, html, nothing } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";

export interface ChatModelPickerOption {
  value: string;
  label: string;
  /** Provider id used for grouping. Empty/undefined options fall under
   * "Other". The implicit empty default option is rendered ungrouped. */
  provider?: string;
}

type Group = {
  /** Provider id, or null for the implicit Default option group. */
  provider: string | null;
  /** Human-readable provider label rendered in the group header. */
  label: string;
  entries: ChatModelPickerOption[];
};

type FlatEntry =
  | { kind: "default"; entry: ChatModelPickerOption }
  | { kind: "header"; group: Group; expanded: boolean }
  | { kind: "option"; entry: ChatModelPickerOption; group: Group };

function providerDisplayName(provider: string): string {
  const trimmed = provider.trim();
  if (!trimmed) {
    return "Other";
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * A searchable chat-model picker.
 *
 * Renders a button-like trigger and a floating panel with a search input and
 * a filterable option list. Emits a `change` CustomEvent with `{ value }`
 * when the user selects an option (including the empty "default" option).
 */
@customElement("chat-model-picker")
export class ChatModelPicker extends LitElement {
  static styles = css`
    :host {
      display: inline-block;
      width: 100%;
      font: inherit;
      color: inherit;
      box-sizing: border-box;
    }

    .trigger {
      width: 100%;
      display: inline-flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 10px;
      font-size: 13px;
      line-height: 1.2;
      min-height: 32px;
      border-radius: 6px;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.2));
      background: var(--surface-1, rgba(255, 255, 255, 0.04));
      color: inherit;
      cursor: pointer;
      text-align: left;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      box-sizing: border-box;
    }

    .trigger:hover:not(:disabled) {
      border-color: var(--border-strong, rgba(255, 255, 255, 0.35));
    }

    .trigger:focus-visible {
      outline: 2px solid var(--accent, #4c8bf5);
      outline-offset: 1px;
    }

    .trigger[disabled] {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .trigger-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .caret {
      flex: none;
      font-size: 10px;
      opacity: 0.7;
      transition: transform 0.15s ease;
    }

    :host([data-open]) .caret {
      transform: rotate(180deg);
    }

    .panel {
      position: fixed;
      z-index: 9999;
      min-width: 220px;
      max-width: 420px;
      max-height: 360px;
      display: flex;
      flex-direction: column;
      background: var(--surface-0, #1a1a1a);
      color: inherit;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.2));
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      overflow: hidden;
    }

    .search {
      padding: 8px;
      border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.1));
    }

    .search input {
      width: 100%;
      padding: 6px 8px;
      font: inherit;
      font-size: 13px;
      color: inherit;
      background: var(--surface-1, rgba(255, 255, 255, 0.06));
      border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
      border-radius: 4px;
      outline: none;
      box-sizing: border-box;
    }

    .search input:focus {
      border-color: var(--accent, #4c8bf5);
    }

    .list {
      flex: 1;
      overflow-y: auto;
      padding: 4px 0;
    }

    .list:focus {
      outline: none;
    }

    .option {
      padding: 6px 12px;
      font-size: 13px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .option:hover,
    .option.active {
      background: var(--surface-2, rgba(255, 255, 255, 0.08));
    }

    .option.selected {
      color: var(--accent, #4c8bf5);
      font-weight: 600;
    }

    .empty {
      padding: 10px 12px;
      font-size: 13px;
      opacity: 0.6;
      font-style: italic;
      text-align: center;
    }

    .group-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--text-muted, rgba(255, 255, 255, 0.55));
      cursor: pointer;
      user-select: none;
      background: var(--surface-1, rgba(255, 255, 255, 0.02));
      border-top: 1px solid var(--border, rgba(255, 255, 255, 0.06));
      text-align: left;
    }

    .group-header:first-child {
      border-top: 0;
    }

    .group-header:hover,
    .group-header.active {
      color: var(--text-strong, rgba(255, 255, 255, 0.85));
      background: var(--surface-2, rgba(255, 255, 255, 0.05));
    }

    .group-header__label {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .group-header__count {
      margin-left: auto;
      font-weight: 500;
      opacity: 0.7;
    }

    .group-header__caret {
      flex: none;
      font-size: 9px;
      transition: transform 120ms ease;
    }

    .group-header[data-expanded="true"] .group-header__caret {
      transform: rotate(90deg);
    }

    /* Second-level (grouped) options: deeper indent + a thin guide line on
     * the left to make the parent/child hierarchy visible at a glance. */
    .option {
      position: relative;
      padding-left: 28px;
      color: var(--text-strong, rgba(255, 255, 255, 0.82));
    }

    .option::before {
      content: "";
      position: absolute;
      left: 14px;
      top: 4px;
      bottom: 4px;
      width: 1px;
      background: var(--border, rgba(255, 255, 255, 0.18));
      pointer-events: none;
    }

    .option:hover::before,
    .option.active::before {
      background: var(--accent, #4c8bf5);
      opacity: 0.7;
    }

    .option.selected::before {
      background: var(--accent, #4c8bf5);
      opacity: 1;
    }

    /* Default option pins to the top, ungrouped — no indent, no guide line. */
    .default-option {
      padding-left: 12px;
    }

    .default-option::before {
      display: none;
    }

    /* Light theme tweaks */
    :host-context(:root[data-theme-mode="light"]) .trigger {
      border-color: rgba(16, 24, 40, 0.2);
      background: rgba(16, 24, 40, 0.03);
    }

    :host-context(:root[data-theme-mode="light"]) .panel {
      background: #ffffff;
      border-color: rgba(16, 24, 40, 0.15);
      box-shadow: 0 8px 24px rgba(16, 24, 40, 0.15);
    }

    :host-context(:root[data-theme-mode="light"]) .search {
      border-bottom-color: rgba(16, 24, 40, 0.1);
    }

    :host-context(:root[data-theme-mode="light"]) .search input {
      background: rgba(16, 24, 40, 0.02);
      border-color: rgba(16, 24, 40, 0.15);
      color: #101828;
    }

    :host-context(:root[data-theme-mode="light"]) .option:hover,
    :host-context(:root[data-theme-mode="light"]) .option.active {
      background: rgba(16, 24, 40, 0.06);
    }

    :host-context(:root[data-theme-mode="light"]) .group-header {
      background: rgba(16, 24, 40, 0.03);
      border-top-color: rgba(16, 24, 40, 0.06);
      color: rgba(16, 24, 40, 0.55);
    }

    :host-context(:root[data-theme-mode="light"]) .group-header:hover,
    :host-context(:root[data-theme-mode="light"]) .group-header.active {
      color: rgba(16, 24, 40, 0.85);
      background: rgba(16, 24, 40, 0.06);
    }
  `;

  /** List of selectable options. The empty "default" entry is rendered automatically. */
  @property({ attribute: false }) options: ChatModelPickerOption[] = [];

  /** Current selected value. Empty string means the default option. */
  @property({ type: String }) value = "";

  /** Label used for the implicit empty default option. */
  @property({ attribute: "default-label", type: String }) defaultLabel = "Default";

  /** Placeholder for the search input. */
  @property({ type: String }) placeholder = "Search models...";

  /** Disable interaction. */
  @property({ type: Boolean, reflect: true }) disabled = false;

  /** Accessible label for the trigger. */
  @property({ attribute: "aria-label-text", type: String }) ariaLabelText = "Chat model";

  /** When true, group options by provider with collapsible group headers.
   * Defaults to true. Set to false for flat-list rendering (parity with
   * pre-grouping behavior, useful for tests). */
  @property({ type: Boolean, attribute: "group-by-provider" }) groupByProvider = true;

  /** When true (default), render a search input inside the panel.
   * Set to false for pickers with a small, fixed option set where search
   * adds no value (e.g. thinking-level picker). When hidden, keyboard
   * navigation binds to the panel container instead. */
  @property({ type: Boolean, attribute: "show-search" }) showSearch = true;

  @state() private open = false;
  @state() private query = "";
  @state() private activeIndex = 0;
  @state() private panelStyle = "";
  /** Per-provider expand override (keyed by provider id). When set, this
   * overrides the default rule (auto-expand the selected group, collapse
   * the rest). Cleared on close so panel state stays predictable. */
  @state() private expandedOverrides = new Map<string, boolean>();

  @query(".trigger") private triggerEl?: HTMLButtonElement;
  @query(".search input") private searchInputEl?: HTMLInputElement;

  private readonly onDocPointerDown = (event: PointerEvent) => {
    if (!this.open) return;
    const path = event.composedPath();
    if (path.includes(this)) return;
    this.closePanel();
  };

  private readonly onWindowResize = () => {
    if (this.open) {
      this.updatePanelPosition();
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.onDocPointerDown, true);
    window.addEventListener("resize", this.onWindowResize);
    window.addEventListener("scroll", this.onWindowResize, true);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("pointerdown", this.onDocPointerDown, true);
    window.removeEventListener("resize", this.onWindowResize);
    window.removeEventListener("scroll", this.onWindowResize, true);
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has("open")) {
      if (this.open) {
        this.setAttribute("data-open", "");
      } else {
        this.removeAttribute("data-open");
      }
    }
    // When disabled while open, close it.
    if (changed.has("disabled") && this.disabled && this.open) {
      this.closePanel();
    }
  }

  private get allEntries(): ChatModelPickerOption[] {
    return [{ value: "", label: this.defaultLabel }, ...this.options];
  }

  private get filteredEntries(): ChatModelPickerOption[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.allEntries;
    return this.allEntries.filter((entry) => {
      return (
        entry.label.toLowerCase().includes(q) ||
        (entry.value ? entry.value.toLowerCase().includes(q) : false)
      );
    });
  }

  /**
   * Group filtered entries by provider. Default option (value === "") is
   * always its own ungrouped entry that pins to the top.
   * Groups are stable-sorted by provider display name; the "Other" bucket
   * (entries without a provider) sinks to the bottom.
   */
  private get filteredGroups(): { defaultOption: ChatModelPickerOption | null; groups: Group[] } {
    const entries = this.filteredEntries;
    let defaultOption: ChatModelPickerOption | null = null;
    const byProvider = new Map<string, Group>();
    for (const entry of entries) {
      if (entry.value === "") {
        defaultOption = entry;
        continue;
      }
      const providerKey = (entry.provider ?? "").trim().toLowerCase();
      const groupKey = providerKey || "__other__";
      let group = byProvider.get(groupKey);
      if (!group) {
        group = {
          provider: providerKey || null,
          label: providerKey ? providerDisplayName(providerKey) : "Other",
          entries: [],
        };
        byProvider.set(groupKey, group);
      }
      group.entries.push(entry);
    }
    const groups = Array.from(byProvider.values()).toSorted((a, b) => {
      // "Other" sinks below named providers.
      if (a.provider === null && b.provider !== null) {
        return 1;
      }
      if (b.provider === null && a.provider !== null) {
        return -1;
      }
      return a.label.localeCompare(b.label);
    });
    return { defaultOption, groups };
  }

  /**
   * Resolve which provider group should be auto-expanded by default
   * (the one containing the current selection). With no selection, no
   * group is forced open.
   */
  private get autoExpandedProvider(): string | null {
    if (!this.value) {
      return null;
    }
    const match = this.allEntries.find((entry) => entry.value === this.value);
    const provider = (match?.provider ?? "").trim().toLowerCase();
    return provider || null;
  }

  /**
   * Whether a group is currently expanded. Search forces all visible groups
   * open. With no query, the user's explicit override (if any) wins;
   * otherwise the group containing the current selection is auto-expanded.
   */
  private isGroupExpanded(group: Group): boolean {
    if (!this.groupByProvider) {
      return true;
    }
    const hasQuery = this.query.trim().length > 0;
    if (hasQuery) {
      return true;
    }
    const key = (group.provider ?? "__other__").toLowerCase();
    const override = this.expandedOverrides.get(key);
    if (override !== undefined) {
      return override;
    }
    // Default: only the auto-expanded provider is open.
    const auto = this.autoExpandedProvider;
    if (auto !== null) {
      return key === auto;
    }
    return false;
  }

  /**
   * Flatten the visible entries (default + group headers + visible options)
   * into the order they appear in the DOM. Used for keyboard navigation and
   * activeIndex bookkeeping. When `groupByProvider=false` the headers are
   * skipped and entries appear flat.
   */
  private get flatVisibleEntries(): FlatEntry[] {
    const flat: FlatEntry[] = [];
    const { defaultOption, groups } = this.filteredGroups;
    if (defaultOption) {
      flat.push({ kind: "default", entry: defaultOption });
    }
    if (!this.groupByProvider) {
      for (const group of groups) {
        for (const entry of group.entries) {
          flat.push({ kind: "option", entry, group });
        }
      }
      return flat;
    }
    for (const group of groups) {
      const expanded = this.isGroupExpanded(group);
      flat.push({ kind: "header", group, expanded });
      if (expanded) {
        for (const entry of group.entries) {
          flat.push({ kind: "option", entry, group });
        }
      }
    }
    return flat;
  }

  private toggleGroupCollapsed(group: Group) {
    const key = (group.provider ?? "__other__").toLowerCase();
    const current = this.isGroupExpanded(group);
    const next = new Map(this.expandedOverrides);
    next.set(key, !current);
    this.expandedOverrides = next;
  }

  private get currentLabel(): string {
    const match = this.allEntries.find((entry) => entry.value === this.value);
    return match?.label ?? this.value ?? this.defaultLabel;
  }

  private togglePanel() {
    if (this.disabled) return;
    if (this.open) {
      this.closePanel();
    } else {
      this.openPanel();
    }
  }

  private openPanel() {
    this.open = true;
    this.query = "";
    // Default active index = position of the selected option among visible
    // entries (skipping headers); fall back to 0 (first visible row).
    const flat = this.flatVisibleEntries;
    const selectedIdx = flat.findIndex(
      (item) =>
        (item.kind === "default" && item.entry.value === this.value) ||
        (item.kind === "option" && item.entry.value === this.value),
    );
    this.activeIndex = selectedIdx >= 0 ? selectedIdx : this.firstFocusableIndex(flat);
    // Position after render.
    queueMicrotask(() => {
      this.updatePanelPosition();
      if (this.showSearch) {
        this.searchInputEl?.focus();
        this.searchInputEl?.select();
      } else {
        // No search input — move focus to the list container so keyboard
        // navigation still works.
        const list = this.renderRoot.querySelector<HTMLElement>(".list");
        list?.focus();
      }
    });
  }

  private firstFocusableIndex(flat: FlatEntry[]): number {
    for (let i = 0; i < flat.length; i += 1) {
      if (flat[i].kind !== "header") {
        return i;
      }
    }
    return 0;
  }

  private closePanel() {
    this.open = false;
    this.query = "";
  }

  private updatePanelPosition() {
    const trigger = this.triggerEl;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;
    const preferredHeight = 360;
    const top =
      spaceBelow >= Math.min(preferredHeight, 200) || spaceBelow >= spaceAbove
        ? rect.bottom + 4
        : Math.max(8, rect.top - 4 - preferredHeight);
    const maxHeight = Math.min(
      preferredHeight,
      Math.max(180, top >= rect.bottom ? spaceBelow - 8 : rect.top - 8),
    );
    const left = rect.left;
    const minWidth = Math.max(220, rect.width);
    this.panelStyle = [
      `top: ${top}px`,
      `left: ${left}px`,
      `min-width: ${minWidth}px`,
      `max-height: ${maxHeight}px`,
    ].join("; ");
  }

  private onTriggerKeydown(event: KeyboardEvent) {
    if (this.disabled) return;
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.openPanel();
    }
  }

  private onSearchInput(event: Event) {
    this.query = (event.target as HTMLInputElement).value;
    // After re-filter the flat list shape changes; reset to first focusable.
    this.activeIndex = this.firstFocusableIndex(this.flatVisibleEntries);
  }

  private onSearchKeydown(event: KeyboardEvent) {
    const flat = this.flatVisibleEntries;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (flat.length === 0) return;
      this.activeIndex = (this.activeIndex + 1) % flat.length;
      this.scrollActiveIntoView();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length === 0) return;
      this.activeIndex = (this.activeIndex - 1 + flat.length) % flat.length;
      this.scrollActiveIntoView();
    } else if (event.key === "Home") {
      event.preventDefault();
      this.activeIndex = 0;
      this.scrollActiveIntoView();
    } else if (event.key === "End") {
      event.preventDefault();
      this.activeIndex = Math.max(0, flat.length - 1);
      this.scrollActiveIntoView();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = flat[this.activeIndex];
      if (!item) {
        return;
      }
      if (item.kind === "header") {
        this.toggleGroupCollapsed(item.group);
      } else {
        this.commitSelection(item.entry.value);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.closePanel();
      this.triggerEl?.focus();
    } else if (event.key === "Tab") {
      this.closePanel();
    }
  }

  private scrollActiveIntoView() {
    queueMicrotask(() => {
      const list = this.renderRoot.querySelector(".list");
      const active = list?.querySelector(
        ".option.active, .group-header.active",
      ) as HTMLElement | null;
      // jsdom (test env) and some embedded views don't implement
      // scrollIntoView; guard to avoid uncaught errors there.
      if (typeof active?.scrollIntoView === "function") {
        active.scrollIntoView({ block: "nearest" });
      }
    });
  }

  private commitSelection(next: string) {
    this.closePanel();
    if (next === this.value) {
      return;
    }
    this.value = next;
    this.dispatchEvent(
      new CustomEvent<{ value: string }>("change", {
        detail: { value: next },
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected render() {
    const flat = this.flatVisibleEntries;
    return html`
      <button
        type="button"
        class="trigger"
        part="trigger"
        ?disabled=${this.disabled}
        aria-haspopup="listbox"
        aria-expanded=${this.open ? "true" : "false"}
        aria-label=${this.ariaLabelText}
        title=${this.currentLabel}
        @click=${this.togglePanel}
        @keydown=${this.onTriggerKeydown}
      >
        <span class="trigger-label">${this.currentLabel}</span>
        <span class="caret" aria-hidden="true">▾</span>
      </button>

      ${this.open
        ? html`
            <div class="panel" role="dialog" style=${this.panelStyle}>
              ${this.showSearch
                ? html`<div class="search">
                    <input
                      type="text"
                      spellcheck="false"
                      autocomplete="off"
                      placeholder=${this.placeholder}
                      .value=${this.query}
                      @input=${this.onSearchInput}
                      @keydown=${this.onSearchKeydown}
                    />
                  </div>`
                : nothing}
              <div
                class="list"
                role="listbox"
                tabindex=${this.showSearch ? "-1" : "0"}
                @keydown=${this.showSearch ? nothing : this.onSearchKeydown}
              >
                ${flat.length === 0
                  ? html`<div class="empty">No matches</div>`
                  : repeat(
                      flat,
                      (item, index) => {
                        if (item.kind === "default") {
                          return `__default__:${index}`;
                        }
                        if (item.kind === "header") {
                          return `__header__:${item.group.provider ?? "__other__"}`;
                        }
                        return item.entry.value || `__opt__:${index}`;
                      },
                      (item, index) => {
                        const active = index === this.activeIndex;
                        if (item.kind === "header") {
                          return html`
                            <div
                              class="group-header ${active ? " active" : ""}"
                              role="presentation"
                              data-expanded=${item.expanded ? "true" : "false"}
                              data-provider=${item.group.provider ?? "__other__"}
                              title=${item.group.label}
                              @mouseenter=${() => (this.activeIndex = index)}
                              @click=${() => this.toggleGroupCollapsed(item.group)}
                            >
                              <span class="group-header__caret" aria-hidden="true">▸</span>
                              <span class="group-header__label">${item.group.label}</span>
                              <span class="group-header__count">${item.group.entries.length}</span>
                            </div>
                          `;
                        }
                        const entry = item.entry;
                        const isDefault = item.kind === "default";
                        return html`
                          <div
                            class="option
                              ${isDefault ? " default-option" : ""}
                              ${entry.value === this.value ? " selected" : ""}
                              ${active ? " active" : ""}"
                            role="option"
                            aria-selected=${entry.value === this.value ? "true" : "false"}
                            title=${entry.label}
                            @mouseenter=${() => (this.activeIndex = index)}
                            @click=${() => this.commitSelection(entry.value)}
                          >
                            ${entry.label}
                          </div>
                        `;
                      },
                    )}
              </div>
            </div>
          `
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-model-picker": ChatModelPicker;
  }
}
