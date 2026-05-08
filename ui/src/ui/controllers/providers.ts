import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  ModelsApiKeysSetResult,
  ModelsApiKeysStatusResult,
  ProviderApiKeyStatus,
} from "../types.ts";

const FALLBACK_STATUS: ModelsApiKeysStatusResult = { ts: 0, providers: [] };

export type ProviderApiKeysState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  /** Current status snapshot. `null` until the first load attempt. */
  providerApiKeyStatus: ModelsApiKeysStatusResult | null;
  providerApiKeyStatusLoading: boolean;
  providerApiKeyStatusError: string | null;
  /** Per-provider save-in-flight flags, keyed by normalized provider id. */
  providerApiKeySaving: Record<string, boolean>;
  /** Per-provider save error messages, keyed by normalized provider id. */
  providerApiKeyErrors: Record<string, string | null>;
  configSnapshot: { hash?: string | null } | null;
  applySessionKey: string;
  lastError: string | null;
};

/**
 * Fetch the current api-key status snapshot. Rethrows transport errors so
 * state wrappers can distinguish "not loaded yet" from "load failed".
 */
export async function loadProviderApiKeyStatus(
  client: GatewayBrowserClient,
): Promise<ModelsApiKeysStatusResult> {
  const result = await client.request<ModelsApiKeysStatusResult>("models.apiKeys.status", {});
  return result ?? FALLBACK_STATUS;
}

export async function loadProviderApiKeyStatusState(state: ProviderApiKeysState): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.providerApiKeyStatusLoading) {
    return;
  }
  state.providerApiKeyStatusLoading = true;
  state.providerApiKeyStatusError = null;
  try {
    state.providerApiKeyStatus = await loadProviderApiKeyStatus(state.client);
  } catch (err) {
    state.providerApiKeyStatusError = err instanceof Error ? err.message : String(err);
    state.providerApiKeyStatus = FALLBACK_STATUS;
  } finally {
    state.providerApiKeyStatusLoading = false;
  }
}

function providerKey(provider: string): string {
  return provider.trim().toLowerCase();
}

function patchStatusRow(
  snapshot: ModelsApiKeysStatusResult | null,
  next: ProviderApiKeyStatus,
): ModelsApiKeysStatusResult {
  const ts = Date.now();
  if (!snapshot) {
    return { ts, providers: [next] };
  }
  const idx = snapshot.providers.findIndex(
    (row) => providerKey(row.provider) === providerKey(next.provider),
  );
  if (idx === -1) {
    return { ts, providers: [...snapshot.providers, next] };
  }
  const providers = snapshot.providers.slice();
  providers[idx] = next;
  return { ts, providers };
}

/**
 * Save or clear an API key for a provider.
 *
 * @param apiKey
 *   - Non-empty string: upsert as `<provider>:default` api_key profile.
 *   - `null` or `""`: remove any existing api_key profiles for this provider.
 */
export async function saveProviderApiKey(
  state: ProviderApiKeysState,
  params: { provider: string; apiKey: string | null },
): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const keyId = providerKey(params.provider);
  if (!keyId) {
    return false;
  }
  state.providerApiKeySaving = { ...state.providerApiKeySaving, [keyId]: true };
  state.providerApiKeyErrors = { ...state.providerApiKeyErrors, [keyId]: null };
  try {
    const result = await state.client.request<ModelsApiKeysSetResult>("models.apiKeys.set", {
      provider: params.provider,
      apiKey: params.apiKey,
    });
    if (result?.status) {
      state.providerApiKeyStatus = patchStatusRow(state.providerApiKeyStatus, result.status);
    } else {
      // Server didn't echo the row; do a full reload to stay consistent.
      await loadProviderApiKeyStatusState(state);
    }
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.providerApiKeyErrors = { ...state.providerApiKeyErrors, [keyId]: message };
    state.lastError = message;
    return false;
  } finally {
    state.providerApiKeySaving = { ...state.providerApiKeySaving, [keyId]: false };
  }
}

/**
 * Write `models.providers.<provider>.baseUrl` to openclaw.json via the
 * existing `config.patch` contract.
 *
 * - `baseUrl` is a non-empty string → write it.
 * - `baseUrl === null` or `""` → reset the field to default by writing
 *   `{ baseUrl: null }`, which the merge-patch layer removes.
 */
export async function saveProviderBaseUrl(
  state: ProviderApiKeysState,
  params: { provider: string; baseUrl: string | null },
): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const keyId = providerKey(params.provider);
  if (!keyId) {
    return false;
  }
  const baseHash = state.configSnapshot?.hash;
  if (!baseHash) {
    const message = "Config hash missing; reload and retry.";
    state.providerApiKeyErrors = { ...state.providerApiKeyErrors, [keyId]: message };
    state.lastError = message;
    return false;
  }
  const trimmed = typeof params.baseUrl === "string" ? params.baseUrl.trim() : null;
  const nextBaseUrl = trimmed && trimmed.length > 0 ? trimmed : null;
  const patch = {
    models: {
      providers: {
        [params.provider]: { baseUrl: nextBaseUrl },
      },
    },
  };
  state.providerApiKeySaving = { ...state.providerApiKeySaving, [keyId]: true };
  state.providerApiKeyErrors = { ...state.providerApiKeyErrors, [keyId]: null };
  try {
    await state.client.request("config.patch", {
      baseHash,
      raw: JSON.stringify(patch),
      sessionKey: state.applySessionKey,
      note: "Provider baseUrl updated from the Providers & API Keys panel.",
    });
    // Re-fetch status so the baseUrl in the snapshot reflects the write.
    await loadProviderApiKeyStatusState(state);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.providerApiKeyErrors = { ...state.providerApiKeyErrors, [keyId]: message };
    state.lastError = message;
    return false;
  } finally {
    state.providerApiKeySaving = { ...state.providerApiKeySaving, [keyId]: false };
  }
}
