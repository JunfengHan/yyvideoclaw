// ui/src/ui/controllers/remotion-ai-auth.ts
//
// HTTP/state bridge for the AI Create panel's auth flows. Talks to the
// `/remotion-ai/auth/*` routes registered by `extensions/remotion-ai/`.
//
// Keep this module isolated from the job/library controller so the auth
// modal can render before any job state exists.

import { resolveControlUiAuthCandidates } from "../control-ui-auth.ts";
import { normalizeBasePath } from "../navigation.ts";

// ---------------------------------------------------------------------------
// Wire types — keep in sync with extensions/remotion-ai/src/auth-config.ts
// (`PublicAuthStatus`).
// ---------------------------------------------------------------------------

export type RemotionAiAuthMode = "unset" | "hosted" | "byok";

/** Mirror of `ByokProvider` from the server-side auth-config.ts. */
export type RemotionAiByokProvider = "openai" | "openrouter";

export type RemotionAiAuthStatusWire = {
  readonly mode: RemotionAiAuthMode;
  readonly hostedUserEmail?: string;
  readonly hostedRemainingCredits?: number | null;
  readonly hostedRefreshedAt?: number;
  readonly byokConfiguredAt?: number;
  readonly byokDisplayName?: string;
  readonly byokProvider?: RemotionAiByokProvider;
  readonly byokModel?: string;
};

export type RemotionAiAuthEnvelope = {
  readonly auth: RemotionAiAuthStatusWire;
};

export type RemotionAiUsageWire = {
  readonly remainingCredits: number | null;
  readonly monthlyQuota: number | null;
};

export type RemotionAiUsageEnvelope =
  | { readonly usage: null; readonly reason: "byok_no_quota" | "not_logged_in" }
  | { readonly usage: RemotionAiUsageWire; readonly auth: RemotionAiAuthStatusWire };

// ---------------------------------------------------------------------------
// State slice consumed by the panel.
// ---------------------------------------------------------------------------

/** Which dialog/screen the auth modal is showing right now. */
export type RemotionAiAuthModalView =
  | "closed"
  | "chooser" // pick hosted vs byok
  | "hosted" // email + password form
  | "byok-pick" // sub-chooser: which BYOK provider (openai vs openrouter)
  | "byok-openai" // OpenAI key paste form
  | "byok-openrouter"; // OpenRouter key + model dropdown form

export type RemotionAiAuthControllerState = {
  /** Last-known status from the backend. `null` = haven't fetched yet. */
  remotionAiAuthStatus: RemotionAiAuthStatusWire | null;
  /** Drives the modal's render mode. */
  remotionAiAuthModalView: RemotionAiAuthModalView;
  /** True while a write request is pending; disables the submit buttons. */
  remotionAiAuthPending: boolean;
  /** Last error to surface in-form (e.g. "invalid_credentials"). */
  remotionAiAuthError: string | null;
};

export function defaultRemotionAiAuthState(): RemotionAiAuthControllerState {
  return {
    remotionAiAuthStatus: null,
    remotionAiAuthModalView: "closed",
    remotionAiAuthPending: false,
    remotionAiAuthError: null,
  };
}

// ---------------------------------------------------------------------------
// HTTP — pattern from controllers/remotion-ai.ts (kept intentionally
// independent so a future module split is painless).
// ---------------------------------------------------------------------------

export type RemotionAiAuthHttpDeps = {
  readonly basePath: string;
  readonly hello?: { auth?: { deviceToken?: string | null } | null } | null;
  readonly settings?: { token?: string | null } | null;
  readonly password?: string | null;
  readonly fetchImpl?: typeof globalThis.fetch;
};

async function callAuthRoute<T>(
  deps: RemotionAiAuthHttpDeps,
  subpath: `/${string}`,
  init: RequestInit = {},
): Promise<T> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const basePath = normalizeBasePath(deps.basePath ?? "");
  const url = basePath ? `${basePath}${subpath}` : subpath;
  const candidates = resolveControlUiAuthCandidates(deps);
  const attempts = candidates.length > 0 ? candidates : [""];
  let lastError: unknown = null;
  for (const candidate of attempts) {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    };
    if (candidate) {
      headers.Authorization = `Bearer ${candidate}`;
    }
    try {
      const res = await fetchImpl(url, { ...init, headers, credentials: "same-origin" });
      if (res.ok) {
        const text = await res.text();
        if (text.length === 0) {
          return undefined as unknown as T;
        }
        return JSON.parse(text) as T;
      }
      // Surface 4xx errors directly — login failures, validation errors,
      // session expired etc. all need to reach the form for display.
      // 401 from the gateway itself (auth candidate exhausted) loops to
      // the next candidate; backend-issued 401 (invalid_credentials,
      // session_expired) bubbles up as a thrown Error too — distinguish
      // by inspecting `text` when needed.
      const text = await res.text().catch(() => "");
      if (
        res.status === 401 &&
        !text.includes("invalid_credentials") &&
        !text.includes("session_expired")
      ) {
        lastError = new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
        continue;
      }
      throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(typeof lastError === "string" ? lastError : "remotion-ai auth route failed");
}

// ---------------------------------------------------------------------------
// Public verbs.
// ---------------------------------------------------------------------------

export async function fetchAuthStatus(
  deps: RemotionAiAuthHttpDeps,
): Promise<RemotionAiAuthStatusWire> {
  const body = await callAuthRoute<RemotionAiAuthEnvelope>(deps, "/remotion-ai/auth/status");
  return body.auth;
}

export async function loginHosted(
  deps: RemotionAiAuthHttpDeps,
  body: { readonly email: string; readonly password: string },
): Promise<RemotionAiAuthStatusWire> {
  const res = await callAuthRoute<RemotionAiAuthEnvelope>(deps, "/remotion-ai/auth/login", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.auth;
}

export async function logoutAuth(
  deps: RemotionAiAuthHttpDeps,
  options: { readonly clearByok?: boolean } = {},
): Promise<RemotionAiAuthStatusWire> {
  const res = await callAuthRoute<RemotionAiAuthEnvelope>(deps, "/remotion-ai/auth/logout", {
    method: "POST",
    body: JSON.stringify(options),
  });
  return res.auth;
}

export async function saveByokKey(
  deps: RemotionAiAuthHttpDeps,
  body: {
    readonly provider: RemotionAiByokProvider;
    readonly apiKey: string;
    readonly displayName?: string;
    /** Required when provider === "openrouter". OpenRouter slug
     *  (e.g. "anthropic/claude-3.5-sonnet"). */
    readonly model?: string;
  },
): Promise<RemotionAiAuthStatusWire> {
  const res = await callAuthRoute<RemotionAiAuthEnvelope>(deps, "/remotion-ai/auth/byok", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.auth;
}

// ---------------------------------------------------------------------------
// OpenRouter model dropdown.
// ---------------------------------------------------------------------------

export type OpenRouterModelWire = {
  readonly id: string;
  readonly name: string;
  readonly contextLength: number | null;
  readonly pricing: { readonly prompt: string; readonly completion: string } | null;
};

export type OpenRouterModelsResponseWire = {
  readonly models: ReadonlyArray<OpenRouterModelWire>;
};

export async function fetchOpenRouterModels(
  deps: RemotionAiAuthHttpDeps,
): Promise<ReadonlyArray<OpenRouterModelWire>> {
  const body = await callAuthRoute<OpenRouterModelsResponseWire>(
    deps,
    "/remotion-ai/auth/openrouter/models",
  );
  return body.models;
}

export async function fetchUsage(deps: RemotionAiAuthHttpDeps): Promise<RemotionAiUsageEnvelope> {
  return await callAuthRoute<RemotionAiUsageEnvelope>(deps, "/remotion-ai/auth/usage");
}

// ---------------------------------------------------------------------------
// Reducer-shaped helpers used by the view.
// ---------------------------------------------------------------------------

/** True if the user must complete the modal flow before submitting a job. */
export function requiresAuthSetup(status: RemotionAiAuthStatusWire | null): boolean {
  if (!status) {
    // No status fetched yet — treat as needs-setup until proven otherwise
    // so the modal mounts on first paint.
    return true;
  }
  return status.mode === "unset";
}

/** Human-readable summary of the current auth state for the status row. */
export type AuthBadgeView = {
  readonly label: string;
  readonly tone: "hosted" | "byok" | "unset";
  readonly hint?: string;
};

export function describeAuthBadge(
  status: RemotionAiAuthStatusWire | null,
  t: (key: string, params?: Record<string, unknown>) => string,
): AuthBadgeView {
  if (!status || status.mode === "unset") {
    return { tone: "unset", label: t("remotionAi.auth.badge.unset") };
  }
  if (status.mode === "hosted") {
    const credits =
      typeof status.hostedRemainingCredits === "number"
        ? t("remotionAi.auth.badge.creditsRemaining", {
            count: status.hostedRemainingCredits,
          })
        : t("remotionAi.auth.badge.creditsUnknown");
    return {
      tone: "hosted",
      label: t("remotionAi.auth.badge.hosted"),
      hint: status.hostedUserEmail ? `${status.hostedUserEmail} • ${credits}` : credits,
    };
  }
  if (status.mode === "byok") {
    // Distinguish openai vs openrouter so users can tell which key set
    // is currently active. The hint surfaces the model id for openrouter
    // since that's the most actionable info ("oh right, I'm on Claude").
    const isOpenRouter = status.byokProvider === "openrouter";
    const label = isOpenRouter
      ? t("remotionAi.auth.badge.openrouter")
      : t("remotionAi.auth.badge.byok");
    const hint = isOpenRouter
      ? (status.byokModel ?? status.byokDisplayName ?? undefined)
      : status.byokDisplayName;
    return {
      tone: "byok",
      label,
      ...(hint ? { hint } : {}),
    };
  }
  return { tone: "byok", label: t("remotionAi.auth.badge.byok") };
}
