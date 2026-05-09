// Template entry-point resolver.
//
// SECURITY-CRITICAL. This module is the single choke point that decides
// whether a caller-supplied path is allowed to be used as a Remotion render
// entry point. It must not be bypassed; all tool handlers funnel through
// `resolveTemplateEntryPoint()` before any filesystem or Remotion API call
// touches the caller-supplied value.
//
// Rules enforced:
//   1. The input MUST be an absolute path. Relative paths are rejected so
//      that ambient cwd cannot change the allowlist decision.
//   2. The path and every `templateRoots` entry are canonicalised with
//      `fs.realpath`. This resolves `..` segments AND follows symlinks, so an
//      attacker cannot escape an allowed root via a symlink placed inside it
//      (or via an allowlist root that itself is a symlink).
//   3. The canonical entry point must be strictly inside a canonical
//      allowlist root. A path that equals a root is accepted (templates may
//      live at the root), but we require a path-separator boundary when the
//      entry is a descendant to avoid the classic
//      `/opt/allow` vs `/opt/allow-attacker` prefix-match bug.
//   4. The target must resolve to a regular file. Directories, sockets, and
//      devices are rejected.

import { promises as fs } from "node:fs";
import path from "node:path";

export class TemplateResolutionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not-absolute"
      | "not-in-allowlist"
      | "not-a-file"
      | "realpath-failed"
      | "empty-allowlist",
  ) {
    super(message);
    this.name = "TemplateResolutionError";
  }
}

interface ResolveArgs {
  entryPoint: string;
  templateRoots: readonly string[];
}

/**
 * Canonicalise a path with `realpath`. Wraps ENOENT / EACCES into a typed
 * error so callers can distinguish "caller passed a bad path" from a real
 * filesystem outage.
 */
async function canonicalise(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    throw new TemplateResolutionError(
      `failed to canonicalise path (${code}): ${p}`,
      "realpath-failed",
    );
  }
}

/**
 * Check whether `child` is `parent` or strictly nested inside it, using
 * path-separator boundaries to avoid the `/opt/allow` vs `/opt/allow-attacker`
 * prefix-match bug.
 */
function isWithin(parent: string, child: string): boolean {
  if (child === parent) {
    return true;
  }
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

export async function resolveTemplateEntryPoint({
  entryPoint,
  templateRoots,
}: ResolveArgs): Promise<string> {
  if (templateRoots.length === 0) {
    throw new TemplateResolutionError(
      "templateRoots allowlist is empty; configure it before using Remotion tools",
      "empty-allowlist",
    );
  }

  if (!path.isAbsolute(entryPoint)) {
    throw new TemplateResolutionError(
      `entryPoint must be an absolute path, got: ${entryPoint}`,
      "not-absolute",
    );
  }

  const canonicalEntry = await canonicalise(entryPoint);

  const canonicalRoots = await Promise.all(
    templateRoots.map(async (root) => {
      if (!path.isAbsolute(root)) {
        // Should have been caught by config.ts; keep a defence-in-depth check.
        throw new TemplateResolutionError(
          `templateRoots entry must be absolute, got: ${root}`,
          "not-absolute",
        );
      }
      return canonicalise(root);
    }),
  );

  const allowed = canonicalRoots.some((root) => isWithin(root, canonicalEntry));
  if (!allowed) {
    throw new TemplateResolutionError(
      `entryPoint is not inside any configured templateRoots: ${entryPoint}`,
      "not-in-allowlist",
    );
  }

  const stat = await fs.stat(canonicalEntry);
  if (!stat.isFile()) {
    throw new TemplateResolutionError(
      `entryPoint must resolve to a regular file: ${canonicalEntry}`,
      "not-a-file",
    );
  }

  return canonicalEntry;
}
