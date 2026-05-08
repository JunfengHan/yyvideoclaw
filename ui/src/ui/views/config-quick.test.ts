/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderQuickSettings, type QuickSettingsProps } from "./config-quick.ts";

function findApiKeysCard(container: HTMLElement): HTMLElement {
  const cards = Array.from(container.querySelectorAll<HTMLElement>(".qs-card"));
  const card = cards.find(
    (el) => el.querySelector(".qs-card__title")?.textContent?.trim() === "API Keys",
  );
  if (!card) {
    throw new Error("API Keys card not found in rendered output");
  }
  return card;
}

function createProps(overrides: Partial<QuickSettingsProps> = {}): QuickSettingsProps {
  return {
    currentModel: "gpt-5.5",
    thinkingLevel: "off",
    fastMode: false,
    onModelChange: vi.fn(),
    onThinkingChange: vi.fn(),
    onFastModeToggle: vi.fn(),
    channels: [],
    onChannelConfigure: vi.fn(),
    apiKeys: [],
    onApiKeyChange: vi.fn(),
    automation: {
      cronJobCount: 0,
      skillCount: 0,
      mcpServerCount: 0,
    },
    onManageCron: vi.fn(),
    onBrowseSkills: vi.fn(),
    onConfigureMcp: vi.fn(),
    security: {
      gatewayAuth: "Unknown",
      execPolicy: "Allowlist",
      deviceAuth: true,
    },
    onSecurityConfigure: vi.fn(),
    theme: "claw",
    themeMode: "system",
    borderRadius: 50,
    setTheme: vi.fn(),
    setThemeMode: vi.fn(),
    setBorderRadius: vi.fn(),
    userName: "Val",
    userAvatar: null,
    onUserNameChange: vi.fn(),
    onUserAvatarChange: vi.fn(),
    configObject: {},
    onApplyPreset: vi.fn(),
    onAdvancedSettings: vi.fn(),
    connected: true,
    gatewayUrl: "ws://localhost:18789",
    assistantName: "OpenClaw",
    version: "2026.4.22",
    ...overrides,
  };
}

describe("renderQuickSettings", () => {
  it("uses stacked columns for the compact settings layout", () => {
    const container = document.createElement("div");

    render(renderQuickSettings(createProps()), container);

    expect(container.querySelectorAll(".qs-stack")).toHaveLength(4);
    expect(container.querySelectorAll(".qs-card--span-all")).toHaveLength(1);
  });

  it("rejects oversized avatar uploads before reading them", () => {
    const onUserAvatarChange = vi.fn();
    const fileReader = vi.fn();
    vi.stubGlobal("FileReader", fileReader);

    try {
      const container = document.createElement("div");
      render(renderQuickSettings(createProps({ onUserAvatarChange })), container);

      const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      if (!input) {
        return;
      }

      const file = new File([new Uint8Array(1_500_001)], "avatar.png", { type: "image/png" });
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [file],
      });

      input.dispatchEvent(new Event("change"));

      expect(fileReader).not.toHaveBeenCalled();
      expect(onUserAvatarChange).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe("API Keys card", () => {
    it("renders an Add button in the header that invokes onApiKeyChange with an empty provider", () => {
      const onApiKeyChange = vi.fn();
      const container = document.createElement("div");

      render(renderQuickSettings(createProps({ onApiKeyChange })), container);

      const card = findApiKeysCard(container);
      const header = card.querySelector<HTMLElement>(".qs-card__header");
      expect(header).not.toBeNull();
      const addButton = header?.querySelector<HTMLButtonElement>(".qs-link-btn");
      expect(addButton).not.toBeNull();
      expect(addButton?.textContent?.trim().startsWith("Add")).toBe(true);

      addButton?.click();

      expect(onApiKeyChange).toHaveBeenCalledTimes(1);
      expect(onApiKeyChange).toHaveBeenCalledWith("");
    });

    it("only renders rows for providers whose keys are configured", () => {
      const container = document.createElement("div");

      render(
        renderQuickSettings(
          createProps({
            apiKeys: [
              { provider: "anthropic", label: "Anthropic", masked: "••••abcd", isSet: true },
              { provider: "openai", label: "OpenAI", masked: "••••wxyz", isSet: true },
              { provider: "google", label: "Google", isSet: false },
              { provider: "openrouter", label: "OpenRouter", isSet: false },
            ],
          }),
        ),
        container,
      );

      const card = findApiKeysCard(container);
      const rows = card.querySelectorAll(".qs-card__body .qs-row");
      expect(rows).toHaveLength(2);

      const labels = Array.from(rows).map((row) =>
        row.querySelector(".qs-row__label")?.textContent?.trim(),
      );
      expect(labels).toEqual(["Anthropic", "OpenAI"]);

      // No row-level "Add →" buttons should remain — only Change buttons inside rows.
      const rowButtons = card.querySelectorAll(".qs-card__body .qs-link-btn");
      rowButtons.forEach((btn) => {
        expect(btn.textContent?.trim()).toBe("Change");
      });
    });

    it("shows the empty state when no providers have keys configured", () => {
      const container = document.createElement("div");

      render(
        renderQuickSettings(
          createProps({
            apiKeys: [
              { provider: "google", label: "Google", isSet: false },
              { provider: "openrouter", label: "OpenRouter", isSet: false },
            ],
          }),
        ),
        container,
      );

      const card = findApiKeysCard(container);
      const empty = card.querySelector(".qs-card__body .qs-empty");
      expect(empty).not.toBeNull();
      expect(empty?.textContent?.trim()).toBe("No API keys configured");
      expect(card.querySelectorAll(".qs-card__body .qs-row")).toHaveLength(0);
    });
  });
});
