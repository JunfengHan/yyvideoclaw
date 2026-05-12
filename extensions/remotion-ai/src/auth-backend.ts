// extensions/remotion-ai/src/auth-backend.ts
//
// Thin wrapper over the yyvideoclaw hosted-inference backend. All HTTP
// shape lives here so the rest of the plugin can call typed helpers and
// the tests can swap a fake `fetch` without intercepting global state.
//
// Backend contract (M1 — see the docs in the yyvideoclaw-backend repo):
//
//   POST /api/v1/auth/login
//     body  : { email, password }
//     200   : { token, userEmail, remainingCredits }
//     401   : { error: "invalid_credentials" }
//     other : { error: string, detail?: string }
//
//   POST /api/v1/auth/logout
//     header: Authorization: Bearer <token>
//     204
//
//   GET  /api/v1/usage
//     header: Authorization: Bearer <token>
//     200   : { remainingCredits, monthlyQuota }
//
//   POST /api/v1/codex/chat/completions  (OpenAI-compatible)
//     header: Authorization: Bearer <token>
//     The codex CLI talks to this URL via OPENAI_BASE_URL/API_KEY env vars
//     we inject at spawn-time. This module does not call it directly; it
//     only owns the auth lifecycle.
//
// Why a separate module from auth-config?
//   - Keeps `auth-config.ts` pure-IO (no network) so it stays trivial to
//     unit-test.
//   - Lets us swap the backend impl (mock → real) by changing one place.

const DEFAULT_BACKEND_BASE_URL = "https://api.yyvideoclaw.com";

/** Resolve the backend base URL. Override via env for staging / local
 *  testing without touching code. */
export function resolveBackendBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.YYVIDEOCLAW_BACKEND_BASE_URL?.trim() ||
    env.OPENCLAW_REMOTION_AI_BACKEND_BASE_URL?.trim() ||
    DEFAULT_BACKEND_BASE_URL
  );
}

/** Fetch interface kept narrow so tests can pass `vi.fn()`. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
  readonly text: () => Promise<string>;
}>;

export interface AuthBackendDeps {
  readonly fetch?: FetchLike;
  readonly baseUrl?: string;
}

export type AuthBackendError =
  | { readonly kind: "invalid_credentials" }
  | { readonly kind: "network_error"; readonly detail: string }
  | { readonly kind: "server_error"; readonly status: number; readonly detail: string };

export interface LoginRequest {
  readonly email: string;
  readonly password: string;
}

export interface LoginSuccess {
  readonly token: string;
  readonly userEmail: string;
  readonly remainingCredits: number | null;
}

export interface UsageSnapshot {
  readonly remainingCredits: number | null;
  readonly monthlyQuota: number | null;
}

export class AuthBackend {
  private readonly fetcher: FetchLike;
  private readonly baseUrl: string;

  constructor(deps: AuthBackendDeps = {}) {
    this.fetcher = deps.fetch ?? ((input, init) => fetch(input, init) as ReturnType<FetchLike>);
    this.baseUrl = (deps.baseUrl ?? resolveBackendBaseUrl()).replace(/\/+$/u, "");
  }

  async login(req: LoginRequest, signal?: AbortSignal): Promise<LoginSuccess | AuthBackendError> {
    let res;
    try {
      res = await this.fetcher(`${this.baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email: req.email, password: req.password }),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      return {
        kind: "network_error",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (res.status === 401) {
      return { kind: "invalid_credentials" };
    }
    if (!res.ok) {
      return {
        kind: "server_error",
        status: res.status,
        detail: await safeReadText(res),
      };
    }
    const body = (await res.json().catch(() => null)) as {
      token?: unknown;
      userEmail?: unknown;
      remainingCredits?: unknown;
    } | null;
    if (!body || typeof body.token !== "string" || body.token.length === 0) {
      return { kind: "server_error", status: res.status, detail: "missing token in response" };
    }
    return {
      token: body.token,
      userEmail: typeof body.userEmail === "string" ? body.userEmail : req.email,
      remainingCredits: typeof body.remainingCredits === "number" ? body.remainingCredits : null,
    };
  }

  async logout(token: string, signal?: AbortSignal): Promise<true | AuthBackendError> {
    let res;
    try {
      res = await this.fetcher(`${this.baseUrl}/api/v1/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      return {
        kind: "network_error",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    // 204 or any 2xx is OK; the local logout proceeds either way so we
    // don't strand the user in a "can't switch modes" loop just because
    // the backend hiccuped.
    if (!res.ok && res.status !== 401) {
      return {
        kind: "server_error",
        status: res.status,
        detail: await safeReadText(res),
      };
    }
    return true;
  }

  async usage(token: string, signal?: AbortSignal): Promise<UsageSnapshot | AuthBackendError> {
    let res;
    try {
      res = await this.fetcher(`${this.baseUrl}/api/v1/usage`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      return {
        kind: "network_error",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (res.status === 401) {
      return { kind: "invalid_credentials" };
    }
    if (!res.ok) {
      return {
        kind: "server_error",
        status: res.status,
        detail: await safeReadText(res),
      };
    }
    const body = (await res.json().catch(() => null)) as {
      remainingCredits?: unknown;
      monthlyQuota?: unknown;
    } | null;
    return {
      remainingCredits:
        body && typeof body.remainingCredits === "number" ? body.remainingCredits : null,
      monthlyQuota: body && typeof body.monthlyQuota === "number" ? body.monthlyQuota : null,
    };
  }

  /**
   * The hosted proxy URL the codex CLI talks to. Built from `baseUrl` so
   * staging / dev deploys automatically pick the right host.
   * `OPENAI_BASE_URL` per OpenAI conventions: the SDK appends `/chat/...`
   * so this URL must end at the version segment, not at `/chat`.
   */
  get hostedOpenAiBaseUrl(): string {
    return `${this.baseUrl}/api/v1/codex`;
  }
}

async function safeReadText(res: { text: () => Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
