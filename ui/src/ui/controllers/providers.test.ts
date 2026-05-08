import { describe, expect, it, vi } from "vitest";
import type { ModelsApiKeysSetResult, ModelsApiKeysStatusResult } from "../types.ts";
import {
  loadProviderApiKeyStatusState,
  saveProviderApiKey,
  saveProviderBaseUrl,
  type ProviderApiKeysState,
} from "./providers.ts";

function createState(
  overrides: Partial<ProviderApiKeysState> & {
    request?: ReturnType<typeof vi.fn>;
  } = {},
): ProviderApiKeysState {
  const request = overrides.request ?? vi.fn();
  return {
    client: { request } as unknown as ProviderApiKeysState["client"],
    connected: true,
    providerApiKeyStatus: null,
    providerApiKeyStatusLoading: false,
    providerApiKeyStatusError: null,
    providerApiKeySaving: {},
    providerApiKeyErrors: {},
    configSnapshot: { hash: "hash-1" },
    applySessionKey: "main",
    lastError: null,
    ...overrides,
  };
}

function sampleStatus(
  overrides: Partial<ModelsApiKeysStatusResult> = {},
): ModelsApiKeysStatusResult {
  return {
    ts: 1_700_000_000,
    providers: [
      {
        provider: "openai",
        displayName: "OpenAI",
        isSet: false,
        source: "none",
        modelCount: 3,
      },
    ],
    ...overrides,
  };
}

describe("loadProviderApiKeyStatusState", () => {
  it("no-ops when disconnected", async () => {
    const request = vi.fn();
    const state = createState({ connected: false, request });
    await loadProviderApiKeyStatusState(state);
    expect(request).not.toHaveBeenCalled();
    expect(state.providerApiKeyStatus).toBeNull();
  });

  it("populates status and clears error on success", async () => {
    const expected = sampleStatus();
    const request = vi.fn().mockResolvedValue(expected);
    const state = createState({
      request,
      providerApiKeyStatusError: "prior failure",
    });
    await loadProviderApiKeyStatusState(state);
    expect(request).toHaveBeenCalledWith("models.apiKeys.status", {});
    expect(state.providerApiKeyStatus).toEqual(expected);
    expect(state.providerApiKeyStatusError).toBeNull();
    expect(state.providerApiKeyStatusLoading).toBe(false);
  });

  it("records error and uses empty fallback on failure", async () => {
    const request = vi.fn().mockRejectedValue(new Error("boom"));
    const state = createState({ request });
    await loadProviderApiKeyStatusState(state);
    expect(state.providerApiKeyStatusError).toBe("boom");
    expect(state.providerApiKeyStatus?.providers).toEqual([]);
    expect(state.providerApiKeyStatusLoading).toBe(false);
  });

  it("skips re-entry when a load is already in flight", async () => {
    const request = vi.fn();
    const state = createState({ request, providerApiKeyStatusLoading: true });
    await loadProviderApiKeyStatusState(state);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("saveProviderApiKey", () => {
  it("sends apiKey to models.apiKeys.set and patches status row on success", async () => {
    const next = {
      provider: "openai",
      displayName: "OpenAI",
      isSet: true,
      source: "credentials" as const,
      modelCount: 3,
      masked: "\u2022\u2022\u2022\u20221234",
    };
    const setResult: ModelsApiKeysSetResult = { ok: true, provider: "openai", status: next };
    const request = vi.fn().mockResolvedValue(setResult);
    const state = createState({ request, providerApiKeyStatus: sampleStatus() });
    const ok = await saveProviderApiKey(state, { provider: "openai", apiKey: "sk-live-1234" });
    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith("models.apiKeys.set", {
      provider: "openai",
      apiKey: "sk-live-1234",
    });
    const row = state.providerApiKeyStatus?.providers.find((r) => r.provider === "openai");
    expect(row).toEqual(next);
    expect(state.providerApiKeySaving.openai).toBe(false);
    expect(state.providerApiKeyErrors.openai).toBeNull();
  });

  it("clears apiKey when null", async () => {
    const next = {
      provider: "openai",
      displayName: "OpenAI",
      isSet: false,
      source: "none" as const,
      modelCount: 0,
    };
    const request = vi
      .fn()
      .mockResolvedValue({ ok: true, provider: "openai", status: next } as ModelsApiKeysSetResult);
    const state = createState({ request });
    const ok = await saveProviderApiKey(state, { provider: "openai", apiKey: null });
    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith("models.apiKeys.set", {
      provider: "openai",
      apiKey: null,
    });
  });

  it("records per-provider error on failure and surfaces lastError", async () => {
    const request = vi.fn().mockRejectedValue(new Error("no agent dir"));
    const state = createState({ request });
    const ok = await saveProviderApiKey(state, { provider: "openai", apiKey: "x" });
    expect(ok).toBe(false);
    expect(state.providerApiKeyErrors.openai).toBe("no agent dir");
    expect(state.lastError).toBe("no agent dir");
    expect(state.providerApiKeySaving.openai).toBe(false);
  });

  it("falls back to full reload when server response omits status", async () => {
    const reloadSnapshot = sampleStatus({
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          isSet: true,
          source: "credentials",
          modelCount: 3,
        },
      ],
    });
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "models.apiKeys.set") {
        return { ok: true, provider: "openai" };
      }
      if (method === "models.apiKeys.status") {
        return reloadSnapshot;
      }
      throw new Error(`unexpected method ${method}`);
    });
    const state = createState({ request });
    const ok = await saveProviderApiKey(state, { provider: "openai", apiKey: "sk" });
    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith("models.apiKeys.status", {});
    expect(state.providerApiKeyStatus).toEqual(reloadSnapshot);
  });
});

describe("saveProviderBaseUrl", () => {
  it("writes baseUrl via config.patch and reloads status", async () => {
    const reloadSnapshot = sampleStatus({
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          isSet: false,
          source: "none",
          modelCount: 2,
          baseUrl: "https://example.test/v1",
        },
      ],
    });
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "config.patch") {
        return { ok: true };
      }
      if (method === "models.apiKeys.status") {
        return reloadSnapshot;
      }
      throw new Error(`unexpected method ${method}`);
    });
    const state = createState({ request });
    const ok = await saveProviderBaseUrl(state, {
      provider: "openai",
      baseUrl: "https://example.test/v1",
    });
    expect(ok).toBe(true);
    const patchCall = request.mock.calls.find((call) => call[0] === "config.patch");
    expect(patchCall).toBeDefined();
    const patchParams = patchCall?.[1] as { baseHash: string; raw: string; sessionKey: string };
    expect(patchParams.baseHash).toBe("hash-1");
    expect(patchParams.sessionKey).toBe("main");
    expect(JSON.parse(patchParams.raw)).toEqual({
      models: {
        providers: {
          openai: { baseUrl: "https://example.test/v1" },
        },
      },
    });
    const row = state.providerApiKeyStatus?.providers.find((r) => r.provider === "openai");
    expect(row?.baseUrl).toBe("https://example.test/v1");
  });

  it("writes baseUrl: null to reset when value is empty", async () => {
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "config.patch") {
        return { ok: true };
      }
      if (method === "models.apiKeys.status") {
        return sampleStatus();
      }
      throw new Error(`unexpected method ${method}`);
    });
    const state = createState({ request });
    await saveProviderBaseUrl(state, { provider: "openai", baseUrl: "   " });
    const patchCall = request.mock.calls.find((call) => call[0] === "config.patch");
    expect(patchCall).toBeDefined();
    const parsed = JSON.parse((patchCall?.[1] as { raw: string }).raw) as {
      models: { providers: Record<string, { baseUrl: unknown }> };
    };
    expect(parsed.models.providers.openai.baseUrl).toBeNull();
  });

  it("fails loudly when configSnapshot.hash is missing", async () => {
    const request = vi.fn();
    const state = createState({ request, configSnapshot: null });
    const ok = await saveProviderBaseUrl(state, {
      provider: "openai",
      baseUrl: "https://example.test/v1",
    });
    expect(ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(state.providerApiKeyErrors.openai).toMatch(/hash/i);
  });
});
