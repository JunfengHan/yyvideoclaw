// extensions/remotion-ai/src/byok-store.ts
//
// Bring-your-own-key (BYOK) handling for OpenAI-compatible API keys.
// Two flavours are supported:
//
//   "openai":     The user has an OpenAI key (sk-…). We write it to
//                 ~/.codex/auth.json — the standard codex CLI location.
//                 The bundled `@openai/codex` CLI picks it up unmodified.
//
//   "openrouter": The user has an OpenRouter key (sk-or-v1-…). The codex
//                 CLI doesn't natively read this; instead it expects a
//                 `[model_providers.openrouter]` section in
//                 ~/.codex/config.toml plus the key in OPENROUTER_API_KEY.
//                 We write the toml block via `codex-config-toml.ts` and
//                 stash the key in ~/.openclaw/remotion-ai/byok-openrouter.json
//                 (0600). The orchestrator reads it at spawn time and
//                 injects it as an env var via the codex launcher, so the
//                 plaintext key never touches `process.env` of the gateway.
//
// File formats:
//   ~/.codex/auth.json
//     { "auth_mode": "apikey", "OPENAI_API_KEY": "sk-..." }
//
//   ~/.openclaw/remotion-ai/byok-openrouter.json
//     { "schemaVersion": 1, "apiKey": "sk-or-v1-..." }
//
// Threat model:
//   - Both files are written 0600 atomically (tmp + rename).
//   - Plaintext keys on disk match `codex login`'s own behaviour for
//     openai; for openrouter the file is plaintext for parity. Anyone
//     who has compromised `~` already has the key regardless.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CodexAuthFile {
  readonly auth_mode: "apikey";
  readonly OPENAI_API_KEY: string;
}

/** Default codex auth path. Tests can override. */
export function defaultCodexAuthPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".codex", "auth.json");
}

/** Default location for the OpenRouter byok sidecar. */
export function defaultOpenRouterKeyPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".openclaw", "remotion-ai", "byok-openrouter.json");
}

/** sk-... validation. Loose by design — OpenAI ships several key prefixes
 *  (sk-, sk-proj-, sk-svcacct-, sk-or-v1-, ...) and we don't want to lock
 *  users out whenever a new variant ships. The OpenRouter prefix
 *  `sk-or-v1-` is structurally just another `sk-...` key. */
const OPENAI_KEY_RE = /^sk-[A-Za-z0-9_\-]{20,}$/u;

export function isPlausibleOpenAiKey(value: unknown): value is string {
  return typeof value === "string" && OPENAI_KEY_RE.test(value.trim());
}

/** OpenRouter keys start with `sk-or-v1-`. We use this to disambiguate
 *  when the auth modal lets the user paste either kind. */
export function looksLikeOpenRouterKey(value: unknown): value is string {
  return typeof value === "string" && /^sk-or-v1-/u.test(value.trim());
}

/** Write the user's API key into ~/.codex/auth.json with 0600 perms.
 *  Atomic via temp-file + rename so a crash mid-write can't truncate the
 *  user's existing auth file. */
export async function writeCodexAuthApiKey(apiKey: string, authPath?: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!isPlausibleOpenAiKey(trimmed)) {
    throw new Error(
      "Refusing to write codex auth.json: value does not look like an OpenAI API key (expected sk-…)",
    );
  }
  const file = authPath ?? defaultCodexAuthPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const payload: CodexAuthFile = {
    auth_mode: "apikey",
    OPENAI_API_KEY: trimmed,
  };
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Read the codex auth file. Returns `null` for any read/parse failure
 *  — callers treat that as "no byok configured". */
export async function readCodexAuth(authPath?: string): Promise<CodexAuthFile | null> {
  const file = authPath ?? defaultCodexAuthPath();
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CodexAuthFile>;
    if (
      parsed.auth_mode === "apikey" &&
      typeof parsed.OPENAI_API_KEY === "string" &&
      parsed.OPENAI_API_KEY.length > 0
    ) {
      return { auth_mode: "apikey", OPENAI_API_KEY: parsed.OPENAI_API_KEY };
    }
    return null;
  } catch {
    return null;
  }
}

/** Best-effort delete. Used by the HTTP /auth/logout endpoint when a user
 *  clears byok mode and we want to make sure the secret is gone. */
export async function deleteCodexAuth(authPath?: string): Promise<void> {
  const file = authPath ?? defaultCodexAuthPath();
  try {
    await fs.rm(file, { force: true });
  } catch {
    // Best-effort — never throw.
  }
}

// ---------------------------------------------------------------------------
// OpenRouter sidecar.
// ---------------------------------------------------------------------------

interface OpenRouterKeyFile {
  readonly schemaVersion: 1;
  readonly apiKey: string;
}

/** Write the OpenRouter API key with 0600 perms. */
export async function writeOpenRouterKey(apiKey: string, keyPath?: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!looksLikeOpenRouterKey(trimmed)) {
    throw new Error(
      "Refusing to write OpenRouter sidecar: value does not look like an OpenRouter API key (expected sk-or-v1-…)",
    );
  }
  const file = keyPath ?? defaultOpenRouterKeyPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const payload: OpenRouterKeyFile = { schemaVersion: 1, apiKey: trimmed };
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Read the OpenRouter API key sidecar. Returns `null` on any failure. */
export async function readOpenRouterKey(keyPath?: string): Promise<string | null> {
  const file = keyPath ?? defaultOpenRouterKeyPath();
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OpenRouterKeyFile>;
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.apiKey === "string" &&
      parsed.apiKey.length > 0
    ) {
      return parsed.apiKey;
    }
    return null;
  } catch {
    return null;
  }
}

/** Best-effort delete the OpenRouter sidecar. */
export async function deleteOpenRouterKey(keyPath?: string): Promise<void> {
  const file = keyPath ?? defaultOpenRouterKeyPath();
  try {
    await fs.rm(file, { force: true });
  } catch {
    /* best-effort */
  }
}
