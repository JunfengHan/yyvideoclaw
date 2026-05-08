import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn<() => OpenClawConfig>(),
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/agent"),
  ensureAuthProfileStore: vi.fn<() => AuthProfileStore>(),
  loadAuthProfileStore: vi.fn<() => AuthProfileStore>(),
  upsertAuthProfileWithLock: vi.fn(async () => null),
  removeProviderAuthProfilesWithLock: vi.fn(async () => null),
  listProfilesForProvider: vi.fn<(store: AuthProfileStore, provider: string) => string[]>(),
  invalidateModelAuthStatusCache: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: mocks.resolveOpenClawAgentDir,
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  loadAuthProfileStore: mocks.loadAuthProfileStore,
}));

vi.mock("../../agents/auth-profiles/profiles.js", () => ({
  upsertAuthProfileWithLock: mocks.upsertAuthProfileWithLock,
  removeProviderAuthProfilesWithLock: mocks.removeProviderAuthProfilesWithLock,
  listProfilesForProvider: mocks.listProfilesForProvider,
}));

vi.mock("./models-auth-status.js", () => ({
  invalidateModelAuthStatusCache: mocks.invalidateModelAuthStatusCache,
}));

import {
  modelsApiKeysHandlers,
  type ModelsApiKeysSetResult,
  type ModelsApiKeysStatusResult,
  __test,
} from "./models-api-keys.js";

const BULLET_PREFIX = "\u2022\u2022\u2022\u2022";

const statusHandler = modelsApiKeysHandlers["models.apiKeys.status"];
const setHandler = modelsApiKeysHandlers["models.apiKeys.set"];

function emptyStore(): AuthProfileStore {
  return { version: 1, profiles: {} };
}

function emptyConfig(): OpenClawConfig {
  return {} as OpenClawConfig;
}

function createStatusOptions(params: Record<string, unknown> = {}) {
  const respond = vi.fn();
  const loadGatewayModelCatalog = vi.fn(async () => []);
  return {
    respond,
    loadGatewayModelCatalog,
    options: {
      req: { type: "req", id: "req-1", method: "models.apiKeys.status", params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: { loadGatewayModelCatalog } as unknown,
    } as unknown as GatewayRequestHandlerOptions,
  };
}

function createSetOptions(params: Record<string, unknown>) {
  const respond = vi.fn();
  const loadGatewayModelCatalog = vi.fn(async () => []);
  return {
    respond,
    loadGatewayModelCatalog,
    options: {
      req: { type: "req", id: "req-2", method: "models.apiKeys.set", params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: { loadGatewayModelCatalog } as unknown,
    } as unknown as GatewayRequestHandlerOptions,
  };
}

const PROVIDER_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "DASHSCOPE_API_KEY",
  "XAI_API_KEY",
];

describe("models.apiKeys.status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue(emptyConfig());
    mocks.ensureAuthProfileStore.mockReturnValue(emptyStore());
    mocks.listProfilesForProvider.mockReturnValue([]);
    for (const key of PROVIDER_ENV_KEYS) {
      delete process.env[key];
    }
  });

  it("returns builtin providers with source=none when nothing is configured", async () => {
    const { options, respond } = createStatusOptions();
    await statusHandler(options);
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload, err] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(err).toBeUndefined();
    const result = payload as ModelsApiKeysStatusResult;
    const providers = result.providers.map((p) => p.provider);
    expect(providers).toEqual(expect.arrayContaining(["openai", "anthropic", "qwen"]));
    for (const row of result.providers) {
      expect(row.isSet).toBe(false);
      expect(row.source).toBe("none");
      expect(row.masked).toBeUndefined();
    }
  });

  it("prefers credentials over config and env (priority ordering)", async () => {
    process.env.OPENAI_API_KEY = "sk-env-LAST";
    const cfg = {
      models: {
        providers: {
          openai: { apiKey: "sk-cfg-ZZZZ", baseUrl: "https://example.test/v1" },
        },
      },
    } as unknown as OpenClawConfig;
    mocks.loadConfig.mockReturnValue(cfg);
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "sk-creds-ABCD" },
      },
    };
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    mocks.listProfilesForProvider.mockImplementation((_s, p) =>
      p === "openai" ? ["openai:default"] : [],
    );

    const { options, respond } = createStatusOptions();
    await statusHandler(options);

    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    const row = (payload as ModelsApiKeysStatusResult).providers.find(
      (r) => r.provider === "openai",
    );
    expect(row).toBeDefined();
    expect(row?.source).toBe("credentials");
    expect(row?.isSet).toBe(true);
    expect(row?.masked).toBe(`${BULLET_PREFIX}ABCD`);
    expect(row?.baseUrl).toBe("https://example.test/v1");
  });

  it("falls back to config apiKey when credentials are empty", async () => {
    const cfg = {
      models: {
        providers: {
          anthropic: { apiKey: "sk-ant-cfg-WXYZ" },
        },
      },
    } as unknown as OpenClawConfig;
    mocks.loadConfig.mockReturnValue(cfg);

    const { options, respond } = createStatusOptions();
    await statusHandler(options);

    const row = (respond.mock.calls[0][1] as ModelsApiKeysStatusResult).providers.find(
      (r) => r.provider === "anthropic",
    );
    expect(row?.source).toBe("config");
    expect(row?.masked).toBe(`${BULLET_PREFIX}WXYZ`);
  });

  it("falls back to process.env when neither credentials nor config apiKey are set", async () => {
    process.env.GEMINI_API_KEY = "gemini-abcdEFGH";
    const { options, respond } = createStatusOptions();
    await statusHandler(options);

    const row = (respond.mock.calls[0][1] as ModelsApiKeysStatusResult).providers.find(
      (r) => r.provider === "google",
    );
    expect(row?.source).toBe("env");
    expect(row?.isSet).toBe(true);
    expect(row?.masked).toBe(`${BULLET_PREFIX}EFGH`);
  });

  it("exposes baseUrl and modelCount from runtime catalog", async () => {
    const cfg = {
      models: {
        providers: {
          qwen: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
        },
      },
    } as unknown as OpenClawConfig;
    mocks.loadConfig.mockReturnValue(cfg);

    const { options, respond, loadGatewayModelCatalog } = createStatusOptions();
    loadGatewayModelCatalog.mockResolvedValueOnce([
      { provider: "qwen" },
      { provider: "qwen" },
      { provider: "qwen" },
      { provider: "openai" },
    ] as never);

    await statusHandler(options);
    const result = respond.mock.calls[0][1] as ModelsApiKeysStatusResult;
    const qwen = result.providers.find((r) => r.provider === "qwen");
    expect(qwen?.modelCount).toBe(3);
    expect(qwen?.baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    const openai = result.providers.find((r) => r.provider === "openai");
    expect(openai?.modelCount).toBe(1);
  });

  it("surfaces providers declared in openclaw.json even if not builtin", async () => {
    const cfg = {
      models: {
        providers: {
          mycustom: { baseUrl: "https://example.test/api" },
        },
      },
    } as unknown as OpenClawConfig;
    mocks.loadConfig.mockReturnValue(cfg);

    const { options, respond } = createStatusOptions();
    await statusHandler(options);

    const row = (respond.mock.calls[0][1] as ModelsApiKeysStatusResult).providers.find(
      (r) => r.provider === "mycustom",
    );
    expect(row).toBeDefined();
    expect(row?.source).toBe("none");
    expect(row?.baseUrl).toBe("https://example.test/api");
  });

  it("respects normalized provider aliases (modelstudio -> qwen)", async () => {
    const cfg = {
      models: {
        providers: {
          modelstudio: { apiKey: "sk-ali-TEST" },
        },
      },
    } as unknown as OpenClawConfig;
    mocks.loadConfig.mockReturnValue(cfg);

    const { options, respond } = createStatusOptions();
    await statusHandler(options);

    const providers = (respond.mock.calls[0][1] as ModelsApiKeysStatusResult).providers;
    const qwenRows = providers.filter((r) => r.provider === "qwen" || r.provider === "modelstudio");
    // De-dup: only one qwen-normalized row regardless of spelling.
    expect(qwenRows.length).toBe(1);
    expect(qwenRows[0].source).toBe("config");
  });
});

describe("models.apiKeys.set", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue(emptyConfig());
    mocks.ensureAuthProfileStore.mockReturnValue(emptyStore());
    mocks.listProfilesForProvider.mockReturnValue([]);
    for (const key of PROVIDER_ENV_KEYS) {
      delete process.env[key];
    }
  });

  it("rejects missing provider", async () => {
    const { options, respond } = createSetOptions({});
    await setHandler(options);
    const [ok, , err] = respond.mock.calls[0];
    expect(ok).toBe(false);
    expect(err?.code).toBe("INVALID_REQUEST");
  });

  it("rejects non-string apiKey", async () => {
    const { options, respond } = createSetOptions({ provider: "openai", apiKey: 123 });
    await setHandler(options);
    const [ok, , err] = respond.mock.calls[0];
    expect(ok).toBe(false);
    expect(err?.code).toBe("INVALID_REQUEST");
  });

  it("stores api_key credential via upsertAuthProfileWithLock", async () => {
    const { options, respond } = createSetOptions({
      provider: "openai",
      apiKey: "sk-live-TEST-1234",
    });
    await setHandler(options);
    expect(mocks.upsertAuthProfileWithLock).toHaveBeenCalledTimes(1);
    const call = mocks.upsertAuthProfileWithLock.mock.calls[0]?.[0];
    expect(call?.profileId).toBe("openai:default");
    expect(call?.credential).toMatchObject({
      type: "api_key",
      provider: "openai",
      key: "sk-live-TEST-1234",
    });
    expect(mocks.invalidateModelAuthStatusCache).toHaveBeenCalledTimes(1);
    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect((payload as ModelsApiKeysSetResult).provider).toBe("openai");
  });

  it("clears the provider when apiKey is null or empty", async () => {
    for (const value of [null, ""]) {
      mocks.removeProviderAuthProfilesWithLock.mockClear();
      mocks.upsertAuthProfileWithLock.mockClear();
      const { options } = createSetOptions({ provider: "anthropic", apiKey: value });
      await setHandler(options);
      expect(mocks.removeProviderAuthProfilesWithLock).toHaveBeenCalledWith({
        provider: "anthropic",
        agentDir: "/tmp/agent",
      });
      expect(mocks.upsertAuthProfileWithLock).not.toHaveBeenCalled();
    }
  });

  it("no-ops credentials store when apiKey is undefined", async () => {
    const { options, respond } = createSetOptions({ provider: "openai" });
    await setHandler(options);
    expect(mocks.upsertAuthProfileWithLock).not.toHaveBeenCalled();
    expect(mocks.removeProviderAuthProfilesWithLock).not.toHaveBeenCalled();
    // Cache is still invalidated so subsequent reads pick up any baseUrl change
    // applied separately via config.patch.
    expect(mocks.invalidateModelAuthStatusCache).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0][0]).toBe(true);
  });
});

describe("parseSetParams", () => {
  it("trims provider and apiKey strings", () => {
    const parsed = __test.parseSetParams({ provider: "  openai  ", apiKey: "  sk-abc  " });
    expect(parsed).toEqual({ ok: true, provider: "openai", apiKey: "sk-abc" });
  });

  it("treats whitespace-only apiKey as clear", () => {
    const parsed = __test.parseSetParams({ provider: "openai", apiKey: "   " });
    expect(parsed).toEqual({ ok: true, provider: "openai", apiKey: null });
  });
});

describe("maskSecret", () => {
  it("returns empty string for empty input", () => {
    expect(__test.maskSecret("")).toBe("");
    expect(__test.maskSecret("   ")).toBe("");
  });

  it("masks with last 4 characters for long keys", () => {
    expect(__test.maskSecret("abcdefghij")).toBe(`${BULLET_PREFIX}ghij`);
  });

  it("keeps short keys visible with leading bullets", () => {
    expect(__test.maskSecret("abc")).toBe(`${BULLET_PREFIX}abc`);
  });
});

describe("buildApiKeyProfileId", () => {
  it("normalizes provider aliases", () => {
    expect(__test.buildApiKeyProfileId("modelstudio")).toBe("qwen:default");
    expect(__test.buildApiKeyProfileId("OpenAI")).toBe("openai:default");
  });
});
