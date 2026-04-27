// build-backend.mjs — Video Studio backend packaging driver.
//
// Bundles the `yy-Pixelle-Video` FastAPI backend (`api/app.py` + the
// `pixelle_video` package) into a single-file executable `pixelle-backend`
// that yyvideoclaw can lazily spawn from `dist-runtime/video-studio/`. The
// canonical upstream runs on Python + uv; we drive PyInstaller to produce a
// self-contained binary so users do not need to install Python themselves.
//
// Responsibilities:
//
//   1. Resolve the Pixelle source tree (default: a sibling working copy; CLI
//      / env override to allow CI mirrors).
//   2. Provision an isolated build virtualenv via `uv` so host tooling is not
//      polluted; install the project + pyinstaller + platform extras.
//   3. Invoke PyInstaller with a spec tailored for Pixelle's entry point and
//      ship the output to
//      `dist-runtime/video-studio/<platform>-<arch>/pixelle-backend[.exe]`.
//   4. Record a versions manifest next to the binary so
//      `src/video-studio/installer.ts` can detect the shipped version at
//      runtime without re-parsing PyInstaller metadata.
//
// The script is deliberately dependency-free on the Node side (stdlib only)
// so it can be invoked from CI shells that have not yet run `pnpm install`.
//
// Usage:
//
//   node scripts/video-studio/build-backend.mjs \\
//       [--pixelle-src <path>]     (default: ../yy-Pixelle-Video)
//       [--output <dir>]           (default: dist-runtime/video-studio)
//       [--platform <os-arch>]     (default: host)
//       [--skip-venv]              (reuse an existing .venv for faster iter)
//       [--dry-run]                (print the plan and exit 0)

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Argument parsing (tiny, on purpose — no yargs dep in a bootstrap script).
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    pixelleSrc: path.resolve(REPO_ROOT, "..", "yy-Pixelle-Video"),
    output: path.join(REPO_ROOT, "dist-runtime", "video-studio"),
    platform: undefined,
    skipVenv: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--pixelle-src":
        opts.pixelleSrc = path.resolve(argv[++i] ?? "");
        break;
      case "--output":
        opts.output = path.resolve(argv[++i] ?? "");
        break;
      case "--platform":
        opts.platform = argv[++i];
        break;
      case "--skip-venv":
        opts.skipVenv = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(
    [
      "Usage: node scripts/video-studio/build-backend.mjs [options]",
      "",
      "  --pixelle-src <path>   Path to the yy-Pixelle-Video source tree.",
      "  --output <dir>         Directory receiving the packaged binary.",
      "  --platform <os-arch>   Override platform tag (default: host).",
      "  --skip-venv            Reuse an existing .venv to iterate faster.",
      "  --dry-run              Print the plan and exit without running it.",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Platform helpers.
// ---------------------------------------------------------------------------

function hostPlatformTag() {
  const platformMap = { darwin: "darwin", linux: "linux", win32: "win32" };
  const archMap = { arm64: "arm64", x64: "x64" };
  const p = platformMap[process.platform];
  const a = archMap[process.arch];
  if (!p || !a) {
    throw new Error(`Unsupported host: ${process.platform}-${process.arch}`);
  }
  return `${p}-${a}`;
}

function binaryName(platformTag) {
  return platformTag.startsWith("win32") ? "pixelle-backend.exe" : "pixelle-backend";
}

// ---------------------------------------------------------------------------
// Tool resolution (uv, python, pyinstaller) — we surface clear errors rather
// than letting spawn failures confuse the reader.
// ---------------------------------------------------------------------------

function requireExecutable(bin) {
  const res = spawnSync(bin, ["--version"], { stdio: "ignore" });
  if (res.error || res.status !== 0) {
    throw new Error(
      `Required executable "${bin}" was not found on PATH. ` +
        "Install it before running build-backend.mjs.",
    );
  }
}

// ---------------------------------------------------------------------------
// Build steps.
// ---------------------------------------------------------------------------

function provisionVenv(pixelleSrc, venvDir, { skipVenv }) {
  if (skipVenv && fs.existsSync(venvDir)) {
    logStep(`Reusing existing venv at ${venvDir}`);
    return;
  }
  logStep(`Creating build venv at ${venvDir}`);
  execFileSync("uv", ["venv", venvDir], { stdio: "inherit", cwd: pixelleSrc });
  logStep("Installing Pixelle + PyInstaller into venv");
  execFileSync(
    "uv",
    ["pip", "install", "--python", pythonBinIn(venvDir), "-e", ".", "pyinstaller>=6.0"],
    { stdio: "inherit", cwd: pixelleSrc },
  );
}

function pythonBinIn(venvDir) {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

function runPyInstaller(pixelleSrc, venvDir, outDir, platformTag) {
  const binName = binaryName(platformTag);
  const distPath = path.join(outDir, platformTag);
  fs.mkdirSync(distPath, { recursive: true });

  // `api.app:app` is the FastAPI ASGI app; wrap it with uvicorn entry via a
  // tiny shim in the same directory as the spec to avoid touching upstream.
  const shimPath = writeEntryShim(outDir, pixelleSrc);

  logStep(`Packaging ${binName} → ${distPath}`);
  execFileSync(
    pythonBinIn(venvDir),
    [
      "-m",
      "PyInstaller",
      "--noconfirm",
      "--clean",
      "--onefile",
      "--name",
      binName.replace(/\.exe$/, ""),
      "--distpath",
      distPath,
      "--workpath",
      path.join(outDir, ".pyinstaller-build", platformTag),
      "--specpath",
      path.join(outDir, ".pyinstaller-spec", platformTag),
      // Pixelle ships HTML frame templates + BGM as data next to the code;
      // bundle them so the onefile binary is self-contained.
      "--add-data",
      `${path.join(pixelleSrc, "templates")}${dataSep()}templates`,
      "--add-data",
      `${path.join(pixelleSrc, "bgm")}${dataSep()}bgm`,
      "--add-data",
      `${path.join(pixelleSrc, "workflows")}${dataSep()}workflows`,
      shimPath,
    ],
    { stdio: "inherit", cwd: pixelleSrc },
  );

  return path.join(distPath, binName);
}

function dataSep() {
  // PyInstaller uses `:` on POSIX and `;` on Windows for --add-data.
  return process.platform === "win32" ? ";" : ":";
}

function writeEntryShim(outDir, pixelleSrc) {
  const shimDir = path.join(outDir, ".entry");
  fs.mkdirSync(shimDir, { recursive: true });
  const shimPath = path.join(shimDir, "pixelle_backend_entry.py");
  // A minimal uvicorn launcher so we don't have to modify upstream's
  // `api/app.py`. The shim reads the bind address from env (set by
  // yyvideoclaw's supervisor) and stays embedded-mode friendly.
  const shim = [
    "import os",
    "import sys",
    "",
    "# When PyInstaller freezes Python packages they are extracted under",
    "# sys._MEIPASS; make sure Pixelle's own packages are importable too.",
    "if getattr(sys, '_MEIPASS', None):",
    "    sys.path.insert(0, sys._MEIPASS)",
    "",
    "def main() -> None:",
    "    import uvicorn",
    "    host = os.environ.get('PIXELLE_HOST', '127.0.0.1')",
    "    port = int(os.environ.get('PIXELLE_PORT', '0'))",
    "    uvicorn.run('api.app:app', host=host, port=port, log_level='info')",
    "",
    "if __name__ == '__main__':",
    "    main()",
    "",
  ].join("\n");
  fs.writeFileSync(shimPath, shim, "utf8");
  // Help PyInstaller discover upstream's source root.
  const pthPath = path.join(shimDir, "pixelle_src.pth");
  fs.writeFileSync(pthPath, pixelleSrc, "utf8");
  return shimPath;
}

function writeManifest(outDir, platformTag, binaryPath, pixelleSrc) {
  const manifestPath = path.join(outDir, platformTag, "manifest.json");
  const version = readPixelleVersion(pixelleSrc);
  const commit = tryGitCommit(pixelleSrc);
  const manifest = {
    name: "pixelle-backend",
    platform: platformTag,
    binary: path.basename(binaryPath),
    pixelleVersion: version,
    pixelleCommit: commit,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  logStep(`Wrote manifest to ${manifestPath}`);
}

function readPixelleVersion(pixelleSrc) {
  try {
    const pyproject = fs.readFileSync(path.join(pixelleSrc, "pyproject.toml"), "utf8");
    const match = /^version\s*=\s*"([^"]+)"/m.exec(pyproject);
    return match ? match[1] : "unknown";
  } catch {
    return "unknown";
  }
}

function tryGitCommit(pixelleSrc) {
  try {
    const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: pixelleSrc, encoding: "utf8" });
    if (res.status === 0) {
      return (res.stdout ?? "").trim();
    }
  } catch {
    // best-effort metadata; ignore failures.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

function logStep(msg) {
  // eslint-disable-next-line no-console
  console.log(`\u001B[36m[video-studio/build]\u001B[0m ${msg}`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const platformTag = opts.platform ?? hostPlatformTag();

  if (!fs.existsSync(opts.pixelleSrc)) {
    throw new Error(
      `Pixelle source tree not found at ${opts.pixelleSrc}. ` +
        "Pass --pixelle-src or clone the repo as a sibling of yyvideoclaw.",
    );
  }

  const venvDir = path.join(opts.output, ".venv", platformTag);
  const plan = {
    pixelleSrc: opts.pixelleSrc,
    output: opts.output,
    platform: platformTag,
    venvDir,
    skipVenv: opts.skipVenv,
  };

  logStep(`Plan: ${JSON.stringify(plan, null, 2)}`);

  if (opts.dryRun) {
    logStep("Dry-run requested; exiting without building.");
    return;
  }

  requireExecutable("uv");
  provisionVenv(opts.pixelleSrc, venvDir, opts);
  const binaryPath = runPyInstaller(opts.pixelleSrc, venvDir, opts.output, platformTag);
  writeManifest(opts.output, platformTag, binaryPath, opts.pixelleSrc);
  logStep(`Done: ${binaryPath}`);
}

try {
  main();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(
    `\u001B[31m[video-studio/build] ${err instanceof Error ? err.message : String(err)}\u001B[0m`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Exports for tests — kept at the bottom so the "run as script" path above
// always executes first in production use.
// ---------------------------------------------------------------------------

export { binaryName, hostPlatformTag, parseArgs, readPixelleVersion };

// os/path are used by helpers above; keep the imports grouped at top but
// export nothing from them to avoid accidental coupling.
void os;
