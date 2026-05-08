import { describe, expect, it } from "vitest";
import {
  resolveChatModelOverrideValue,
  resolveChatModelSelectState,
} from "./chat-model-select-state.ts";
import {
  createModelCatalog,
  createSessionsListResult,
  DEEPSEEK_CHAT_MODEL,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "./chat-model.test-helpers.ts";

type ChatModelStateInput = Parameters<typeof resolveChatModelSelectState>[0];
type ResolvedChatModelState = ReturnType<typeof resolveChatModelSelectState>;

function createChatModelState(
  params: Partial<Omit<ChatModelStateInput, "sessionKey">> = {},
): ChatModelStateInput {
  return {
    sessionKey: "main",
    chatModelOverrides: {},
    chatModelCatalog: [],
    sessionsResult: createSessionsListResult({ model: null, modelProvider: null }),
    ...params,
  };
}

function expectOptionValues(
  resolved: ResolvedChatModelState,
  params: { include?: string[]; exclude?: string[] },
) {
  const values = resolved.options.map((option) => option.value);
  for (const value of params.include ?? []) {
    expect(values).toContain(value);
  }
  for (const value of params.exclude ?? []) {
    expect(values).not.toContain(value);
  }
}

describe("chat-model-select-state", () => {
  it("uses the server-qualified value when the active session provider is present", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(DEEPSEEK_CHAT_MODEL),
      sessionsResult: createSessionsListResult({
        model: "deepseek-chat",
        modelProvider: "deepseek",
      }),
    });

    expect(resolveChatModelOverrideValue(state)).toBe("deepseek/deepseek-chat");
  });

  it("falls back to the server-qualified value when catalog lookup fails", () => {
    const state = createChatModelState({
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
      }),
    });

    expect(resolveChatModelOverrideValue(state)).toBe("openai/gpt-5-mini");
  });

  it("normalizes cached bare overrides to the matching catalog option", () => {
    const state = createChatModelState({
      chatModelOverrides: { main: { kind: "raw", value: "gpt-5-mini" } },
      chatModelCatalog: createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expectOptionValues(resolved, { include: ["openai/gpt-5-mini"], exclude: ["gpt-5-mini"] });
  });

  it("prefers catalog provider matches over stale session providers", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(DEEPSEEK_CHAT_MODEL),
      sessionsResult: createSessionsListResult({
        model: "deepseek-chat",
        modelProvider: "zai",
      }),
    });

    expect(resolveChatModelSelectState(state).currentOverride).toBe("deepseek/deepseek-chat");
  });

  it("preserves already-qualified active-session models when the provider is stale and the catalog is empty", () => {
    const state = createChatModelState({
      sessionsResult: createSessionsListResult({
        model: "openai/gpt-5-mini",
        modelProvider: "zai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expectOptionValues(resolved, {
      include: ["openai/gpt-5-mini"],
      exclude: ["zai/openai/gpt-5-mini"],
    });
  });

  it("builds picker options without introducing a bare duplicate", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG),
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expectOptionValues(resolved, { include: ["openai/gpt-5-mini"], exclude: ["gpt-5-mini"] });
  });

  it("uses catalog names for the default label and matching picker options", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog({
        id: "moonshotai/kimi-k2.5",
        alias: "Kimi K2.5 (NVIDIA)",
        name: "Kimi K2.5 (NVIDIA)",
        provider: "nvidia",
      }),
      sessionsResult: createSessionsListResult({
        model: "moonshotai/kimi-k2.5",
        modelProvider: "nvidia",
        defaultsModel: "moonshotai/kimi-k2.5",
        defaultsProvider: "nvidia",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("nvidia/moonshotai/kimi-k2.5");
    expect(resolved.defaultLabel).toBe("Default (Kimi K2.5 (NVIDIA))");
    expect(resolved.options).toContainEqual({
      value: "nvidia/moonshotai/kimi-k2.5",
      label: "Kimi K2.5 (NVIDIA)",
      provider: "nvidia",
    });
  });

  it("disambiguates duplicate friendly names in picker options and default labels", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "claude-3-7-sonnet",
          name: "Claude Sonnet",
          provider: "anthropic",
        },
        {
          id: "claude-3-7-sonnet",
          name: "Claude Sonnet",
          provider: "openrouter",
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "claude-3-7-sonnet",
        modelProvider: "anthropic",
        defaultsModel: "claude-3-7-sonnet",
        defaultsProvider: "openrouter",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("anthropic/claude-3-7-sonnet");
    expect(resolved.defaultLabel).toBe("Default (Claude Sonnet · openrouter)");
    expect(resolved.options).toContainEqual({
      value: "anthropic/claude-3-7-sonnet",
      label: "Claude Sonnet · anthropic",
      provider: "anthropic",
    });
    expect(resolved.options).toContainEqual({
      value: "openrouter/claude-3-7-sonnet",
      label: "Claude Sonnet · openrouter",
      provider: "openrouter",
    });
  });

  it("falls back to id and provider when duplicate names share the same provider", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "claude-3-7-sonnet",
          name: "Claude Sonnet",
          provider: "anthropic",
        },
        {
          id: "claude-3-7-sonnet-thinking",
          name: "Claude Sonnet",
          provider: "anthropic",
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "claude-3-7-sonnet",
        modelProvider: "anthropic",
        defaultsModel: "claude-3-7-sonnet-thinking",
        defaultsProvider: "anthropic",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("anthropic/claude-3-7-sonnet");
    expect(resolved.defaultLabel).toBe(
      "Default (Claude Sonnet · claude-3-7-sonnet-thinking · anthropic)",
    );
    expect(resolved.options).toContainEqual({
      value: "anthropic/claude-3-7-sonnet",
      label: "Claude Sonnet · claude-3-7-sonnet · anthropic",
      provider: "anthropic",
    });
    expect(resolved.options).toContainEqual({
      value: "anthropic/claude-3-7-sonnet-thinking",
      label: "Claude Sonnet · claude-3-7-sonnet-thinking · anthropic",
      provider: "anthropic",
    });
  });

  describe("provider api-key filtering", () => {
    it("filters catalog options to providers whose API key is configured", () => {
      const state = createChatModelState({
        chatModelCatalog: createModelCatalog(
          { id: "gpt-5", name: "GPT-5", provider: "openai" },
          { id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek" },
          { id: "qwen3.5-plus", name: "Qwen 3.5 Plus", provider: "qwen" },
        ),
        sessionsResult: createSessionsListResult({
          model: "gpt-5",
          modelProvider: "openai",
        }),
        providerApiKeyStatus: {
          ts: 1,
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              isSet: true,
              source: "credentials",
              modelCount: 1,
            },
            {
              provider: "qwen",
              displayName: "Qwen",
              isSet: true,
              source: "credentials",
              modelCount: 1,
            },
            {
              provider: "deepseek",
              displayName: "DeepSeek",
              isSet: false,
              source: "none",
              modelCount: 1,
            },
          ],
        },
      });

      const resolved = resolveChatModelSelectState(state);
      expectOptionValues(resolved, {
        include: ["openai/gpt-5", "qwen/qwen3.5-plus"],
        exclude: ["deepseek/deepseek-chat"],
      });
    });

    it("preserves the currently selected option even if its provider has no key", () => {
      const state = createChatModelState({
        chatModelCatalog: createModelCatalog(
          { id: "gpt-5", name: "GPT-5", provider: "openai" },
          { id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek" },
        ),
        sessionsResult: createSessionsListResult({
          model: "deepseek-chat",
          modelProvider: "deepseek",
        }),
        providerApiKeyStatus: {
          ts: 1,
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              isSet: true,
              source: "credentials",
              modelCount: 1,
            },
            {
              provider: "deepseek",
              displayName: "DeepSeek",
              isSet: false,
              source: "none",
              modelCount: 1,
            },
          ],
        },
      });

      const resolved = resolveChatModelSelectState(state);
      expect(resolved.currentOverride).toBe("deepseek/deepseek-chat");
      expectOptionValues(resolved, {
        include: ["openai/gpt-5", "deepseek/deepseek-chat"],
      });
    });

    it("does not filter when providerApiKeyStatus is null (snapshot not loaded yet)", () => {
      const state = createChatModelState({
        chatModelCatalog: createModelCatalog(
          { id: "gpt-5", name: "GPT-5", provider: "openai" },
          { id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek" },
        ),
        sessionsResult: createSessionsListResult({
          model: "gpt-5",
          modelProvider: "openai",
        }),
        providerApiKeyStatus: null,
      });

      const resolved = resolveChatModelSelectState(state);
      expectOptionValues(resolved, {
        include: ["openai/gpt-5", "deepseek/deepseek-chat"],
      });
    });
  });
});
