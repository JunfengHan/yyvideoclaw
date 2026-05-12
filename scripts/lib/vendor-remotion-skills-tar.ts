// scripts/lib/vendor-remotion-skills-tar.ts
//
// Minimal tar.gz extractor narrowed to the "pick a single subdirectory out
// of a GitHub codeload tarball" use case used by
// scripts/vendor-remotion-skills.ts. We do NOT add a tar dependency to the
// repo just for this. The GitHub tarball layout is:
//
//   <repo>-<ref>/<...everything...>
//
// and we only keep files whose path (after stripping the single top-level
// directory) starts with `<subpath>/`. All other entries are ignored.
//
// Supported tar entries: files (type '0'/'' and compatible pax extended
// header with path override). Symlinks, hardlinks, block/char devices, and
// fifos are intentionally rejected.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const TAR_BLOCK_SIZE = 512;

interface ExtractOptions {
  readonly tarball: Buffer;
  /** Path inside the repo to extract, e.g. "packages/skills". */
  readonly subpath: string;
  /** Absolute destination directory on disk (contents cleared first). */
  readonly destination: string;
  /** Filenames at the destination root that must be preserved across refreshes. */
  readonly preserveSiblings?: readonly string[];
}

export async function extractPackagesSkillsFromTarball(options: ExtractOptions): Promise<number> {
  const raw = await gunzip(options.tarball);
  const entries = parseTar(raw);

  // The codeload tarball wraps everything in a single top-level directory.
  // Detect it dynamically rather than guessing "<repo>-<ref>".
  const topLevel = detectTopLevelDirectory(entries);
  const subpathWithSep = options.subpath.replace(/\/+$/u, "") + "/";
  const pickedEntries: Array<{ relPath: string; entry: TarEntry }> = [];
  for (const entry of entries) {
    if (entry.type !== "file") {
      continue;
    }
    const normalized = entry.path.replace(/^\.\//, "");
    const withoutTop = topLevel ? stripPrefix(normalized, `${topLevel}/`) : normalized;
    if (withoutTop === undefined) {
      continue;
    }
    const rel = stripPrefix(withoutTop, subpathWithSep);
    if (rel === undefined || rel.length === 0) {
      continue;
    }
    // Refuse traversal. stripPrefix already ensured no leading "/", and tar
    // paths are POSIX, but defense in depth is cheap.
    if (rel.includes("..")) {
      throw new Error(`tar entry rejected (path traversal): ${entry.path}`);
    }
    pickedEntries.push({ relPath: rel, entry });
  }

  if (pickedEntries.length === 0) {
    throw new Error(
      `no entries matched subpath "${options.subpath}" inside the tarball; wrong ref or layout changed?`,
    );
  }

  await clearDestinationExceptSiblings(options.destination, options.preserveSiblings ?? []);

  pickedEntries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  for (const { relPath, entry } of pickedEntries) {
    const abs = path.join(options.destination, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, entry.body);
  }

  return pickedEntries.length;
}

async function gunzip(buffer: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    zlib.gunzip(buffer, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

type TarEntryType = "file" | "directory" | "other";

interface TarEntry {
  readonly path: string;
  readonly type: TarEntryType;
  readonly body: Buffer;
}

function parseTar(raw: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longPathOverride: string | undefined;
  while (offset + TAR_BLOCK_SIZE <= raw.length) {
    const header = raw.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      offset += TAR_BLOCK_SIZE;
      continue;
    }
    const nameField = readString(header, 0, 100);
    const sizeField = readOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const prefixField = readString(header, 345, 155);
    const bodyStart = offset + TAR_BLOCK_SIZE;
    const bodyEnd = bodyStart + sizeField;
    if (bodyEnd > raw.length) {
      throw new Error("truncated tar entry");
    }
    const body = raw.subarray(bodyStart, bodyEnd);
    const paddedEnd = bodyStart + Math.ceil(sizeField / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

    if (typeFlag === "L") {
      // GNU long-name extension; next entry uses `body` as its path.
      longPathOverride = readCString(body);
      offset = paddedEnd;
      continue;
    }
    if (typeFlag === "x" || typeFlag === "g") {
      // pax extended headers; only "path" is consulted.
      const paxPath = readPaxPath(body);
      if (paxPath !== undefined) {
        longPathOverride = paxPath;
      }
      offset = paddedEnd;
      continue;
    }

    const resolvedPath =
      longPathOverride ?? (prefixField ? `${prefixField}/${nameField}` : nameField);
    longPathOverride = undefined;

    let entryType: TarEntryType;
    if (typeFlag === "0" || typeFlag === "" || typeFlag === "\0") {
      entryType = "file";
    } else if (typeFlag === "5") {
      entryType = "directory";
    } else {
      entryType = "other";
    }

    entries.push({ path: resolvedPath, type: entryType, body });
    offset = paddedEnd;
  }
  return entries;
}

function readString(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const terminator = slice.indexOf(0);
  return slice.subarray(0, terminator === -1 ? slice.length : terminator).toString("utf8");
}

function readCString(body: Buffer): string {
  const terminator = body.indexOf(0);
  return body.subarray(0, terminator === -1 ? body.length : terminator).toString("utf8");
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  if (!text) {
    return 0;
  }
  return Number.parseInt(text, 8) || 0;
}

function readPaxPath(body: Buffer): string | undefined {
  const text = body.toString("utf8");
  for (const record of text.split(/\n/)) {
    if (!record) {
      continue;
    }
    const firstSpace = record.indexOf(" ");
    if (firstSpace <= 0) {
      continue;
    }
    const rest = record.slice(firstSpace + 1);
    const eq = rest.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = rest.slice(0, eq);
    const value = rest.slice(eq + 1);
    if (key === "path") {
      return value;
    }
  }
  return undefined;
}

function detectTopLevelDirectory(entries: readonly TarEntry[]): string | undefined {
  for (const entry of entries) {
    const normalized = entry.path.replace(/^\.\//, "");
    const slash = normalized.indexOf("/");
    if (slash <= 0) {
      continue;
    }
    return normalized.slice(0, slash);
  }
  return undefined;
}

function stripPrefix(value: string, prefix: string): string | undefined {
  if (!value.startsWith(prefix)) {
    return undefined;
  }
  return value.slice(prefix.length);
}

async function clearDestinationExceptSiblings(
  destination: string,
  preserve: readonly string[],
): Promise<void> {
  const preserved = new Set(preserve);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(destination, { withFileTypes: true });
  } catch {
    await fs.mkdir(destination, { recursive: true });
    return;
  }
  for (const entry of entries) {
    if (preserved.has(entry.name)) {
      continue;
    }
    await fs.rm(path.join(destination, entry.name), { recursive: true, force: true });
  }
}

export function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
