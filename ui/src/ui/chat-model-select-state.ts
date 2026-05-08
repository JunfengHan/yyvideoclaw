import type { AppViewState } from "./app-view-state.ts";
import {
  buildCatalogDisplayLookup,
  buildChatModelOptionFromLookup,
  formatCatalogChatModelDisplayFromLookup,
  normalizeChatModelOverrideValue,
  resolvePreferredServerChatModelValue,
} from "./chat-model-ref.ts";
import type { ModelCatalogEntry, ModelsApiKeysStatusResult } from "./types.ts";

type ChatModelSelectStateInput = Pick<
  AppViewState,
  "sessionKey" | "chatModelOverrides" | "chatModelCatalog" | "sessionsResult"
> & {
  /**
   * Optional snapshot of provider api-key status. When provided, the picker
   * options are filtered to providers with `isSet === true`. The currently
   * selected and default options are always preserved so the user can still
   * see what's active even if its provider is unconfigured.
   *
   * When omitted (or `null`/empty), no provider-key filtering is applied —
   * this preserves the pre-filter behavior and is the right fallback before
   * the `models.apiKeys.status` RPC has responded.
   */
  providerApiKeyStatus?: ModelsApiKeysStatusResult | null;
};

export type ChatModelSelectOption = {
  value: string;
  label: string;
  /** Provider id from the source catalog entry, when known. Empty/undefined for
   * synthetic options (currentOverride / defaultModel that aren't in catalog). */
  provider?: string;
};

export type ChatModelSelectState = {
  currentOverride: string;
  defaultModel: string;
  defaultDisplay: string;
  defaultLabel: string;
  options: ChatModelSelectOption[];
};

function resolveActiveSessionRow(state: ChatModelSelectStateInput) {
  return state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
}

export function resolveChatModelOverrideValue(state: ChatModelSelectStateInput): string {
  const catalog = state.chatModelCatalog ?? [];

  // Prefer the local cache — it reflects in-flight patches before sessionsResult refreshes.
  const cached = state.chatModelOverrides[state.sessionKey];
  if (cached) {
    return normalizeChatModelOverrideValue(cached, catalog);
  }
  if (cached === null) {
    return "";
  }

  const activeRow = resolveActiveSessionRow(state);
  return resolvePreferredServerChatModelValue(activeRow?.model, activeRow?.modelProvider, catalog);
}

function resolveDefaultModelValue(state: ChatModelSelectStateInput): string {
  return resolvePreferredServerChatModelValue(
    state.sessionsResult?.defaults?.model,
    state.sessionsResult?.defaults?.modelProvider,
    state.chatModelCatalog ?? [],
  );
}

function buildChatModelOptions(
  catalog: ModelCatalogEntry[],
  displayLookup: ReturnType<typeof buildCatalogDisplayLookup>,
  currentOverride: string,
  defaultModel: string,
  allowedProviders: Set<string> | null,
): ChatModelSelectOption[] {
  const seen = new Set<string>();
  const options: ChatModelSelectOption[] = [];

  const addOption = (value: string, label?: string, provider?: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const finalLabel = label ?? trimmed;
    const trimmedProvider = provider?.trim();
    options.push({
      value: trimmed,
      label: finalLabel,
      ...(trimmedProvider ? { provider: trimmedProvider } : {}),
    });
  };

  for (const entry of catalog) {
    if (allowedProviders) {
      const providerKey = (entry.provider ?? "").trim().toLowerCase();
      // Skip catalog entries whose provider has no API key configured. The
      // current override and default-model entries are added unconditionally
      // below, so the user can still see (and keep) their active selection
      // even if that provider isn't in `allowedProviders`.
      if (!providerKey || !allowedProviders.has(providerKey)) {
        continue;
      }
    }
    const option = buildChatModelOptionFromLookup(entry, displayLookup);
    addOption(option.value, option.label, entry.provider);
  }

  if (currentOverride) {
    addOption(
      currentOverride,
      formatCatalogChatModelDisplayFromLookup(currentOverride, displayLookup),
    );
  }
  if (defaultModel) {
    addOption(defaultModel, formatCatalogChatModelDisplayFromLookup(defaultModel, displayLookup));
  }
  return options;
}

function resolveAllowedProviders(
  status: ModelsApiKeysStatusResult | null | undefined,
): Set<string> | null {
  if (!status || !Array.isArray(status.providers) || status.providers.length === 0) {
    // Treat null/undefined/empty as "data not loaded yet" — show everything
    // so the picker doesn't briefly collapse to just the default option.
    return null;
  }
  const allowed = new Set<string>();
  for (const row of status.providers) {
    if (row.isSet) {
      const providerKey = row.provider.trim().toLowerCase();
      if (providerKey) {
        allowed.add(providerKey);
      }
    }
  }
  return allowed;
}

export function resolveChatModelSelectState(
  state: ChatModelSelectStateInput,
): ChatModelSelectState {
  const catalog = state.chatModelCatalog ?? [];
  const displayLookup = buildCatalogDisplayLookup(catalog);
  const currentOverride = resolveChatModelOverrideValue(state);
  const defaultModel = resolveDefaultModelValue(state);
  const defaultDisplay = formatCatalogChatModelDisplayFromLookup(defaultModel, displayLookup);
  const allowedProviders = resolveAllowedProviders(state.providerApiKeyStatus);

  return {
    currentOverride,
    defaultModel,
    defaultDisplay,
    defaultLabel: defaultModel ? `Default (${defaultDisplay})` : "Default model",
    options: buildChatModelOptions(
      catalog,
      displayLookup,
      currentOverride,
      defaultModel,
      allowedProviders,
    ),
  };
}
