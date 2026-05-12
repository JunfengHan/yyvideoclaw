// scripts/vendor-remotion-skills.ts
//
// Pin the official Remotion Agent Skills tree
// (https://github.com/remotion-dev/remotion/tree/<ref>/packages/skills)
// into `remotion-templates/ai-starter/.skills/` so remotion-ai workspaces
// get offline-capable, version-pinned guidance for the coding agent.
//
// Invocation:
//
//   pnpm vendor:remotion-skills --ref <commit-or-tag>         # force refresh
//   pnpm vendor:remotion-skills --check                       # verify only
//   pnpm vendor:remotion-skills                               # default
//
// Default behavior (no flags):
//   1. Read .skills/VERSION.
//   2. If source/ref/sha256 look "vendored" and consistent, exit 0 quietly.
//   3. Otherwise, only fetch from GitHub if OPENCLAW_VENDOR_NETWORK=1 is set
//      in the environment. This keeps `pnpm build` offline-safe in sandboxed
//      CI and local loops; the maintainer runs `pnpm vendor:remotion-skills
//      --ref <sha>` explicitly to refresh the vendor.
//
// Exit codes:
//   0 — OK (vendored, or placeholder accepted in offline-default mode).
//   1 — vendor drift / invalid VERSION.
//   2 — network fetch attempted but failed.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE_REPO = "remotion-dev/remotion";
const SOURCE_SUBPATH = "packages/skills";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(REPO_ROOT, "remotion-templates", "ai-starter", ".skills");
const VERSION_FILE = path.join(SKILLS_DIR, "VERSION");

interface VersionManifest {
  readonly source: string;
  readonly subpath: string;
  readonly ref: string;
  readonly sha256: string;
  readonly vendoredAt: string;
}

type Mode = "default" | "check" | "refresh";

interface Args {
  readonly mode: Mode;
  readonly ref: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  let mode: Mode = "default";
  let ref: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check") {
      mode = "check";
    } else if (a === "--refresh" || a === "--force") {
      mode = "refresh";
    } else if (a === "--ref") {
      ref = argv[i + 1];
      i += 1;
      if (mode === "default") {
        mode = "refresh";
      }
    } else if (a?.startsWith("--ref=")) {
      ref = a.slice("--ref=".length);
      if (mode === "default") {
        mode = "refresh";
      }
    }
  }
  return { mode, ref };
}

async function readVersionManifest(): Promise<VersionManifest | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(VERSION_FILE, "utf8");
  } catch {
    return undefined;
  }
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
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    record[key] = value;
  }
  if (!record.source || !record.subpath || !record.ref || !record.sha256) {
    return undefined;
  }
  return {
    source: record.source,
    subpath: record.subpath,
    ref: record.ref,
    sha256: record.sha256,
    vendoredAt: record.vendoredAt ?? "",
  };
}

function formatVersionManifest(manifest: VersionManifest): string {
  return [
    "# Pinned Remotion Agent Skills vendor state.",
    "#",
    "# This file is written by scripts/vendor-remotion-skills.ts and consumed",
    "# by extensions/remotion-ai/src/skills-vendor.ts (runtime copy into each",
    "# AI workspace) and by the `check:vendor-remotion-skills` gate.",
    "#",
    "# Schema: key=value, stable ordering, one entry per line.",
    "# Never edit by hand — run `pnpm vendor:remotion-skills` instead.",
    "",
    `source = ${manifest.source}`,
    `subpath = ${manifest.subpath}`,
    `ref = ${manifest.ref}`,
    `sha256 = ${manifest.sha256}`,
    `vendoredAt = ${manifest.vendoredAt}`,
    "",
  ].join("\n");
}

async function listVendoredFiles(): Promise<string[]> {
  const entries: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let children: import("node:fs").Dirent[];
    try {
      children = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const relPath = rel ? `${rel}/${child.name}` : child.name;
      // VERSION and README.md are metadata, not part of the vendor tree.
      if (relPath === "VERSION" || relPath === "README.md") {
        continue;
      }
      const abs = path.join(dir, child.name);
      if (child.isDirectory()) {
        await walk(abs, relPath);
      } else if (child.isFile()) {
        entries.push(relPath);
      }
    }
  }
  await walk(SKILLS_DIR, "");
  entries.sort();
  return entries;
}

async function hashVendoredTree(): Promise<string> {
  const files = await listVendoredFiles();
  const hash = createHash("sha256");
  for (const file of files) {
    const content = await fs.readFile(path.join(SKILLS_DIR, file));
    hash.update(file);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function fetchTarballAndVendor(ref: string): Promise<VersionManifest> {
  const url = `https://codeload.github.com/${SOURCE_REPO}/tar.gz/${encodeURIComponent(ref)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `GitHub tarball fetch failed (${response.status} ${response.statusText}): ${url}`,
    );
  }
  const buf = Buffer.from(await response.arrayBuffer());
  const { extractPackagesSkillsFromTarball } =
    await import("./lib/vendor-remotion-skills-tar.js").catch(() => ({
      extractPackagesSkillsFromTarball: undefined,
    }));
  if (typeof extractPackagesSkillsFromTarball !== "function") {
    throw new Error(
      "scripts/lib/vendor-remotion-skills-tar.ts is missing. This script is split into a small " +
        "shared helper that owns the tar extraction; implement it before the first vendor refresh.",
    );
  }
  await extractPackagesSkillsFromTarball({
    tarball: buf,
    subpath: SOURCE_SUBPATH,
    destination: SKILLS_DIR,
    preserveSiblings: ["VERSION", "README.md"],
  });
  const sha256 = await hashVendoredTree();
  return {
    source: SOURCE_REPO,
    subpath: SOURCE_SUBPATH,
    ref,
    sha256,
    vendoredAt: new Date().toISOString(),
  };
}

async function writeManifest(manifest: VersionManifest): Promise<void> {
  await fs.mkdir(SKILLS_DIR, { recursive: true });
  await fs.writeFile(VERSION_FILE, formatVersionManifest(manifest), "utf8");
}

function isNetworkEnabled(): boolean {
  const flag = process.env.OPENCLAW_VENDOR_NETWORK;
  return flag === "1" || flag === "true";
}

function looksPlaceholder(manifest: VersionManifest | undefined): boolean {
  if (!manifest) {
    return true;
  }
  if (manifest.ref === "unvendored") {
    return true;
  }
  if (/^0+$/.test(manifest.sha256)) {
    return true;
  }
  return false;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await readVersionManifest();

  if (args.mode === "check") {
    if (!manifest) {
      console.error("[vendor-remotion-skills] VERSION file missing or malformed");
      return 1;
    }
    if (manifest.source !== SOURCE_REPO || manifest.subpath !== SOURCE_SUBPATH) {
      console.error(
        `[vendor-remotion-skills] VERSION source/subpath drift (got ${manifest.source}/${manifest.subpath}, expected ${SOURCE_REPO}/${SOURCE_SUBPATH})`,
      );
      return 1;
    }
    if (looksPlaceholder(manifest)) {
      console.log(
        "[vendor-remotion-skills] placeholder VERSION detected; run `pnpm vendor:remotion-skills --ref <sha>` to fetch skills.",
      );
      return 0;
    }
    const actual = await hashVendoredTree();
    if (actual !== manifest.sha256) {
      console.error(
        `[vendor-remotion-skills] vendored tree drift (tree=${actual}, manifest=${manifest.sha256})`,
      );
      return 1;
    }
    console.log(
      `[vendor-remotion-skills] OK (ref=${manifest.ref}, sha256=${manifest.sha256.slice(0, 12)}…)`,
    );
    return 0;
  }

  if (args.mode === "refresh") {
    const ref = args.ref ?? manifest?.ref;
    if (!ref || ref === "unvendored") {
      console.error("[vendor-remotion-skills] refusing to refresh: pass --ref <commit-sha-or-tag>");
      return 1;
    }
    if (!isNetworkEnabled()) {
      console.error(
        "[vendor-remotion-skills] network disabled. Set OPENCLAW_VENDOR_NETWORK=1 to fetch " +
          "the skills tarball from GitHub.",
      );
      return 2;
    }
    try {
      const refreshed = await fetchTarballAndVendor(ref);
      await writeManifest(refreshed);
      console.log(
        `[vendor-remotion-skills] refreshed (ref=${refreshed.ref}, sha256=${refreshed.sha256.slice(0, 12)}…)`,
      );
      return 0;
    } catch (error) {
      console.error(
        `[vendor-remotion-skills] refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 2;
    }
  }

  // Default mode: accept placeholder state silently so `pnpm build` stays
  // offline-safe. Only flag real drift.
  if (!manifest) {
    console.error("[vendor-remotion-skills] VERSION file missing or malformed");
    return 1;
  }
  if (manifest.source !== SOURCE_REPO || manifest.subpath !== SOURCE_SUBPATH) {
    console.error(
      `[vendor-remotion-skills] VERSION source/subpath drift (got ${manifest.source}/${manifest.subpath}, expected ${SOURCE_REPO}/${SOURCE_SUBPATH})`,
    );
    return 1;
  }
  if (looksPlaceholder(manifest)) {
    console.log(
      "[vendor-remotion-skills] skills not yet vendored (placeholder VERSION). Run " +
        "`OPENCLAW_VENDOR_NETWORK=1 pnpm vendor:remotion-skills --ref <sha>` to populate.",
    );
    return 0;
  }
  const actual = await hashVendoredTree();
  if (actual !== manifest.sha256) {
    console.error(
      `[vendor-remotion-skills] vendored tree drift (tree=${actual}, manifest=${manifest.sha256})`,
    );
    return 1;
  }
  return 0;
}

const isMain = pathToFileURL(process.argv[1] ?? "").href === import.meta.url;
if (isMain) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      console.error("[vendor-remotion-skills] unexpected error", error);
      process.exit(1);
    });
}

export { hashVendoredTree, readVersionManifest, formatVersionManifest };
export type { VersionManifest };
