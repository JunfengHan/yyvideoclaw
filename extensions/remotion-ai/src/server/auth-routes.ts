// extensions/remotion-ai/src/server/auth-routes.ts
//
// HTTP routes that back the AI Create panel's auth flows:
//
//   POST   /remotion-ai/auth/login   — log into yyvideoclaw hosted, store token
//   POST   /remotion-ai/auth/logout  — clear hosted token (and optionally byok key)
//   POST   /remotion-ai/auth/byok    — paste OpenAI API key, write ~/.codex/auth.json
//   GET    /remotion-ai/auth/status  — current mode + cached usage
//
// Why these are dedicated handlers (not shoehorned into routes.ts):
//   - Distinct security posture: login/byok accept secrets in the body
//     and must NEVER be logged. routes.ts already returns full body text
//     in some error paths, which is fine for prompts but lethal for
//     tokens.
//   - Auth state is global to the user, not per-job; mixing it with
//     /jobs would muddle the URL hierarchy and the SSE event projection.

import type { IncomingMessage, ServerResponse } from "node:http";
import { AuthBackend } from "../auth-backend.js";
import {
  readAuthConfig,
  toPublicStatus,
  writeAuthConfig,
  type AuthConfig,
} from "../auth-config.js";
import {
  deleteCodexAuth,
  deleteOpenRouterKey,
  isPlausibleOpenAiKey,
  looksLikeOpenRouterKey,
  writeCodexAuthApiKey,
} from "../byok-store.js";
import { removeOpenRouterConfig } from "../codex-config-toml.js";
import {
  badRequest,
  jsonResponse,
  methodNotAllowed,
  readJsonBody,
  type RouteHandler,
} from "./routes.js";

/** Test seam: lets unit tests inject a fake backend / fake fs paths. */
export interface AuthRouteContext {
  readonly backend?: AuthBackend;
  readonly authConfigPath?: string;
  readonly codexAuthPath?: string;
  /** Override `~/.codex/config.toml`. Tests use a tmpdir. */
  readonly codexConfigTomlPath?: string;
  /** Override `~/.openclaw/remotion-ai/byok-openrouter.json`. */
  readonly openRouterKeyPath?: string;
  /** Test seam: replace the global fetch used by `/auth/openrouter/models`. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

const TOKEN_REDACTED = "<redacted>";

/**
 * Helper: never echo the full bearer token / API key in HTTP responses
 * or logs. We return the public projection of the auth config (token
 * stripped) and a one-liner "ok" for write ops.
 */
function publicAuthResponse(config: AuthConfig): unknown {
  return { auth: toPublicStatus(config) };
}

// ---------------------------------------------------------------------------
// POST /remotion-ai/auth/login
// ---------------------------------------------------------------------------

interface LoginRequestBody {
  readonly email?: unknown;
  readonly password?: unknown;
}

export function makeAuthLoginHandler(authCtx: AuthRouteContext = {}): RouteHandler {
  return async (req, res, _ctx) => {
    if (req.method !== "POST") {
      return methodNotAllowed(res, "POST");
    }
    let body: LoginRequestBody;
    try {
      body = await readJsonBody<LoginRequestBody>(req);
    } catch (err) {
      return badRequest(res, err instanceof Error ? err.message : String(err));
    }
    if (typeof body.email !== "string" || body.email.trim().length === 0) {
      return badRequest(res, "email is required");
    }
    if (typeof body.password !== "string" || body.password.length === 0) {
      return badRequest(res, "password is required");
    }
    const backend = authCtx.backend ?? new AuthBackend();
    const result = await backend.login({
      email: body.email.trim(),
      password: body.password,
    });
    if ("kind" in result) {
      switch (result.kind) {
        case "invalid_credentials":
          return jsonResponse(res, 401, { error: "invalid_credentials" });
        case "network_error":
          return jsonResponse(res, 502, {
            error: "backend_unreachable",
            detail: result.detail,
          });
        case "server_error":
          return jsonResponse(res, 502, {
            error: "backend_error",
            status: result.status,
            detail: result.detail,
          });
      }
    }
    const config: AuthConfig = {
      mode: "hosted",
      hostedToken: result.token,
      hostedUserEmail: result.userEmail,
      hostedRemainingCredits: result.remainingCredits,
      hostedRefreshedAt: Date.now(),
      schemaVersion: 1,
    };
    await writeAuthConfig(config, authCtx.authConfigPath);
    // Body intentionally OMITS the bearer token — clients that want to
    // know the mode + email can read /auth/status; the token only ever
    // lives on disk in 0600 mode.
    void TOKEN_REDACTED;
    return jsonResponse(res, 200, publicAuthResponse(config));
  };
}

// ---------------------------------------------------------------------------
// POST /remotion-ai/auth/logout
// ---------------------------------------------------------------------------

interface LogoutRequestBody {
  /** When true, also delete `~/.codex/auth.json`. Default false: a user
   *  switching from hosted back to byok shouldn't lose their key. */
  readonly clearByok?: unknown;
}

export function makeAuthLogoutHandler(authCtx: AuthRouteContext = {}): RouteHandler {
  return async (req, res, _ctx) => {
    if (req.method !== "POST") {
      return methodNotAllowed(res, "POST");
    }
    let body: LogoutRequestBody;
    try {
      body = await readJsonBody<LogoutRequestBody>(req);
    } catch {
      body = {};
    }
    const previous = await readAuthConfig(authCtx.authConfigPath);
    if (previous.mode === "hosted" && previous.hostedToken) {
      const backend = authCtx.backend ?? new AuthBackend();
      // Best-effort: tell the backend to invalidate the token. We DON'T
      // block local logout on a backend error — the user expects "log
      // out" to feel instant, and the local token is gone after this
      // call regardless.
      await backend.logout(previous.hostedToken).catch(() => undefined);
    }
    if (body.clearByok === true) {
      // Wipe everything we know how to write so the user gets a clean
      // slate. `deleteCodexAuth` is best-effort; the OpenRouter sidecar
      // + toml cleanup also degrades gracefully.
      await deleteCodexAuth(authCtx.codexAuthPath);
      await deleteOpenRouterKey(authCtx.openRouterKeyPath);
      await removeOpenRouterConfig({
        ...(authCtx.codexConfigTomlPath ? { configPath: authCtx.codexConfigTomlPath } : {}),
      });
    }
    const next: AuthConfig = { mode: "unset", schemaVersion: 1 };
    await writeAuthConfig(next, authCtx.authConfigPath);
    return jsonResponse(res, 200, publicAuthResponse(next));
  };
}

// ---------------------------------------------------------------------------
// POST /remotion-ai/auth/byok
//
// Body shape (provider determines validation + storage):
//
//   { "provider": "openai",     "apiKey": "sk-...",     "displayName"?: string }
//   { "provider": "openrouter", "apiKey": "sk-or-v1-…", "model": "anthropic/claude-3.5-sonnet", "displayName"?: string }
//
// Backwards compat: when `provider` is omitted we infer it from the
// key's prefix — sk-or-v1-… → openrouter, sk-… → openai. This means
// older UI builds that don't know about the provider field continue to
// work for the openai case.
// ---------------------------------------------------------------------------

interface ByokRequestBody {
  readonly provider?: unknown;
  readonly apiKey?: unknown;
  readonly displayName?: unknown;
  readonly model?: unknown;
}

export function makeAuthByokHandler(authCtx: AuthRouteContext = {}): RouteHandler {
  return async (req, res, _ctx) => {
    if (req.method !== "POST") {
      return methodNotAllowed(res, "POST");
    }
    let body: ByokRequestBody;
    try {
      body = await readJsonBody<ByokRequestBody>(req);
    } catch (err) {
      return badRequest(res, err instanceof Error ? err.message : String(err));
    }
    const provider = resolveProvider(body);
    if (provider === null) {
      return badRequest(
        res,
        `provider must be "openai" or "openrouter" (got ${JSON.stringify(body.provider)})`,
      );
    }
    if (provider === "openai") {
      return handleByokOpenAi(res, body, authCtx);
    }
    return handleByokOpenRouter(res, body, authCtx);
  };
}

/**
 * Decide which BYOK provider this request targets. Explicit `provider`
 * wins; otherwise we sniff the key prefix. Returns `null` for an
 * obviously bad provider value (so callers can 400 the request).
 */
function resolveProvider(body: ByokRequestBody): "openai" | "openrouter" | null {
  if (body.provider === "openai" || body.provider === "openrouter") {
    return body.provider;
  }
  if (body.provider === undefined) {
    if (looksLikeOpenRouterKey(body.apiKey)) {
      return "openrouter";
    }
    return "openai";
  }
  return null;
}

async function handleByokOpenAi(
  res: ServerResponse,
  body: ByokRequestBody,
  authCtx: AuthRouteContext,
): Promise<boolean> {
  if (!isPlausibleOpenAiKey(body.apiKey)) {
    return badRequest(res, "apiKey must look like an OpenAI API key (starts with sk-…)");
  }
  // Reject a sk-or-v1- key that was ALSO sent with provider="openai".
  // Letting it through would write the OpenRouter key into auth.json and
  // codex would happily dispatch /v1/responses calls to OpenAI which 401
  // because the key isn't valid there. Surface the mismatch instead.
  if (looksLikeOpenRouterKey(body.apiKey)) {
    return badRequest(
      res,
      'apiKey looks like an OpenRouter key (sk-or-v1-…); pass provider="openrouter" instead',
    );
  }
  try {
    await writeCodexAuthApiKey(body.apiKey, authCtx.codexAuthPath);
  } catch (err) {
    return jsonResponse(res, 500, {
      error: "io_error",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  // Switching providers: scrub any leftover OpenRouter sidecar +
  // ~/.codex/config.toml entries so codex defaults back to vanilla
  // OpenAI auth resolution.
  await deleteOpenRouterKey(authCtx.openRouterKeyPath);
  await removeOpenRouterConfig({
    ...(authCtx.codexConfigTomlPath ? { configPath: authCtx.codexConfigTomlPath } : {}),
  });
  const config: AuthConfig = {
    mode: "byok",
    byokProvider: "openai",
    byokConfiguredAt: Date.now(),
    ...(typeof body.displayName === "string" && body.displayName.trim().length > 0
      ? { byokDisplayName: body.displayName.trim() }
      : {}),
    schemaVersion: 1,
  };
  await writeAuthConfig(config, authCtx.authConfigPath);
  return jsonResponse(res, 200, publicAuthResponse(config));
}

/**
 * OpenRouter direct connect is currently unsupported because the codex
 * CLI removed `wire_api = "chat"` (PR openai/codex#10157, shipped Feb
 * 2026) and OpenRouter does not expose a `/v1/responses` endpoint.
 * See https://github.com/openai/codex/discussions/7782 for context.
 *
 * The handler stays wired so older UI builds get a clear 410 instead
 * of a confusing 400 / 500 when they POST a key. We also opportunistically
 * scrub any stale OpenRouter config left over from earlier yyvideoclaw
 * builds so the codex CLI stops failing on `wire_api = "chat"`.
 */
async function handleByokOpenRouter(
  res: ServerResponse,
  _body: ByokRequestBody,
  authCtx: AuthRouteContext,
): Promise<boolean> {
  // Best-effort cleanup. Failures here don't block the 410 — we want
  // the user to see the "unsupported" message even if the toml/sidecar
  // happens to be on a read-only volume.
  await deleteOpenRouterKey(authCtx.openRouterKeyPath).catch(() => undefined);
  await removeOpenRouterConfig({
    ...(authCtx.codexConfigTomlPath ? { configPath: authCtx.codexConfigTomlPath } : {}),
  }).catch(() => undefined);
  return jsonResponse(res, 410, {
    error: "openrouter_unsupported",
    detail:
      "Direct OpenRouter integration is disabled because the codex CLI " +
      'removed `wire_api = "chat"` and OpenRouter does not provide a ' +
      "Responses API. See https://github.com/openai/codex/discussions/7782.",
  });
}

// ---------------------------------------------------------------------------
// GET /remotion-ai/auth/status
// ---------------------------------------------------------------------------

export function makeAuthStatusHandler(authCtx: AuthRouteContext = {}): RouteHandler {
  return async (req, res, _ctx) => {
    if (req.method !== "GET") {
      return methodNotAllowed(res, "GET");
    }
    const config = await readAuthConfig(authCtx.authConfigPath);
    return jsonResponse(res, 200, publicAuthResponse(config));
  };
}

// ---------------------------------------------------------------------------
// GET /remotion-ai/auth/usage
//
// Convenience: queries the backend for the latest credit count and
// updates the cached value in auth.json so the UI status row stays
// accurate without every panel render making an external request.
// ---------------------------------------------------------------------------

export function makeAuthUsageHandler(authCtx: AuthRouteContext = {}): RouteHandler {
  return async (req, res, _ctx) => {
    if (req.method !== "GET") {
      return methodNotAllowed(res, "GET");
    }
    const config = await readAuthConfig(authCtx.authConfigPath);
    if (config.mode !== "hosted" || !config.hostedToken) {
      return jsonResponse(res, 200, {
        usage: null,
        reason: config.mode === "byok" ? "byok_no_quota" : "not_logged_in",
      });
    }
    const backend = authCtx.backend ?? new AuthBackend();
    const result = await backend.usage(config.hostedToken);
    if ("kind" in result) {
      // 401 → token went stale; degrade to "unset" so the UI prompts
      // the user to log in again. Other errors leave the cache alone.
      if (result.kind === "invalid_credentials") {
        const next: AuthConfig = { mode: "unset", schemaVersion: 1 };
        await writeAuthConfig(next, authCtx.authConfigPath);
        return jsonResponse(res, 401, { error: "session_expired" });
      }
      return jsonResponse(res, 502, {
        error: "backend_unreachable",
        detail: "detail" in result ? result.detail : "",
      });
    }
    const next: AuthConfig = {
      ...config,
      hostedRemainingCredits: result.remainingCredits,
      hostedRefreshedAt: Date.now(),
    };
    await writeAuthConfig(next, authCtx.authConfigPath);
    return jsonResponse(res, 200, {
      usage: result,
      auth: toPublicStatus(next),
    });
  };
}
// ---------------------------------------------------------------------------
// GET /remotion-ai/auth/openrouter/models
//
// Currently disabled: OpenRouter direct connect is not viable while
// codex enforces `wire_api = "responses"`. We keep the route registered
// (and tests/UI keep their references) so older clients see a 410 with
// a clear reason instead of a 404 that looks like a build error.
// ---------------------------------------------------------------------------

export function makeAuthOpenRouterModelsHandler(_authCtx: AuthRouteContext = {}): RouteHandler {
  return async (req, res, _ctx) => {
    if (req.method !== "GET") {
      return methodNotAllowed(res, "GET");
    }
    return jsonResponse(res, 410, {
      error: "openrouter_unsupported",
      detail:
        "OpenRouter direct connect is disabled while the codex CLI " +
        'requires `wire_api = "responses"`. See ' +
        "https://github.com/openai/codex/discussions/7782.",
      models: [],
    });
  };
}
