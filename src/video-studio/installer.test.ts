import { describe, expect, it, vi } from "vitest";
import {
  type BackendResolution,
  type InstallerDeps,
  type InstallerFs,
  type InstallerPath,
  type InstallerPlatformTag,
  VideoStudioInstaller,
} from "./installer.js";

// ---------------------------------------------------------------------------
// Small in-memory fakes so tests never touch the real filesystem / spawn.
// ---------------------------------------------------------------------------

function makeFakePath(): InstallerPath {
  // POSIX-style joins are sufficient for the cases covered here and keep
  // assertions readable regardless of the host platform running the tests.
  return {
    join: (...segments: string[]) => segments.filter(Boolean).join("/").replace(/\/+/g, "/"),
    dirname: (p: string) => {
      const idx = p.lastIndexOf("/");
      return idx <= 0 ? "/" : p.slice(0, idx);
    },
    resolve: (...segments: string[]) => segments.filter(Boolean).join("/").replace(/\/+/g, "/"),
  };
}

type FakeFs = InstallerFs & {
  readonly files: Map<string, string>;
  readonly dirs: Set<string>;
  seedFile(p: string, content: string): void;
};

function makeFakeFs(): FakeFs {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const fs: FakeFs = {
    files,
    dirs,
    seedFile(p, content) {
      files.set(p, content);
    },
    existsSync: (p) => {
      if (files.has(p) || dirs.has(p)) return true;
      // Treat any ancestor directory of a seeded file as existing, so
      // helpers that probe the parent folder (e.g. `fs.existsSync(root)`
      // inside `uninstall()`) don't short-circuit on implicit parents.
      const prefix = `${p.replace(/\/+$/, "")}/`;
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) return true;
      }
      for (const key of dirs) {
        if (key.startsWith(prefix)) return true;
      }
      return false;
    },
    readFileSync: (p) => {
      const v = files.get(p);
      if (v === undefined) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      }
      return v;
    },
    writeFileSync: (p, data) => {
      files.set(p, data);
    },
    mkdirSync: (p, _opts) => {
      dirs.add(p);
    },
    rmSync: (p, _opts) => {
      for (const k of Array.from(files.keys())) {
        if (k === p || k.startsWith(`${p}/`)) {
          files.delete(k);
        }
      }
      for (const d of Array.from(dirs)) {
        if (d === p || d.startsWith(`${p}/`)) {
          dirs.delete(d);
        }
      }
    },
    statSync: (p) => ({
      isFile: () => files.has(p),
      isDirectory: () => dirs.has(p),
    }),
  };
  return fs;
}

const PLATFORM: InstallerPlatformTag = "darwin-arm64";

function makeDeps(fs: FakeFs, spawnSync = vi.fn()): InstallerDeps {
  // Respect any `mockReturnValue` / `mockImplementation` the caller already
  // set on the injected mock. Only install a default "exit 0" implementation
  // when the caller left the mock bare — otherwise we would clobber the
  // test's own configuration (e.g. the `uv venv failed` case).
  if (spawnSync.getMockImplementation() === undefined && spawnSync.mock.results.length === 0) {
    spawnSync.mockImplementation(() => ({
      status: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      pid: 0,
      output: [],
      signal: null,
    }));
  }
  return {
    fs,
    path: makeFakePath(),
    spawnSync: spawnSync as unknown as InstallerDeps["spawnSync"],
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("VideoStudioInstaller.resolve", () => {
  it("prefers a shipped PyInstaller binary when both manifest + executable exist", () => {
    const fs = makeFakeFs();
    const runtimeRoot = "/repo/dist-runtime/video-studio";
    fs.seedFile(`${runtimeRoot}/${PLATFORM}/pixelle-backend`, "<<binary bytes>>");
    fs.seedFile(
      `${runtimeRoot}/${PLATFORM}/manifest.json`,
      JSON.stringify({ pixelleVersion: "1.2.3" }),
    );
    const installer = new VideoStudioInstaller(
      { repoRoot: "/repo", userDataRoot: "/home/u", platform: PLATFORM, runtimeRoot },
      makeDeps(fs),
    );

    const resolution = installer.resolve() as BackendResolution & { kind: "binary" };
    expect(resolution.kind).toBe("binary");
    expect(resolution.executable).toBe(`${runtimeRoot}/${PLATFORM}/pixelle-backend`);
    expect(resolution.version).toBe("1.2.3");
  });

  it("falls back to a per-user venv when the binary is absent", () => {
    const fs = makeFakeFs();
    fs.seedFile("/home/u/video-studio/venv/bin/python", "#!/usr/bin/env python");
    fs.seedFile("/home/u/video-studio/VERSION", "0.9.0\n");
    const installer = new VideoStudioInstaller(
      {
        repoRoot: "/repo",
        userDataRoot: "/home/u",
        platform: PLATFORM,
        runtimeRoot: "/repo/dist-runtime/video-studio",
      },
      makeDeps(fs),
    );

    const resolution = installer.resolve() as BackendResolution & { kind: "venv" };
    expect(resolution.kind).toBe("venv");
    expect(resolution.python).toBe("/home/u/video-studio/venv/bin/python");
    expect(resolution.version).toBe("0.9.0");
    // Supervisor needs the source checkout to spawn Streamlit alongside FastAPI.
    expect(resolution.sourceRoot).toBe("/repo/vendor/pixelle-video");
  });

  it("reports `missing` when neither install flavour is present", () => {
    const fs = makeFakeFs();
    const installer = new VideoStudioInstaller(
      {
        repoRoot: "/repo",
        userDataRoot: "/home/u",
        platform: PLATFORM,
        runtimeRoot: "/repo/dist-runtime/video-studio",
      },
      makeDeps(fs),
    );
    expect(installer.resolve().kind).toBe("missing");
  });

  it("tolerates a malformed manifest by flagging version as `unknown` instead of throwing", () => {
    const fs = makeFakeFs();
    const runtimeRoot = "/repo/dist-runtime/video-studio";
    fs.seedFile(`${runtimeRoot}/${PLATFORM}/pixelle-backend`, "<<binary>>");
    fs.seedFile(`${runtimeRoot}/${PLATFORM}/manifest.json`, "{not valid json");
    const installer = new VideoStudioInstaller(
      { repoRoot: "/repo", userDataRoot: "/home/u", platform: PLATFORM, runtimeRoot },
      makeDeps(fs),
    );
    const resolution = installer.resolve();
    expect(resolution.kind).toBe("binary");
    if (resolution.kind === "binary") {
      expect(resolution.version).toBe("unknown");
    }
  });
});

describe("VideoStudioInstaller.install", () => {
  it("runs `uv venv` then `uv pip install -e <submodule>` and persists the VERSION file", () => {
    const fs = makeFakeFs();
    // The installer now refuses to proceed unless the submodule checkout is
    // present; seed the pyproject.toml marker file so the check passes.
    fs.seedFile("/repo/vendor/pixelle-video/pyproject.toml", '[project]\nname="pixelle-video"\n');
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      pid: 0,
      output: [],
      signal: null,
    });
    const installer = new VideoStudioInstaller(
      {
        repoRoot: "/repo",
        userDataRoot: "/home/u",
        platform: PLATFORM,
        runtimeRoot: "/repo/dist-runtime/video-studio",
      },
      makeDeps(fs, spawnSync),
    );

    installer.install({ version: "1.2.3" });

    expect(spawnSync).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = spawnSync.mock.calls;
    expect(firstCall[0]).toBe("uv");
    expect(firstCall[1]).toEqual(["venv", "/home/u/video-studio/venv"]);
    expect(secondCall[0]).toBe("uv");
    expect(secondCall[1]).toEqual([
      "pip",
      "install",
      "--python",
      "/home/u/video-studio/venv/bin/python",
      "-e",
      "/repo/vendor/pixelle-video",
    ]);
    expect(fs.files.get("/home/u/video-studio/VERSION")).toBe("1.2.3\n");
  });

  it("fails fast with a helpful hint when the submodule has not been initialised", () => {
    const fs = makeFakeFs();
    // Intentionally do NOT seed pyproject.toml — simulates a fresh clone
    // without `git submodule update --init`.
    const installer = new VideoStudioInstaller(
      {
        repoRoot: "/repo",
        userDataRoot: "/home/u",
        platform: PLATFORM,
        runtimeRoot: "/repo/dist-runtime/video-studio",
      },
      makeDeps(fs),
    );
    expect(() => installer.install({ version: "x" })).toThrow(/submodule update --init/);
  });

  it("surfaces a clear error when `uv venv` fails", () => {
    const fs = makeFakeFs();
    fs.seedFile("/repo/vendor/pixelle-video/pyproject.toml", "[project]\n");
    const spawnSync = vi.fn().mockReturnValue({
      status: 7,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      pid: 0,
      output: [],
      signal: null,
    });
    const installer = new VideoStudioInstaller(
      {
        repoRoot: "/repo",
        userDataRoot: "/home/u",
        platform: PLATFORM,
        runtimeRoot: "/repo/dist-runtime/video-studio",
      },
      makeDeps(fs, spawnSync),
    );
    expect(() => installer.install({ version: "x" })).toThrow(/uv venv failed/);
  });
});

describe("VideoStudioInstaller.uninstall", () => {
  it("wipes the per-user video-studio directory without touching dist-runtime", () => {
    const fs = makeFakeFs();
    fs.seedFile("/home/u/video-studio/venv/bin/python", "python");
    fs.seedFile("/home/u/video-studio/VERSION", "1.0.0");
    fs.seedFile("/home/u/other/stay", "intact");
    fs.seedFile("/repo/dist-runtime/video-studio/darwin-arm64/pixelle-backend", "binary");

    const installer = new VideoStudioInstaller(
      {
        repoRoot: "/repo",
        userDataRoot: "/home/u",
        platform: PLATFORM,
        runtimeRoot: "/repo/dist-runtime/video-studio",
      },
      makeDeps(fs),
    );
    installer.uninstall();

    expect(fs.files.has("/home/u/video-studio/venv/bin/python")).toBe(false);
    expect(fs.files.has("/home/u/video-studio/VERSION")).toBe(false);
    expect(fs.files.has("/home/u/other/stay")).toBe(true);
    expect(fs.files.has("/repo/dist-runtime/video-studio/darwin-arm64/pixelle-backend")).toBe(true);
  });
});
