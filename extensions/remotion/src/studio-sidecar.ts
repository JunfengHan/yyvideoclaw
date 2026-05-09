// Optional sidecar metadata for Remotion templates.
//
// A Remotion template project may place a `studio.json` next to its
// entryPoint to expose UI hints to the Remotion Studio tab. This file is
// PURELY OPTIONAL — when absent the UI falls back to a free-form JSON
// textarea for inputProps. When present, the UI builds a structured form
// from the declared `inputPropsSchema`.
//
// Format (JSON, schema below):
//
//   {
//     "compositions": {
//       "<compositionId>": {
//         "label": "Hello World",
//         "description": "Simple gradient title card",
//         "inputPropsSchema": { ...JSON Schema (subset)... }
//       }
//     }
//   }
//
// JSON-Schema subset supported by the UI form renderer:
//   - top-level type: "object"
//   - properties whose type is "string" | "number" | "integer" | "boolean"
//   - "enum" arrays on string fields render as a <select>
//   - "default" used as the initial form value
//   - "description" rendered as a tooltip / hint
//
// Anything outside that subset → UI falls back to JSON textarea with a
// "schema too complex for form" banner. We intentionally keep the parser
// strict and small; a richer form generator can come later.
//
// Why a sidecar JSON file (vs. extracting `<Composition schema={zod}>`
// at render time): zero build-time coupling, zero new deps, instant
// reloads when authors edit the metadata, and no need to load arbitrary
// user code into the plugin process to discover schema. Keeps the trust
// boundary tight (Phase 1 sandbox semantics unchanged).

import { promises as fs } from "node:fs";
import path from "node:path";

export interface StudioCompositionMetadata {
  /** Display label; defaults to the compositionId in the UI. */
  label?: string;
  /** Short prose shown next to the form. */
  description?: string;
  /** JSON-Schema-shaped declaration; see header comment for supported subset. */
  inputPropsSchema?: Record<string, unknown>;
}

export interface StudioMetadata {
  compositions: Record<string, StudioCompositionMetadata>;
}

const SIDECAR_FILENAME = "studio.json";
/**
 * Cap on sidecar file size. The metadata is read on every templates request,
 * so we want a tight bound. 64KB is comfortably more than any reasonable
 * schema declaration.
 */
const MAX_SIDECAR_BYTES = 64 * 1024;

/**
 * Locate `studio.json` next to a template entryPoint.
 *
 * Search order (first hit wins):
 *   1. <dirname(entryPoint)>/studio.json
 *   2. <dirname(dirname(entryPoint))>/studio.json   (when entryPoint is in a `src/` subdir)
 *
 * Returns `null` (not throws) when no sidecar exists or it's malformed.
 * Errors are NEVER fatal to the caller — the absence of metadata MUST always
 * be a graceful fallback.
 */
export async function loadStudioSidecar(entryPoint: string): Promise<StudioMetadata | null> {
  const candidates = computeSidecarCandidates(entryPoint);
  for (const candidate of candidates) {
    const result = await tryReadSidecar(candidate);
    if (result) {
      return result;
    }
  }
  return null;
}

export function computeSidecarCandidates(entryPoint: string): string[] {
  const entryDir = path.dirname(entryPoint);
  const parentDir = path.dirname(entryDir);
  const candidates = [path.join(entryDir, SIDECAR_FILENAME)];
  // Only walk up one level — and only if the entryPoint sits in something that
  // looks like a `src/` subdir. Walking further has no upside and risks
  // crossing into the project root parent (which may or may not be in the
  // templateRoots allowlist).
  if (path.basename(entryDir) === "src" && parentDir !== entryDir) {
    candidates.push(path.join(parentDir, SIDECAR_FILENAME));
  }
  return candidates;
}

async function tryReadSidecar(absPath: string): Promise<StudioMetadata | null> {
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SIDECAR_BYTES) {
    return null;
  }
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return validateStudioMetadata(parsed);
}

/**
 * Best-effort validation. Anything that doesn't fit the expected shape is
 * silently dropped from the result, never thrown. The UI is responsible for
 * gracefully falling back to a JSON textarea when metadata is partial.
 */
export function validateStudioMetadata(value: unknown): StudioMetadata | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const rawComps = value.compositions;
  if (!isPlainObject(rawComps)) {
    return null;
  }
  const compositions: Record<string, StudioCompositionMetadata> = {};
  for (const [id, entry] of Object.entries(rawComps)) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const meta: StudioCompositionMetadata = {};
    if (typeof entry.label === "string") {
      meta.label = entry.label;
    }
    if (typeof entry.description === "string") {
      meta.description = entry.description;
    }
    if (isPlainObject(entry.inputPropsSchema)) {
      meta.inputPropsSchema = entry.inputPropsSchema;
    }
    compositions[id] = meta;
  }
  return { compositions };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
