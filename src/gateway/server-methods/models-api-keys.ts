import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import { ensureAuthProfileStore } from "../../agents/auth-profiles.js";
import {
  listProfilesForProvider,
  removeProviderAuthProfilesWithLock,
  upsertAuthProfileWithLock,
} from "../../agents/auth-profiles/profiles.js";
import type { ApiKeyCredential, AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { normalizeProviderId } from "../../agents/provider-id.js";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { PROVIDER_LABELS, resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import { invalidateModelAuthStatusCache } from "./models-auth-status.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("models-api-keys");

/**
 * Where the UI-configured API key is currently resolved from, by priority:
 *   credentials  → ~/.openclaw/credentials/ (auth-profile store) — highest priority
 *   config       → models.providers.<id>.apiKey in openclaw.json (inline string)
 *   env          → process.env / dotenv-loaded <PROVIDER>_API_KEY
 *   none         → nothing set anywhere
 *
 * The UI surfaces this so users know whether a key is coming from a
 * committed file (.env / openclaw.json) vs. the secret store.
 */
export type ProviderApiKeySource = "credentials" | "config" | "env" | "none";

/**
 * Per-provider api-key status row.
 *
 * Mirrored into ui/src/ui/types.ts via `import(...)` re-export — edit here
 * and the UI picks up the change.
 */
export type ProviderApiKeyStatus = {
  provider: string;
  displayName: string;
  isSet: boolean;
  source: ProviderApiKeySource;
  /** Last 4 characters of the resolved key, with masking bullets. Only present when isSet=true. */
  masked?: string;
  /** Configured baseUrl from openclaw.json, if any. */
  baseUrl?: string;
  /** Number of catalog entries currently reporting this provider (runtime catalog). */
  modelCount: number;
};

export type ModelsApiKeysStatusResult = {
  /** Snapshot build time, ms since epoch. */
  ts: number;
  providers: ProviderApiKeyStatus[];
};

/**
 * `models.apiKeys.set` params.
 *
 * - `apiKey === undefined` → leave the stored key untouched
 * - `apiKey === null` or `""` → remove the provider's api-key profile(s)
 * - `apiKey` non-empty string → upsert `<provider>:default` api_key profile
 */
export type ModelsApiKeysSetParams = {
  provider: string;
  apiKey?: string | null;
};

export type ModelsApiKeysSetResult = {
  ok: true;
  provider: string;
  status: ProviderApiKeyStatus;
};

/**
 * Providers surfaced by the UI out of the box. A provider is also surfaced
 * when it shows up in the runtime model catalog, openclaw.json
 * `models.providers`, or the auth-profile store — so this list is only a
 * minimum floor to keep empty installs useful.
 *
 * The `envKey` is the canonical env var OpenClaw treats as "the key for this
 * provider" today. It's used both for source attribution and for the masked
 * preview. We don't fall back to alternate env names (`OPENAI_API_KEY_1`,
 * `OPENAI_API_KEYS`, etc.) here — those rotation aliases have provider-
 * specific semantics and aren't meaningful for a "primary key" summary.
 */
type KnownProviderEntry = {
  provider: string;
  displayName: string;
  envKey: string;
};

const BUILTIN_PROVIDERS: KnownProviderEntry[] = [
  { provider: "openai", displayName: "OpenAI", envKey: "OPENAI_API_KEY" },
  { provider: "anthropic", displayName: "Anthropic", envKey: "ANTHROPIC_API_KEY" },
  { provider: "google", displayName: "Google", envKey: "GEMINI_API_KEY" },
  { provider: "openrouter", displayName: "OpenRouter", envKey: "OPENROUTER_API_KEY" },
  { provider: "qwen", displayName: "Qwen", envKey: "DASHSCOPE_API_KEY" },
  { provider: "xai", displayName: "xAI", envKey: "XAI_API_KEY" },
];

function providerDisplayName(provider: string, fallback?: string): string {
  if (fallback && fallback.trim()) {
    return fallback;
  }
  const usageId = resolveUsageProviderId(provider);
  if (usageId && PROVIDER_LABELS[usageId]) {
    return PROVIDER_LABELS[usageId];
  }
  const normalized = normalizeProviderId(provider) || provider;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= 4) {
    return `••••${trimmed}`;
  }
  return `••••${trimmed.slice(-4)}`;
}

function readConfigProviderApiKey(cfg: OpenClawConfig, provider: string): string | null {
  const providers = cfg.models?.providers;
  if (!providers) {
    return null;
  }
  const providerKey = normalizeProviderId(provider);
  for (const [configuredId, entry] of Object.entries(providers)) {
    if (normalizeProviderId(configuredId) !== providerKey) {
      continue;
    }
    const apiKey = entry?.apiKey;
    if (typeof apiKey === "string" && apiKey.trim().length > 0) {
      return apiKey;
    }
  }
  return null;
}

function readConfigProviderBaseUrl(cfg: OpenClawConfig, provider: string): string | undefined {
  const providers = cfg.models?.providers;
  if (!providers) {
    return undefined;
  }
  const providerKey = normalizeProviderId(provider);
  for (const [configuredId, entry] of Object.entries(providers)) {
    if (normalizeProviderId(configuredId) !== providerKey) {
      continue;
    }
    const baseUrl = entry?.baseUrl;
    if (typeof baseUrl === "string" && baseUrl.trim().length > 0) {
      return baseUrl.trim();
    }
  }
  return undefined;
}

function readCredentialsProviderApiKey(store: AuthProfileStore, provider: string): string | null {
  const profileIds = listProfilesForProvider(store, provider);
  for (const id of profileIds) {
    const cred = store.profiles[id];
    if (cred?.type === "api_key" && typeof cred.key === "string" && cred.key.trim().length > 0) {
      return cred.key;
    }
  }
  return null;
}

function resolveProviderEnvKey(provider: string, knownEnvKey?: string): string {
  if (knownEnvKey) {
    return knownEnvKey;
  }
  const normalized = normalizeProviderId(provider) || provider;
  return `${normalized.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

function readEnvProviderApiKey(env: NodeJS.ProcessEnv, envKey: string): string | null {
  const raw = env[envKey];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return null;
}

function collectProviderIdsFromConfig(cfg: OpenClawConfig): string[] {
  const providers = cfg.models?.providers;
  if (!providers) {
    return [];
  }
  return Object.keys(providers).filter((id) => typeof id === "string" && id.length > 0);
}

function collectProviderIdsFromStore(store: AuthProfileStore): string[] {
  const out = new Set<string>();
  for (const cred of Object.values(store.profiles)) {
    if (typeof cred?.provider === "string" && cred.provider.length > 0) {
      out.add(cred.provider);
    }
  }
  return Array.from(out);
}

function collectProviderIdsFromCatalog(catalog: ReadonlyArray<{ provider: string }>): {
  ids: string[];
  counts: Map<string, number>;
} {
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  for (const entry of catalog) {
    if (typeof entry.provider !== "string" || entry.provider.length === 0) {
      continue;
    }
    ids.add(entry.provider);
    const key = normalizeProviderId(entry.provider);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return { ids: Array.from(ids), counts };
}

/**
 * Union of provider IDs to surface in the UI, de-duplicated by normalized ID
 * but preserving the "prettiest" source id for display (config > catalog >
 * store > builtin).
 *
 * Preserving the config id is important because `openclaw.json` may use
 * aliases like `modelstudio` that normalize to `qwen`; the UI should echo
 * the user's chosen spelling.
 */
function mergeProviders(
  builtins: KnownProviderEntry[],
  fromConfig: string[],
  fromCatalog: string[],
  fromStore: string[],
): KnownProviderEntry[] {
  const byNormalized = new Map<string, KnownProviderEntry>();
  const addEntry = (provider: string, entry?: KnownProviderEntry) => {
    const normalized = normalizeProviderId(provider);
    if (!normalized) {
      return;
    }
    if (byNormalized.has(normalized)) {
      return;
    }
    if (entry) {
      byNormalized.set(normalized, { ...entry, provider });
      return;
    }
    byNormalized.set(normalized, {
      provider,
      displayName: providerDisplayName(provider),
      envKey: resolveProviderEnvKey(provider),
    });
  };

  // Priority order: config (user's spelling), catalog, store, builtins.
  for (const id of fromConfig) {
    addEntry(id);
  }
  for (const id of fromCatalog) {
    addEntry(id);
  }
  for (const id of fromStore) {
    addEntry(id);
  }
  for (const builtin of builtins) {
    addEntry(builtin.provider, builtin);
  }
  return Array.from(byNormalized.values());
}

function buildProviderStatus(params: {
  entry: KnownProviderEntry;
  cfg: OpenClawConfig;
  store: AuthProfileStore;
  env: NodeJS.ProcessEnv;
  modelCounts: Map<string, number>;
}): ProviderApiKeyStatus {
  const { entry, cfg, store, env, modelCounts } = params;
  const provider = entry.provider;

  const credentialsKey = readCredentialsProviderApiKey(store, provider);
  const envKey = resolveProviderEnvKey(provider, entry.envKey);
  const configKey = readConfigProviderApiKey(cfg, provider);
  const envValue = readEnvProviderApiKey(env, envKey);

  let source: ProviderApiKeySource = "none";
  let masked: string | undefined;
  let isSet = false;
  if (credentialsKey) {
    source = "credentials";
    masked = maskSecret(credentialsKey);
    isSet = true;
  } else if (configKey) {
    source = "config";
    masked = maskSecret(configKey);
    isSet = true;
  } else if (envValue) {
    source = "env";
    masked = maskSecret(envValue);
    isSet = true;
  }

  const baseUrl = readConfigProviderBaseUrl(cfg, provider);
  const modelCount = modelCounts.get(normalizeProviderId(provider)) ?? 0;

  return {
    provider,
    displayName: providerDisplayName(provider, entry.displayName),
    isSet,
    source,
    ...(masked ? { masked } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    modelCount,
  };
}

async function buildStatusResult(params: {
  cfg: OpenClawConfig;
  store: AuthProfileStore;
  env: NodeJS.ProcessEnv;
  loadCatalog: () => Promise<ReadonlyArray<{ provider: string }>>;
}): Promise<ModelsApiKeysStatusResult> {
  let catalog: ReadonlyArray<{ provider: string }> = [];
  try {
    catalog = await params.loadCatalog();
  } catch (err) {
    log.debug(`catalog unavailable (proceeding with zero counts): ${formatForLog(err)}`);
  }
  const { ids: catalogIds, counts } = collectProviderIdsFromCatalog(catalog);
  const entries = mergeProviders(
    BUILTIN_PROVIDERS,
    collectProviderIdsFromConfig(params.cfg),
    catalogIds,
    collectProviderIdsFromStore(params.store),
  );
  const providers = entries.map((entry) =>
    buildProviderStatus({
      entry,
      cfg: params.cfg,
      store: params.store,
      env: params.env,
      modelCounts: counts,
    }),
  );
  // Stable ordering: alphabetical by normalized provider ID so the UI doesn't
  // flicker between requests and deterministic-cache checks hold.
  providers.sort((a, b) =>
    normalizeProviderId(a.provider).localeCompare(normalizeProviderId(b.provider)),
  );
  return { ts: Date.now(), providers };
}

function parseSetParams(
  params: unknown,
):
  | { ok: true; provider: string; apiKey: string | null | undefined }
  | { ok: false; error: string } {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, error: "invalid models.apiKeys.set params: object required" };
  }
  const record = params as Record<string, unknown>;
  const rawProvider = record.provider;
  if (typeof rawProvider !== "string" || rawProvider.trim().length === 0) {
    return { ok: false, error: "invalid models.apiKeys.set params: provider (string) required" };
  }
  const provider = rawProvider.trim();
  const rawKey = record.apiKey;
  let apiKey: string | null | undefined;
  if (rawKey === undefined) {
    apiKey = undefined;
  } else if (rawKey === null) {
    apiKey = null;
  } else if (typeof rawKey === "string") {
    // Empty or whitespace-only string is treated as a clear request.
    apiKey = rawKey.trim().length > 0 ? rawKey.trim() : null;
  } else {
    return {
      ok: false,
      error: "invalid models.apiKeys.set params: apiKey must be string | null | undefined",
    };
  }
  return { ok: true, provider, apiKey };
}

function buildApiKeyProfileId(provider: string): string {
  return `${normalizeProviderId(provider) || provider}:default`;
}

export const modelsApiKeysHandlers: GatewayRequestHandlers = {
  "models.apiKeys.status": async ({ respond, context }) => {
    try {
      const cfg = loadConfig();
      const agentDir = resolveOpenClawAgentDir();
      const store = ensureAuthProfileStore(agentDir);
      const result = await buildStatusResult({
        cfg,
        store,
        env: process.env,
        loadCatalog: context.loadGatewayModelCatalog,
      });
      respond(true, result, undefined);
    } catch (err) {
      log.warn(`models.apiKeys.status failed: ${formatForLog(err)}`);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "models.apiKeys.set": async ({ params, respond, context }) => {
    const parsed = parseSetParams(params);
    if (!parsed.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsed.error));
      return;
    }
    const { provider, apiKey } = parsed;
    const agentDir = resolveOpenClawAgentDir();
    try {
      if (apiKey === undefined) {
        // No-op on the credentials store; just return fresh status.
      } else if (apiKey === null) {
        await removeProviderAuthProfilesWithLock({ provider, agentDir });
        log.info(`models.apiKeys.set cleared provider=${normalizeProviderId(provider)}`);
      } else {
        const credential: ApiKeyCredential = {
          type: "api_key",
          provider: normalizeProviderId(provider) || provider,
          key: apiKey,
        };
        await upsertAuthProfileWithLock({
          profileId: buildApiKeyProfileId(provider),
          credential,
          agentDir,
        });
        log.info(
          `models.apiKeys.set stored provider=${normalizeProviderId(provider)} keySuffix=${maskSecret(apiKey)}`,
        );
      }
      invalidateModelAuthStatusCache();

      const cfg = loadConfig();
      const store = ensureAuthProfileStore(agentDir);
      const snapshot = await buildStatusResult({
        cfg,
        store,
        env: process.env,
        loadCatalog: context.loadGatewayModelCatalog,
      });
      const status = snapshot.providers.find(
        (row) => normalizeProviderId(row.provider) === normalizeProviderId(provider),
      );
      const fallback: ProviderApiKeyStatus = status ?? {
        provider,
        displayName: providerDisplayName(provider),
        isSet: false,
        source: "none",
        modelCount: 0,
      };
      const result: ModelsApiKeysSetResult = {
        ok: true,
        provider,
        status: fallback,
      };
      respond(true, result, undefined);
    } catch (err) {
      log.warn(
        `models.apiKeys.set failed provider=${normalizeProviderId(provider)}: ${formatForLog(err)}`,
      );
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};

// Exposed for unit tests; avoids depending on the full GatewayRequestContext.
export const __test = {
  BUILTIN_PROVIDERS,
  buildStatusResult,
  parseSetParams,
  maskSecret,
  providerDisplayName,
  buildApiKeyProfileId,
};
