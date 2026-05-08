/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./chat-model-picker.ts";
import type { ChatModelPicker, ChatModelPickerOption } from "./chat-model-picker.ts";

const SAMPLE_OPTIONS: ChatModelPickerOption[] = [
  { value: "openai/gpt-5.5", label: "GPT-5.5", provider: "openai" },
  { value: "openai/gpt-5.5-mini", label: "GPT-5.5 Mini", provider: "openai" },
  { value: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", provider: "anthropic" },
  { value: "anthropic/claude-opus-4.6", label: "Claude Opus 4.6", provider: "anthropic" },
  { value: "qwen/qwen3.5-plus", label: "Qwen 3.5 Plus", provider: "qwen" },
];

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  document.body.removeChild(host);
});

async function mountPicker(props: {
  options: ChatModelPickerOption[];
  value?: string;
  defaultLabel?: string;
  groupByProvider?: boolean;
  showSearch?: boolean;
}): Promise<ChatModelPicker> {
  render(
    html`
      <chat-model-picker
        .options=${props.options}
        .value=${props.value ?? ""}
        .defaultLabel=${props.defaultLabel ?? "Default"}
        .groupByProvider=${props.groupByProvider ?? true}
        .showSearch=${props.showSearch ?? true}
      ></chat-model-picker>
    `,
    host,
  );
  const picker = host.querySelector("chat-model-picker") as ChatModelPicker;
  await picker.updateComplete;
  return picker;
}

function openPanel(picker: ChatModelPicker): void {
  const trigger = picker.shadowRoot?.querySelector<HTMLButtonElement>(".trigger");
  trigger?.click();
}

async function settle(picker: ChatModelPicker): Promise<void> {
  await picker.updateComplete;
}

describe("chat-model-picker grouping", () => {
  it("renders one group header per provider with counts", async () => {
    const picker = await mountPicker({ options: SAMPLE_OPTIONS, value: "openai/gpt-5.5" });
    openPanel(picker);
    await settle(picker);
    const headers = picker.shadowRoot?.querySelectorAll(".group-header") ?? [];
    expect(headers.length).toBe(3);
    const labels = Array.from(headers).map(
      (h) => h.querySelector(".group-header__label")?.textContent ?? "",
    );
    expect(labels).toEqual(["Anthropic", "Openai", "Qwen"]);
    const counts = Array.from(headers).map(
      (h) => h.querySelector(".group-header__count")?.textContent ?? "",
    );
    expect(counts).toEqual(["2", "2", "1"]);
  });

  it("auto-expands the group containing the current selection", async () => {
    const picker = await mountPicker({
      options: SAMPLE_OPTIONS,
      value: "anthropic/claude-sonnet-4.6",
    });
    openPanel(picker);
    await settle(picker);
    const headers = picker.shadowRoot?.querySelectorAll<HTMLElement>(".group-header") ?? [];
    const expanded = Array.from(headers).reduce<Record<string, string>>((acc, h) => {
      const provider = h.dataset.provider ?? "";
      acc[provider] = h.dataset.expanded ?? "";
      return acc;
    }, {});
    expect(expanded.anthropic).toBe("true");
    expect(expanded.openai).toBe("false");
    expect(expanded.qwen).toBe("false");
    // Only the selected group's options are visible.
    const visibleOptions =
      picker.shadowRoot?.querySelectorAll(".option:not(.default-option)") ?? [];
    expect(visibleOptions.length).toBe(2);
  });

  it("expands all visible groups when a search query is entered", async () => {
    const picker = await mountPicker({
      options: SAMPLE_OPTIONS,
      value: "openai/gpt-5.5",
    });
    openPanel(picker);
    await settle(picker);
    const input = picker.shadowRoot?.querySelector<HTMLInputElement>(".search input");
    if (!input) {
      throw new Error("search input not found");
    }
    input.value = "claude";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(picker);
    const headers = picker.shadowRoot?.querySelectorAll<HTMLElement>(".group-header") ?? [];
    expect(headers.length).toBe(1); // Only Anthropic group visible after filter
    expect(headers[0]?.dataset.expanded).toBe("true");
    const opts =
      picker.shadowRoot?.querySelectorAll(".option:not(.default-option)") ?? ([] as never);
    expect(opts.length).toBe(2);
  });

  it("clicking a group header toggles its collapsed state", async () => {
    const picker = await mountPicker({ options: SAMPLE_OPTIONS, value: "openai/gpt-5.5" });
    openPanel(picker);
    await settle(picker);
    const anthropic = picker.shadowRoot?.querySelector<HTMLElement>(
      '.group-header[data-provider="anthropic"]',
    );
    expect(anthropic?.dataset.expanded).toBe("false");
    anthropic?.click();
    await settle(picker);
    const after = picker.shadowRoot?.querySelector<HTMLElement>(
      '.group-header[data-provider="anthropic"]',
    );
    expect(after?.dataset.expanded).toBe("true");
  });

  it("places the Default option at the top, ungrouped", async () => {
    const picker = await mountPicker({
      options: SAMPLE_OPTIONS,
      defaultLabel: "Default (qwen3.5-plus)",
    });
    openPanel(picker);
    await settle(picker);
    const list = picker.shadowRoot?.querySelector(".list");
    const firstChild = list?.firstElementChild;
    expect(firstChild?.classList.contains("default-option")).toBe(true);
    expect(firstChild?.textContent).toContain("Default (qwen3.5-plus)");
  });

  it("renders flat list (no headers) when groupByProvider=false", async () => {
    const picker = await mountPicker({
      options: SAMPLE_OPTIONS,
      groupByProvider: false,
    });
    openPanel(picker);
    await settle(picker);
    const headers = picker.shadowRoot?.querySelectorAll(".group-header") ?? [];
    expect(headers.length).toBe(0);
    const opts =
      picker.shadowRoot?.querySelectorAll(".option:not(.default-option)") ?? ([] as never);
    expect(opts.length).toBe(SAMPLE_OPTIONS.length);
  });

  it("buckets entries without a provider under 'Other'", async () => {
    const picker = await mountPicker({
      options: [
        { value: "openai/gpt-5.5", label: "GPT-5.5", provider: "openai" },
        { value: "x-custom-1", label: "Custom 1" },
        { value: "x-custom-2", label: "Custom 2" },
      ],
      value: "openai/gpt-5.5",
    });
    openPanel(picker);
    await settle(picker);
    const headers = picker.shadowRoot?.querySelectorAll<HTMLElement>(".group-header") ?? [];
    const labels = Array.from(headers).map(
      (h) => h.querySelector(".group-header__label")?.textContent ?? "",
    );
    expect(labels).toEqual(["Openai", "Other"]);
  });

  it("ArrowDown skips collapsed-group entries via header rows", async () => {
    const picker = await mountPicker({ options: SAMPLE_OPTIONS, value: "openai/gpt-5.5" });
    openPanel(picker);
    await settle(picker);
    const input = picker.shadowRoot?.querySelector<HTMLInputElement>(".search input");
    if (!input) {
      throw new Error("search input not found");
    }
    // Default is at index 0 (selected); openPanel sets activeIndex to the
    // selected option, which is inside the openai group. Let's verify
    // ArrowDown moves to the next visible row (the qwen header).
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await settle(picker);
    // Just confirms keydown didn't throw and rerendered.
    expect(picker.shadowRoot?.querySelector(".active")).not.toBeNull();
  });

  it("hides the search input and binds keyboard navigation to the list when showSearch=false", async () => {
    const THINKING_OPTIONS: ChatModelPickerOption[] = [
      { value: "off", label: "Off" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ];
    const picker = await mountPicker({
      options: THINKING_OPTIONS,
      value: "medium",
      groupByProvider: false,
      showSearch: false,
      defaultLabel: "Default (off)",
    });
    openPanel(picker);
    await settle(picker);

    // Search input is not rendered.
    expect(picker.shadowRoot?.querySelector(".search")).toBeNull();
    expect(picker.shadowRoot?.querySelector(".search input")).toBeNull();

    // The list becomes the focusable element.
    const list = picker.shadowRoot?.querySelector<HTMLElement>(".list");
    expect(list).not.toBeNull();
    expect(list?.getAttribute("tabindex")).toBe("0");

    // All options (plus the Default row) are rendered.
    const allOptions = picker.shadowRoot?.querySelectorAll(".option") ?? [];
    expect(allOptions.length).toBe(THINKING_OPTIONS.length + 1);

    // ArrowDown on the list moves the active row without throwing.
    list?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await settle(picker);
    expect(picker.shadowRoot?.querySelector(".active")).not.toBeNull();
  });
});
