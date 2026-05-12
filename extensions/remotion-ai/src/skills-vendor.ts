// extensions/remotion-ai/src/skills-vendor.ts
//
// Runtime side of the Remotion Agent Skills vendor pipeline. The build-time
// half (`scripts/vendor-remotion-skills.ts`) downloads the pinned
// `remotion-dev/skills` tree into `remotion-templates/ai-starter/.skills/`.
// This module copies that already-vendored tree into the per-job workspace
// so the agent has offline access to the skills regardless of network
// availability at runtime.

import { promises as fs } from "node:fs";
import path from "node:path";
import { copyDirectory } from "./workspace.js";

export interface InjectSkillsParams {
  readonly starterDir: string;
  readonly workspaceDir: string;
}

export interface InjectSkillsResult {
  readonly injected: boolean;
  /** When `injected` is false, why we skipped (placeholder VERSION, dir missing, etc.). */
  readonly reason?: string;
  readonly version?: string;
}

const SKILLS_DIRNAME = ".skills";
const VERSION_FILENAME = "VERSION";

/**
 * If `<starterDir>/.skills/` exists AND is not the placeholder VERSION,
 * copy it into `<workspaceDir>/.skills/`. Idempotent: callers may run this
 * after `prepareWorkspace` (which already cp'd `.skills/` along with the
 * rest of the starter) to refresh from a different source if needed.
 */
export async function injectRemotionSkills(
  params: InjectSkillsParams,
): Promise<InjectSkillsResult> {
  const sourceSkillsDir = path.join(params.starterDir, SKILLS_DIRNAME);
  const sourceVersionFile = path.join(sourceSkillsDir, VERSION_FILENAME);

  let versionRaw: string;
  try {
    versionRaw = await fs.readFile(sourceVersionFile, "utf8");
  } catch {
    return {
      injected: false,
      reason: `starter is missing ${SKILLS_DIRNAME}/${VERSION_FILENAME}`,
    };
  }

  const manifest = parseVersionFile(versionRaw);
  if (looksPlaceholder(manifest)) {
    return {
      injected: false,
      reason: "skills VERSION is a placeholder (run `pnpm vendor:remotion-skills --ref <sha>`)",
      ...(manifest.ref ? { version: manifest.ref } : {}),
    };
  }

  const destSkillsDir = path.join(params.workspaceDir, SKILLS_DIRNAME);
  // The starter copy in `prepareWorkspace` already copied `.skills/` if
  // present. Re-copy is harmless (overwrite) and lets callers force a
  // refresh after editing the source.
  await copyDirectory(sourceSkillsDir, destSkillsDir);
  return { injected: true, version: manifest.ref };
}

interface VersionManifest {
  readonly source?: string;
  readonly subpath?: string;
  readonly ref?: string;
  readonly sha256?: string;
  readonly vendoredAt?: string;
}

function parseVersionFile(raw: string): VersionManifest {
  const record: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    record[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return record;
}

function looksPlaceholder(manifest: VersionManifest): boolean {
  if (!manifest.ref || manifest.ref === "unvendored") {
    return true;
  }
  if (!manifest.sha256 || /^0+$/u.test(manifest.sha256)) {
    return true;
  }
  return false;
}
