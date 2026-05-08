import { describe, expect, it } from "vitest";
import { __testInternals } from "./app-render.ts";
import type { AppViewState } from "./app-view-state.ts";

const { extractQuickSettingsApiKeys } = __testInternals;

function createState(overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    providerApiKeyStatus: null,
    configForm: null,
    configSnapshot: null,
    ...overrides,
  } as unknown as AppViewState;
}

describe("extractQuickSettingsApiKeys", () => {
  it("uses providerApiKeyStatus snapshot when available", () => {
    const state = createState({
      providerApiKeyStatus: {
        ts: 1,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            isSet: true,
            source: "credentials",
            modelCount: 3,
            masked: "\u2022\u2022\u2022\u20221234",
          },
          {
            provider: "anthropic",
            displayName: "Anthropic",
            isSet: false,
            source: "none",
            modelCount: 0,
          },
        ],
      },
    });
    const out = extractQuickSettingsApiKeys(state);
    const openai = out.find((row) => row.provider === "openai");
    const anthropic = out.find((row) => row.provider === "anthropic");
    expect(openai?.isSet).toBe(true);
    expect(openai?.masked).toBe("\u2022\u2022\u2022\u20221234");
    expect(anthropic?.isSet).toBe(false);
    expect(anthropic?.masked).toBeUndefined();
  });

  it("falls back to env.vars when providerApiKeyStatus is null", () => {
    const state = createState({
      configForm: {
        env: {
          vars: {
            OPENAI_API_KEY: "sk-test-FALLBACK1234",
          },
        },
      } as unknown as Record<string, unknown>,
    });
    const out = extractQuickSettingsApiKeys(state);
    const openai = out.find((row) => row.provider === "openai");
    expect(openai?.isSet).toBe(true);
    expect(openai?.masked).toBe("\u2022\u2022\u2022\u20221234");
  });

  it("reports not-set when neither snapshot nor env have the key", () => {
    const state = createState();
    const out = extractQuickSettingsApiKeys(state);
    expect(out.length).toBeGreaterThan(0);
    for (const row of out) {
      expect(row.isSet).toBe(false);
      expect(row.masked).toBeUndefined();
    }
  });

  it("falls through to env when providerApiKeyStatus is empty", () => {
    const state = createState({
      providerApiKeyStatus: { ts: 1, providers: [] },
      configForm: {
        env: { vars: { OPENAI_API_KEY: "sk-fallback-EFEF" } },
      } as unknown as Record<string, unknown>,
    });
    const out = extractQuickSettingsApiKeys(state);
    const openai = out.find((row) => row.provider === "openai");
    expect(openai?.isSet).toBe(true);
    expect(openai?.masked).toBe("\u2022\u2022\u2022\u2022EFEF");
  });

  it("surfaces providers outside the built-in whitelist (e.g. Qwen) using displayName", () => {
    const state = createState({
      providerApiKeyStatus: {
        ts: 1,
        providers: [
          {
            provider: "qwen",
            displayName: "Qwen",
            isSet: true,
            source: "credentials",
            modelCount: 9,
            masked: "\u2022\u2022\u2022\u2022abcd",
          },
        ],
      },
    });
    const out = extractQuickSettingsApiKeys(state);
    const qwen = out.find((row) => row.provider === "qwen");
    expect(qwen).toBeDefined();
    expect(qwen?.label).toBe("Qwen");
    expect(qwen?.isSet).toBe(true);
    expect(qwen?.masked).toBe("\u2022\u2022\u2022\u2022abcd");
  });
});
