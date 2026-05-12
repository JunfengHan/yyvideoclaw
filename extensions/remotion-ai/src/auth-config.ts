// extensions/remotion-ai/src/auth-config.ts
//
// User-facing AI auth configuration for the remotion-ai plugin. Backs the
// "Hosted (yyvideoclaw)" vs "Bring-your-own OpenAI key" choice exposed in
// the Remotion Studio AI Create panel.
//
// Storage:
//   ~/.openclaw/remotion-ai/auth.json   (mode 0600)
//
// Why a separate file (not openclaw.json)?
//   1. It contains a session token (hosted mode) that we don't want to bake
//      into the user's git-tracked or shared `openclaw.json`.
//   2. It needs to round-trip from a UI form, not from manual TOML editing.
//   3. It's plugin-scoped, not gateway-scoped — putting it in openclaw.json
//      blurs the line between "platform config" and "per-feature user state".
//
// Threat model (M1 scope):
//   - The hosted token is a long-lived bearer token issued by the
//     yyvideoclaw backend. We rely on the home directory + 0600 perms for
//     at-rest protection. This matches the standard pattern of `~/.codex/
//     auth.json` and `~/.aws/credentials`.
//   - We deliberately do NOT call out to system keychain in M1 — the
//     cross-platform keychain bindings are too much surface for the first
//     iteration. A future revision can swap the storage backend without
//     touching call-sites.
//   - The OpenAI API key in `byok` mode is NOT stored in this file. It is
//     written to `~/.codex/auth.json` (the standard codex CLI location)
//     so that the bundled `@openai/codex` binary picks it up unmodified.
//     This file only records THAT byok was configured, not the secret.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where the auth.json file lives. Exported so tests can override the dir. */
export function defaultAuthConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".openclaw", "remotion-ai", "auth.json");
}

/**
 * Auth modes:
 *   - `unset`:  user has not made a choice yet → UI shows the modal,
 *               orchestrator REJECTS submit() with `auth_required`.
 *   - `hosted`: user logged in to yyvideoclaw backend; spawn codex with
 *               OPENAI_BASE_URL + OPENAI_API_KEY pointing at our proxy.
 *   - `byok`:   user pasted an OpenAI-compatible key, written to either
 *               ~/.codex/auth.json (for the OpenAI provider) OR
 *               ~/.codex/config.toml + env injection (for OpenRouter).
 *               This file only records THE CHOICE, never the secret.
 */
export type AuthMode = "unset" | "hosted" | "byok";

/**
 * Which OpenAI-compatible provider the user picked when in `byok` mode.
 * Drives where the key gets persisted and how codex is launched:
 *
 *   - "openai":     key → ~/.codex/auth.json; codex CLI default behaviour.
 *   - "openrouter": key → env var (OPENROUTER_API_KEY) at spawn time +
 *                   ~/.codex/config.toml `[model_providers.openrouter]`
 *                   block + `model_provider = "openrouter"` so codex
 *                   talks to OpenRouter's chat-completions endpoint
 *                   instead of OpenAI's responses API.
 */
export type ByokProvider = "openai" | "openrouter";

export interface AuthConfig {
  readonly mode: AuthMode;
  /** yyvideoclaw session token; only present when mode === "hosted". */
  readonly hostedToken?: string;
  /** Email/handle the user logged in with; for the UI status row. */
  readonly hostedUserEmail?: string;
  /** Backend reports remaining quota; cached for the status row. */
  readonly hostedRemainingCredits?: number | null;
  /** Last refresh timestamp (ms). Stale entries can trigger a backend re-check. */
  readonly hostedRefreshedAt?: number;
  /** Marker that byok was configured at least once. The actual key lives
   *  in ~/.codex/auth.json (openai) or in env-injected runtime state
   *  (openrouter — the key is written by `byok-store.writeOpenRouterAuth`
   *  to a 0600 sidecar that `codex-launcher.cjs` consumes at spawn). */
  readonly byokConfiguredAt?: number;
  /** Email/handle attached to the byok key (best-effort, from key intro echo). */
  readonly byokDisplayName?: string;
  /** Which provider the byok credential is for. Defaults to "openai" on
   *  legacy sidecars that predate the openrouter option. */
  readonly byokProvider?: ByokProvider;
  /** Selected model id when byokProvider === "openrouter" (e.g.
   *  "anthropic/claude-3.5-sonnet"). Required for the OpenRouter path
   *  because codex must know which provider/model slug to send. */
  readonly byokModel?: string;
  /** Schema version for future migrations. */
  readonly schemaVersion: 1;
}

const DEFAULT_CONFIG: AuthConfig = { mode: "unset", schemaVersion: 1 };

/** Read the auth.json file. Returns the default `unset` config if missing
 *  or unreadable — never throws. Bad JSON, schema mismatch, or permission
 *  errors all degrade silently to "unset" so the UI can recover by walking
 *  the user through the modal again. */
export async function readAuthConfig(authPath?: string): Promise<AuthConfig> {
  const file = authPath ?? defaultAuthConfigPath();
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return DEFAULT_CONFIG;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AuthConfig>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.schemaVersion !== 1 ||
      !isAuthMode(parsed.mode)
    ) {
      return DEFAULT_CONFIG;
    }
    return {
      mode: parsed.mode,
      schemaVersion: 1,
      ...(typeof parsed.hostedToken === "string" ? { hostedToken: parsed.hostedToken } : {}),
      ...(typeof parsed.hostedUserEmail === "string"
        ? { hostedUserEmail: parsed.hostedUserEmail }
        : {}),
      ...(typeof parsed.hostedRemainingCredits === "number" ||
      parsed.hostedRemainingCredits === null
        ? { hostedRemainingCredits: parsed.hostedRemainingCredits }
        : {}),
      ...(typeof parsed.hostedRefreshedAt === "number"
        ? { hostedRefreshedAt: parsed.hostedRefreshedAt }
        : {}),
      ...(typeof parsed.byokConfiguredAt === "number"
        ? { byokConfiguredAt: parsed.byokConfiguredAt }
        : {}),
      ...(typeof parsed.byokDisplayName === "string"
        ? { byokDisplayName: parsed.byokDisplayName }
        : {}),
      ...(parsed.byokProvider === "openai" || parsed.byokProvider === "openrouter"
        ? { byokProvider: parsed.byokProvider }
        : {}),
      ...(typeof parsed.byokModel === "string" && parsed.byokModel.length > 0
        ? { byokModel: parsed.byokModel }
        : {}),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Write the auth.json file with 0600 permissions. Creates the parent
 *  directory recursively if missing. */
export async function writeAuthConfig(config: AuthConfig, authPath?: string): Promise<void> {
  const file = authPath ?? defaultAuthConfigPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write atomically through a temp file to avoid leaving a half-written
  // auth.json on crash. mode 0600 keeps tokens out of other users' eyes.
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Public-safe view of the auth config — the bearer token is stripped so
 *  the HTTP /auth/status endpoint can return it directly. */
export interface PublicAuthStatus {
  readonly mode: AuthMode;
  readonly hostedUserEmail?: string;
  readonly hostedRemainingCredits?: number | null;
  readonly hostedRefreshedAt?: number;
  readonly byokConfiguredAt?: number;
  readonly byokDisplayName?: string;
  readonly byokProvider?: ByokProvider;
  readonly byokModel?: string;
}

export function toPublicStatus(config: AuthConfig): PublicAuthStatus {
  return {
    mode: config.mode,
    ...(config.hostedUserEmail !== undefined ? { hostedUserEmail: config.hostedUserEmail } : {}),
    ...(config.hostedRemainingCredits !== undefined
      ? { hostedRemainingCredits: config.hostedRemainingCredits }
      : {}),
    ...(config.hostedRefreshedAt !== undefined
      ? { hostedRefreshedAt: config.hostedRefreshedAt }
      : {}),
    ...(config.byokConfiguredAt !== undefined ? { byokConfiguredAt: config.byokConfiguredAt } : {}),
    ...(config.byokDisplayName !== undefined ? { byokDisplayName: config.byokDisplayName } : {}),
    ...(config.byokProvider !== undefined ? { byokProvider: config.byokProvider } : {}),
    ...(config.byokModel !== undefined ? { byokModel: config.byokModel } : {}),
  };
}

function isAuthMode(value: unknown): value is AuthMode {
  return value === "unset" || value === "hosted" || value === "byok";
}
