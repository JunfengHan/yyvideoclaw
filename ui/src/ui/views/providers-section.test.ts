/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { ModelsApiKeysStatusResult } from "../types.ts";
import { renderProvidersSection, type ProvidersSectionProps } from "./providers-section.ts";

function createStatus(
  overrides: Partial<ModelsApiKeysStatusResult> = {},
): ModelsApiKeysStatusResult {
  return {
    ts: 1_700_000_000,
    providers: [
      {
        provider: "openai",
        displayName: "OpenAI",
        isSet: true,
        source: "credentials",
        modelCount: 5,
        masked: "\u2022\u2022\u2022\u2022ABCD",
      },
      {
        provider: "anthropic",
        displayName: "Anthropic",
        isSet: false,
        source: "none",
        modelCount: 0,
      },
      {
        provider: "qwen",
        displayName: "Qwen",
        isSet: true,
        source: "env",
        modelCount: 2,
        masked: "\u2022\u2022\u2022\u2022WXYZ",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
    ],
    ...overrides,
  };
}

function createProps(overrides: Partial<ProvidersSectionProps> = {}): ProvidersSectionProps {
  return {
    status: createStatus(),
    loading: false,
    error: null,
    saving: {},
    errors: {},
    onReload: vi.fn(),
    onSaveApiKey: vi.fn(),
    onSaveBaseUrl: vi.fn(),
    ...overrides,
  };
}

function renderInto(root: HTMLElement, props: ProvidersSectionProps = createProps()): HTMLElement {
  render(renderProvidersSection(props), root);
  return root;
}

describe("renderProvidersSection", () => {
  it("renders one card per provider with correct badge", () => {
    const root = renderInto(document.createElement("div"));
    const cards = root.querySelectorAll(".providers-card");
    expect(cards).toHaveLength(3);

    const openAiCard = root.querySelector<HTMLElement>('[data-provider="openai"]');
    expect(openAiCard).not.toBeNull();
    expect(openAiCard?.querySelector(".providers-badge--ok")?.textContent).toContain("Configured");

    const anthropicCard = root.querySelector<HTMLElement>('[data-provider="anthropic"]');
    expect(anthropicCard?.querySelector(".providers-badge--muted")?.textContent).toContain(
      "Not set",
    );

    const qwenCard = root.querySelector<HTMLElement>('[data-provider="qwen"]');
    expect(qwenCard?.querySelector(".providers-badge--warn")?.textContent).toContain(
      "Inherited from .env",
    );
  });

  it("disables Clear button when key is not set", () => {
    const root = renderInto(document.createElement("div"));
    const anthropicCard = root.querySelector<HTMLElement>('[data-provider="anthropic"]');
    const clearBtn = anthropicCard?.querySelector<HTMLButtonElement>(".providers-btn--danger");
    expect(clearBtn?.disabled).toBe(true);

    const openAiCard = root.querySelector<HTMLElement>('[data-provider="openai"]');
    const clearBtn2 = openAiCard?.querySelector<HTMLButtonElement>(".providers-btn--danger");
    expect(clearBtn2?.disabled).toBe(false);
  });

  it("disables baseUrl Reset when no custom baseUrl is set", () => {
    const root = renderInto(document.createElement("div"));
    const openAiCard = root.querySelector<HTMLElement>('[data-provider="openai"]');
    const resetBtn = openAiCard?.querySelector<HTMLButtonElement>(".providers-btn--ghost");
    expect(resetBtn?.disabled).toBe(true);

    const qwenCard = root.querySelector<HTMLElement>('[data-provider="qwen"]');
    const qwenResetBtn = qwenCard?.querySelector<HTMLButtonElement>(".providers-btn--ghost");
    expect(qwenResetBtn?.disabled).toBe(false);
  });

  it("prefills baseUrl input from status", () => {
    const root = renderInto(document.createElement("div"));
    const qwenInput = root
      .querySelector<HTMLElement>('[data-provider="qwen"]')
      ?.querySelector<HTMLInputElement>('input[data-role="provider-base-url-input"]');
    expect(qwenInput?.value).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });

  it("invokes onSaveApiKey with typed value when Save is clicked", () => {
    const onSaveApiKey = vi.fn();
    const root = renderInto(document.createElement("div"), createProps({ onSaveApiKey }));
    const openAiCard = root.querySelector<HTMLElement>('[data-provider="openai"]');
    const input = openAiCard?.querySelector<HTMLInputElement>(
      'input[data-role="provider-api-key-input"]',
    );
    const saveBtn = openAiCard?.querySelector<HTMLButtonElement>(".providers-btn--primary");
    if (!input || !saveBtn) {
      throw new Error("required elements missing");
    }
    input.value = "sk-new-XXYY";
    saveBtn.click();
    expect(onSaveApiKey).toHaveBeenCalledWith("openai", "sk-new-XXYY");
  });

  it("does not invoke onSaveApiKey when input is empty", () => {
    const onSaveApiKey = vi.fn();
    const root = renderInto(document.createElement("div"), createProps({ onSaveApiKey }));
    const saveBtn = root
      .querySelector<HTMLElement>('[data-provider="openai"]')
      ?.querySelector<HTMLButtonElement>(".providers-btn--primary");
    saveBtn?.click();
    expect(onSaveApiKey).not.toHaveBeenCalled();
  });

  it("invokes onSaveApiKey(provider, null) when Clear is clicked", () => {
    const onSaveApiKey = vi.fn();
    const root = renderInto(document.createElement("div"), createProps({ onSaveApiKey }));
    const clearBtn = root
      .querySelector<HTMLElement>('[data-provider="openai"]')
      ?.querySelector<HTMLButtonElement>(".providers-btn--danger");
    clearBtn?.click();
    expect(onSaveApiKey).toHaveBeenCalledWith("openai", null);
  });

  it("invokes onSaveBaseUrl with trimmed string on Save URL", () => {
    const onSaveBaseUrl = vi.fn();
    const root = renderInto(document.createElement("div"), createProps({ onSaveBaseUrl }));
    const openAiCard = root.querySelector<HTMLElement>('[data-provider="openai"]');
    const urlInput = openAiCard?.querySelector<HTMLInputElement>(
      'input[data-role="provider-base-url-input"]',
    );
    const saveUrlBtn = openAiCard?.querySelector<HTMLButtonElement>(".providers-btn--secondary");
    if (!urlInput || !saveUrlBtn) {
      throw new Error("required elements missing");
    }
    urlInput.value = "  https://example.test/v1  ";
    saveUrlBtn.click();
    expect(onSaveBaseUrl).toHaveBeenCalledWith("openai", "https://example.test/v1");
  });

  it("invokes onSaveBaseUrl(provider, null) to reset", () => {
    const onSaveBaseUrl = vi.fn();
    const root = renderInto(document.createElement("div"), createProps({ onSaveBaseUrl }));
    const resetBtn = root
      .querySelector<HTMLElement>('[data-provider="qwen"]')
      ?.querySelector<HTMLButtonElement>(".providers-btn--ghost");
    resetBtn?.click();
    expect(onSaveBaseUrl).toHaveBeenCalledWith("qwen", null);
  });

  it("disables controls while saving", () => {
    const root = renderInto(
      document.createElement("div"),
      createProps({ saving: { openai: true } }),
    );
    const openAiCard = root.querySelector<HTMLElement>('[data-provider="openai"]');
    const input = openAiCard?.querySelector<HTMLInputElement>(
      'input[data-role="provider-api-key-input"]',
    );
    expect(input?.disabled).toBe(true);
    const saveBtn = openAiCard?.querySelector<HTMLButtonElement>(".providers-btn--primary");
    expect(saveBtn?.disabled).toBe(true);
  });

  it("surfaces per-provider error below the card", () => {
    const root = renderInto(
      document.createElement("div"),
      createProps({ errors: { openai: "server rejected" } }),
    );
    const openAiErr = root
      .querySelector<HTMLElement>('[data-provider="openai"]')
      ?.querySelector(".providers-card__error");
    expect(openAiErr?.textContent).toContain("server rejected");
  });

  it("renders empty-state when status is null", () => {
    const root = renderInto(document.createElement("div"), createProps({ status: null }));
    expect(root.querySelector(".providers-empty")).not.toBeNull();
    expect(root.querySelectorAll(".providers-card")).toHaveLength(0);
  });

  it("shows a banner when the top-level error is set", () => {
    const root = renderInto(
      document.createElement("div"),
      createProps({ error: "gateway unreachable" }),
    );
    const banner = root.querySelector(".providers-section__banner");
    expect(banner?.textContent).toContain("gateway unreachable");
  });
});
