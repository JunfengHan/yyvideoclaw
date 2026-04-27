// Installer for the embedded Video Studio backend.
//
// The installer answers three questions for the supervisor (see
// `process-manager.ts`):
//
//   1. "Where is the Pixelle binary that I should spawn?" — either a
//      PyInstaller single-file executable shipped under
//      `dist-runtime/video-studio/<platform>-<arch>/` (preferred) or a
//      Python entry point inside a `uv`-managed virtualenv under
//      `<userData>/video-studio/venv/` (fallback, auto-provisioned on
//      first launch).
//   2. "What version is installed?" — read from the manifest next to the
//      binary or `<userData>/video-studio/VERSION` for the fallback path.
//   3. "Is it up to date?" — compared against the compatibility matrix the
//      yyvideoclaw build itself ships.
//
// The module is written as a side-effect-free class with all filesystem /
// process operations injected so it can be unit-tested with in-memory
// doubles (see `installer.test.ts`). It never imports from `ui/` and never
// speaks HTTP.

import type { SpawnSyncOptionsWithBufferEncoding, SpawnSyncReturns } from "node:child_process";

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/** Abstract shape we need from Node's `node:fs`. */
export type InstallerFs = {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string, encoding: "utf8"): void;
  mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  statSync(path: string): { isFile(): boolean; isDirectory(): boolean };
};

/** Abstract shape we need from Node's `node:path`. */
export type InstallerPath = {
  join(...segments: string[]): string;
  dirname(p: string): string;
  resolve(...segments: string[]): string;
};

/** Inject-able spawn for venv provisioning (defaults to node:child_process). */
export type InstallerSpawnSync = (
  file: string,
  args: readonly string[],
  options?: SpawnSyncOptionsWithBufferEncoding,
) => SpawnSyncReturns<Buffer>;

export type InstallerPlatformTag = `${"darwin" | "linux" | "win32"}-${"arm64" | "x64"}`;

export type InstallerConfig = {
  /** The yyvideoclaw repo root (where `dist-runtime/` lives). */
  readonly repoRoot: string;
  /** Per-user data root (e.g. the Electron `app.getPath("userData")`). */
  readonly userDataRoot: string;
  /** Platform tag (default: derived from host). */
  readonly platform: InstallerPlatformTag;
  /** Override `dist-runtime/video-studio/` location (for tests). */
  readonly runtimeRoot?: string;
};

export type InstallerDeps = {
  readonly fs: InstallerFs;
  readonly path: InstallerPath;
  readonly spawnSync: InstallerSpawnSync;
  readonly now?: () => Date;
};

export type BackendResolution =
  | {
      readonly kind: "binary";
      readonly executable: string;
      readonly manifestPath: string;
      readonly version: string;
    }
  | {
      readonly kind: "venv";
      readonly python: string;
      readonly entryModule: string;
      readonly venvDir: string;
      readonly version: string;
    }
  | { readonly kind: "missing"; readonly reason: string };

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function platformTagFromHost(): InstallerPlatformTag {
  const p =
    process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "win32";
  const a = process.arch === "arm64" ? "arm64" : "x64";
  return `${p}-${a}` as InstallerPlatformTag;
}

function binaryNameFor(platform: InstallerPlatformTag): string {
  return platform.startsWith("win32") ? "pixelle-backend.exe" : "pixelle-backend";
}

function pythonBin(venvDir: string, platform: InstallerPlatformTag, ipath: InstallerPath): string {
  return platform.startsWith("win32")
    ? ipath.join(venvDir, "Scripts", "python.exe")
    : ipath.join(venvDir, "bin", "python");
}

// ---------------------------------------------------------------------------
// Installer.
// ---------------------------------------------------------------------------

export class VideoStudioInstaller {
  private readonly cfg: Required<
    Pick<InstallerConfig, "repoRoot" | "userDataRoot" | "platform">
  > & {
    readonly runtimeRoot: string;
  };
  private readonly deps: InstallerDeps;

  constructor(cfg: InstallerConfig, deps: InstallerDeps) {
    const platform = cfg.platform ?? platformTagFromHost();
    this.cfg = {
      repoRoot: cfg.repoRoot,
      userDataRoot: cfg.userDataRoot,
      platform,
      runtimeRoot: cfg.runtimeRoot ?? deps.path.join(cfg.repoRoot, "dist-runtime", "video-studio"),
    };
    this.deps = deps;
  }

  /**
   * Return a description of the installed backend, or `{ kind: "missing" }`
   * so the caller can kick off `install()`.
   */
  resolve(): BackendResolution {
    const binary = this.resolveBinary();
    if (binary) {
      return binary;
    }
    const venv = this.resolveVenv();
    if (venv) {
      return venv;
    }
    return {
      kind: "missing",
      reason:
        "No Pixelle backend found. Ship it in dist-runtime/video-studio/ or run install() to provision a venv.",
    };
  }

  /**
   * Provision a fallback virtualenv installation under the user data
   * directory. Called only when `resolve()` reports `missing` and the user
   * confirms the install wizard. Writes a `VERSION` file so future calls
   * short-circuit on version lookup.
   */
  install(opts: { readonly pixelleRequirement: string; readonly version: string }): void {
    const { fs, path, spawnSync } = this.deps;
    const venvDir = this.venvDir();
    const parent = path.dirname(venvDir);
    fs.mkdirSync(parent, { recursive: true });

    const uv = spawnSync("uv", ["venv", venvDir], { stdio: "inherit" });
    if (uv.status !== 0) {
      throw new Error(`uv venv failed (exit ${uv.status ?? "null"}).`);
    }
    const install = spawnSync(
      "uv",
      [
        "pip",
        "install",
        "--python",
        pythonBin(venvDir, this.cfg.platform, path),
        opts.pixelleRequirement,
      ],
      { stdio: "inherit" },
    );
    if (install.status !== 0) {
      throw new Error(`uv pip install failed (exit ${install.status ?? "null"}).`);
    }
    const versionPath = this.versionFilePath();
    fs.mkdirSync(path.dirname(versionPath), { recursive: true });
    fs.writeFileSync(versionPath, `${opts.version}\n`, "utf8");
  }

  /**
   * Fully remove the per-user install. The shipped binary under
   * `dist-runtime/` is left alone — that is application-managed state.
   */
  uninstall(): void {
    const { fs, path } = this.deps;
    const root = path.join(this.cfg.userDataRoot, "video-studio");
    if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  /** Read the pinned version from whichever install is active. */
  getInstalledVersion(): string | null {
    const r = this.resolve();
    return r.kind === "missing" ? null : r.version;
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

  private resolveBinary(): BackendResolution | null {
    const { fs, path } = this.deps;
    const dir = path.join(this.cfg.runtimeRoot, this.cfg.platform);
    const executable = path.join(dir, binaryNameFor(this.cfg.platform));
    const manifestPath = path.join(dir, "manifest.json");
    if (!fs.existsSync(executable) || !fs.existsSync(manifestPath)) {
      return null;
    }
    let version = "unknown";
    try {
      const raw = fs.readFileSync(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as { pixelleVersion?: unknown };
      if (typeof parsed.pixelleVersion === "string" && parsed.pixelleVersion.length > 0) {
        version = parsed.pixelleVersion;
      }
    } catch {
      // Manifest unreadable — still treat the binary as usable, but surface
      // `unknown` so diagnostics make the mismatch obvious.
    }
    return { kind: "binary", executable, manifestPath, version };
  }

  private resolveVenv(): BackendResolution | null {
    const { fs, path } = this.deps;
    const venvDir = this.venvDir();
    const python = pythonBin(venvDir, this.cfg.platform, path);
    if (!fs.existsSync(python)) {
      return null;
    }
    const versionPath = this.versionFilePath();
    const version = fs.existsSync(versionPath)
      ? fs.readFileSync(versionPath, "utf8").trim()
      : "unknown";
    return {
      kind: "venv",
      python,
      entryModule: "api.app:app",
      venvDir,
      version,
    };
  }

  private venvDir(): string {
    return this.deps.path.join(this.cfg.userDataRoot, "video-studio", "venv");
  }

  private versionFilePath(): string {
    return this.deps.path.join(this.cfg.userDataRoot, "video-studio", "VERSION");
  }
}

export function defaultPlatformTag(): InstallerPlatformTag {
  return platformTagFromHost();
}
