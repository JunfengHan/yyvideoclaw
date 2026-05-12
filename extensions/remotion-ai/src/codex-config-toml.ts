// extensions/remotion-ai/src/codex-config-toml.ts
//
// Surgical editor for `~/.codex/config.toml` — we only ever touch a
// small, well-known set of keys and leave the rest of the user's config
// untouched. This is critical because real codex installs accumulate
// state we don't own (marketplaces, plugins, projects, model_reasoning_effort,
// …) and a clobber-and-rewrite would be a nightmare.
//
// What we manage:
//
//   model_provider = "openrouter"           # top-level scalar
//   model = "<id>"                          # top-level scalar
//   [model_providers.openrouter]            # whole section
//     name = "OpenRouter"
//     base_url = "https://openrouter.ai/api/v1"
//     env_key = "OPENROUTER_API_KEY"
//     wire_api = "chat"
//
// Why a custom editor instead of a TOML library?
//   Pulling `@iarna/toml` etc. would let us round-trip parse/serialize, but:
//   - It re-orders keys and drops user comments.
//   - We only need three operations: set scalar, replace section, remove
//     section. Hand-rolled is ~150 lines and deterministic.
//   - We never write keys we don't own, so the lossy round-trip risk is
//     bounded by what's in this file.
//
// Atomic write: tmp file + rename, mode 0644 (config.toml is not a
// secret — the API key lives in env, not here).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const OPENROUTER_PROVIDER_ID = "openrouter";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_ENV_KEY = "OPENROUTER_API_KEY";

/** Default codex config path. Tests can override. */
export function defaultCodexConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".codex", "config.toml");
}

interface ConfigureOpenRouterOptions {
  /** Model id like `"anthropic/claude-3.5-sonnet"`. */
  readonly modelId: string;
  /** Override the config.toml path. Defaults to `~/.codex/config.toml`. */
  readonly configPath?: string;
}

/**
 * Apply the OpenRouter provider configuration to `~/.codex/config.toml`.
 * - Creates the file if it doesn't exist.
 * - Sets/updates the `model_provider`, `model` top-level keys.
 * - Replaces (or appends) the `[model_providers.openrouter]` section.
 * - Leaves every other line unchanged (comments, other sections, …).
 */
export async function configureCodexForOpenRouter(
  options: ConfigureOpenRouterOptions,
): Promise<void> {
  const file = options.configPath ?? defaultCodexConfigPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    // Missing file is fine; we'll create it.
    raw = "";
  }
  const next = applyOpenRouterEdits(raw, options.modelId);
  if (next === raw) {
    // Nothing to do — already configured exactly the way we'd write it.
    return;
  }
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, next, { mode: 0o644 });
  await fs.rename(tmp, file);
}

/**
 * Remove the OpenRouter-specific keys from `~/.codex/config.toml` so
 * codex falls back to its default ChatGPT/OpenAI auth path. Used when
 * the user switches modes back. Leaves everything else (other model
 * providers, plugins, projects) untouched.
 */
export async function removeOpenRouterConfig(
  options: { readonly configPath?: string } = {},
): Promise<void> {
  const file = options.configPath ?? defaultCodexConfigPath();
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return; // No config file → nothing to remove.
  }
  const next = removeOpenRouterEdits(raw);
  if (next === raw) {
    return;
  }
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, next, { mode: 0o644 });
  await fs.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Pure transforms — exported for unit testing without filesystem touches.
// ---------------------------------------------------------------------------

/** Render the canonical block we want for OpenRouter. Stable so the diff
 *  in `applyOpenRouterEdits` settles on a no-op once configured. */
function renderOpenRouterSection(): string {
  return [
    `[model_providers.${OPENROUTER_PROVIDER_ID}]`,
    `name = "OpenRouter"`,
    `base_url = "${OPENROUTER_BASE_URL}"`,
    `env_key = "${OPENROUTER_ENV_KEY}"`,
    // OpenRouter speaks OpenAI Chat Completions, NOT OpenAI's newer
    // /v1/responses API. codex defaults to "responses" for the openai
    // provider, so we MUST set this explicitly or every turn 400s.
    `wire_api = "chat"`,
    "",
  ].join("\n");
}

/**
 * Apply the OpenRouter edits to a raw toml string.
 * Exported for unit tests; production calls go through
 * `configureCodexForOpenRouter`.
 */
export function applyOpenRouterEdits(raw: string, modelId: string): string {
  let out = raw;
  // 1. Set/replace top-level `model_provider`.
  out = setOrInsertTopLevelScalar(out, "model_provider", `"${OPENROUTER_PROVIDER_ID}"`);
  // 2. Set/replace top-level `model`.
  out = setOrInsertTopLevelScalar(out, "model", `"${escapeTomlString(modelId)}"`);
  // 3. Replace (or append) the `[model_providers.openrouter]` section.
  out = replaceOrAppendSection(
    out,
    `model_providers.${OPENROUTER_PROVIDER_ID}`,
    renderOpenRouterSection(),
  );
  return out;
}

/**
 * Remove OpenRouter-specific edits. Drops:
 *   - top-level `model_provider = "openrouter"` (only if it points at us)
 *   - top-level `model = "..."` (only if model_provider was openrouter
 *     before removal, since the user might have a different OpenAI model
 *     they want to keep as the codex default)
 *   - the entire `[model_providers.openrouter]` section
 */
export function removeOpenRouterEdits(raw: string): string {
  let out = raw;
  const hadProvider = topLevelScalarMatches(out, "model_provider", `"${OPENROUTER_PROVIDER_ID}"`);
  if (hadProvider) {
    out = deleteTopLevelScalar(out, "model_provider");
    out = deleteTopLevelScalar(out, "model");
  }
  out = deleteSection(out, `model_providers.${OPENROUTER_PROVIDER_ID}`);
  return out;
}

// ---------------------------------------------------------------------------
// Tiny TOML-ish line scanner. Sufficient for the keys we touch.
// ---------------------------------------------------------------------------

/**
 * "Top level" = before the first `[section]` header. We scope our scalar
 * edits to that prefix so we never accidentally rewrite a `model = ...`
 * inside, say, `[plugins.foo]`.
 */
function topLevelEnd(src: string): number {
  const lines = src.split("\n");
  let offset = 0;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      return offset;
    }
    offset += line.length + 1;
  }
  return src.length;
}

function setOrInsertTopLevelScalar(src: string, key: string, value: string): string {
  const end = topLevelEnd(src);
  const head = src.slice(0, end);
  const tail = src.slice(end);
  // Match `^key = ...$` ignoring whitespace; handle commented-out lines
  // by NOT replacing them (we don't want to silently uncomment).
  const re = new RegExp(`^([ \\t]*)${escapeRegex(key)}[ \\t]*=[ \\t]*[^\\n]*$`, "m");
  if (re.test(head)) {
    const replaced = head.replace(re, (_m, indent) => `${indent}${key} = ${value}`);
    return replaced + tail;
  }
  // Insert at the end of the top-level block. Ensure exactly one
  // trailing newline before tail so we don't pile up blank lines.
  const trimmedHead = head.replace(/\n*$/u, "");
  const headWithKey = `${trimmedHead}${trimmedHead.length > 0 ? "\n" : ""}${key} = ${value}\n`;
  // Preserve a blank line between the new scalar and the first `[` if
  // there was one originally (keeps cosmetic spacing the user expects).
  const tailNeedsBlankLine = tail.startsWith("[") ? "\n" : "";
  return headWithKey + tailNeedsBlankLine + tail;
}

function topLevelScalarMatches(src: string, key: string, expectedValue: string): boolean {
  const end = topLevelEnd(src);
  const head = src.slice(0, end);
  const re = new RegExp(`^[ \\t]*${escapeRegex(key)}[ \\t]*=[ \\t]*([^\\n]*?)[ \\t]*$`, "m");
  const match = head.match(re);
  return Boolean(match && match[1] === expectedValue);
}

function deleteTopLevelScalar(src: string, key: string): string {
  const end = topLevelEnd(src);
  const head = src.slice(0, end);
  const tail = src.slice(end);
  const re = new RegExp(`^[ \\t]*${escapeRegex(key)}[ \\t]*=[ \\t]*[^\\n]*\\n?`, "m");
  return head.replace(re, "") + tail;
}

/**
 * Find a `[section.path]` header line. Returns `[startOfHeaderLine,
 * endOfSectionExclusive]` if found, where `endOfSectionExclusive` points
 * to the start of the next `[...]` header (or EOF). Whitespace around
 * the dotted path is tolerated; nested arrays-of-tables (`[[...]]`) are
 * NOT supported (we don't generate them).
 */
function findSection(src: string, sectionPath: string): { start: number; end: number } | null {
  const lines = src.split("\n");
  // Normalise the path so " model_providers . openrouter " matches.
  const wanted = sectionPath.replace(/\s+/gu, "");
  let offset = 0;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const headerMatch = /^\s*\[\s*([^\[\]]+?)\s*\]\s*$/u.exec(line);
    if (headerMatch) {
      const path = headerMatch[1].replace(/\s+/gu, "");
      if (start === -1 && path === wanted) {
        start = offset;
      } else if (start !== -1) {
        return { start, end: offset };
      }
    }
    offset += line.length + 1;
  }
  if (start !== -1) {
    // Section ran to EOF.
    return { start, end: src.length };
  }
  return null;
}

function replaceOrAppendSection(src: string, sectionPath: string, body: string): string {
  const found = findSection(src, sectionPath);
  if (found) {
    return src.slice(0, found.start) + body + src.slice(found.end);
  }
  // Append to EOF, ensuring a blank line separator if src is non-empty
  // and doesn't already end with two newlines.
  let prefix = src;
  if (prefix.length > 0 && !prefix.endsWith("\n")) {
    prefix += "\n";
  }
  if (prefix.length > 0 && !prefix.endsWith("\n\n")) {
    prefix += "\n";
  }
  return prefix + body;
}

function deleteSection(src: string, sectionPath: string): string {
  const found = findSection(src, sectionPath);
  if (!found) {
    return src;
  }
  // Trim a trailing blank line that the section was generating, so we
  // don't leak a double-blank artifact every time configure→remove cycles.
  let end = found.end;
  if (src.slice(end - 1, end) === "\n" && src.slice(end, end + 1) === "\n") {
    end += 1;
  }
  return src.slice(0, found.start) + src.slice(end);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function escapeTomlString(value: string): string {
  // We only need to handle the model id slot — these come from a curated
  // OpenRouter list, not free-form user input. But we still escape "
  // and \ to be defensive.
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}
