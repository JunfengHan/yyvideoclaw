import { LitElement, css, html, nothing } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";

export interface ChatModelPickerOption {
  value: string;
  label: string;
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

  @state() private open = false;
  @state() private query = "";
  @state() private activeIndex = 0;
  @state() private panelStyle = "";

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
    // Default active index = current selection index (if visible), else 0.
    const entries = this.filteredEntries;
    const selectedIdx = entries.findIndex((entry) => entry.value === this.value);
    this.activeIndex = selectedIdx >= 0 ? selectedIdx : 0;
    // Position after render.
    queueMicrotask(() => {
      this.updatePanelPosition();
      this.searchInputEl?.focus();
      this.searchInputEl?.select();
    });
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
    this.activeIndex = 0;
  }

  private onSearchKeydown(event: KeyboardEvent) {
    const entries = this.filteredEntries;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (entries.length === 0) return;
      this.activeIndex = (this.activeIndex + 1) % entries.length;
      this.scrollActiveIntoView();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (entries.length === 0) return;
      this.activeIndex = (this.activeIndex - 1 + entries.length) % entries.length;
      this.scrollActiveIntoView();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = entries[this.activeIndex];
      if (entry) this.commitSelection(entry.value);
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
      const active = list?.querySelector(".option.active") as HTMLElement | null;
      active?.scrollIntoView({ block: "nearest" });
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
    const entries = this.filteredEntries;
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
              <div class="search">
                <input
                  type="text"
                  spellcheck="false"
                  autocomplete="off"
                  placeholder=${this.placeholder}
                  .value=${this.query}
                  @input=${this.onSearchInput}
                  @keydown=${this.onSearchKeydown}
                />
              </div>
              <div class="list" role="listbox">
                ${entries.length === 0
                  ? html`<div class="empty">No matches</div>`
                  : repeat(
                      entries,
                      (entry) => entry.value || "__default__",
                      (entry, index) => html`
                        <div
                          class="option
                            ${entry.value === this.value ? " selected" : ""}
                            ${index === this.activeIndex ? " active" : ""}"
                          role="option"
                          aria-selected=${entry.value === this.value ? "true" : "false"}
                          title=${entry.label}
                          @mouseenter=${() => (this.activeIndex = index)}
                          @click=${() => this.commitSelection(entry.value)}
                        >
                          ${entry.label}
                        </div>
                      `,
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
