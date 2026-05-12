import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  disposeWorkspace,
  JOB_SIDECAR_RELATIVE,
  prepareWorkspace,
  readJobSidecar,
  WorkspaceError,
} from "./workspace.js";

let tmpRoot: string;

async function makeTempStarter(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-starter-"));
  await fs.writeFile(path.join(dir, "package.json"), '{"name":"x","version":"0.0.0"}');
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "index.ts"), "// entry");
  await fs.writeFile(path.join(dir, "src", "Root.tsx"), "// root");
  return dir;
}

/** Baseline set of `prepareWorkspace` args filled with safe defaults.
 *  Tests spread this + override only the field they care about. */
function baseParams(over: {
  jobId: string;
  outputRoot: string;
  starterDir: string;
  outputRootAllowlist?: readonly string[] | undefined;
  defaultOutputRoot?: string;
  prompt?: string;
  engine?: string;
  createdAt?: number;
}) {
  return {
    jobId: over.jobId,
    outputRoot: over.outputRoot,
    outputRootAllowlist: over.outputRootAllowlist,
    // When the caller doesn't supply a managed library root, use the
    // same tmp dir as outputRoot — this keeps the "no allowlist" tests
    // exercising the "output root IS the library" happy path.
    defaultOutputRoot: over.defaultOutputRoot ?? over.outputRoot,
    starterDir: over.starterDir,
    prompt: over.prompt ?? "test prompt",
    engine: over.engine ?? "codex",
    createdAt: over.createdAt ?? 1_700_000_000_000,
  };
}

describe("prepareWorkspace", () => {
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remotion-ai-out-"));
  });
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it("creates <outputRoot>/<jobId>/ and copies the starter", async () => {
    const starter = await makeTempStarter();
    try {
      const ws = await prepareWorkspace(
        baseParams({
          jobId: "job-1234",
          outputRoot: tmpRoot,
          starterDir: starter,
        }),
      );
      expect(ws.workspaceDir).toBe(path.join(await fs.realpath(tmpRoot), "job-1234"));
      const indexExists = await fs
        .stat(path.join(ws.workspaceDir, "src", "index.ts"))
        .then(() => true);
      expect(indexExists).toBe(true);
      expect(ws.entryPointRelative).toBe("src/index.ts");
      expect(ws.cacheDir).toBe(path.join(ws.workspaceDir, ".cache", "remotion-ai"));
      // The starterRootHash tripwire only works if we actually compute a
      // hash from the copied Root.tsx. Empty string would silently
      // disable the orchestrator's "agent didn't author anything" guard.
      expect(ws.starterRootHash).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await fs.rm(starter, { recursive: true, force: true });
    }
  });

  it("writes a .remotion-ai/job.json sidecar with prompt + metadata", async () => {
    const starter = await makeTempStarter();
    try {
      const ws = await prepareWorkspace(
        baseParams({
          jobId: "job-sidecar",
          outputRoot: tmpRoot,
          starterDir: starter,
          prompt: "Build a 3-second title card for 'Hello'",
          engine: "codex",
          createdAt: 1_700_000_000_000,
        }),
      );
      const sidecarPath = path.join(ws.workspaceDir, JOB_SIDECAR_RELATIVE);
      const raw = await fs.readFile(sidecarPath, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed).toMatchObject({
        jobId: "job-sidecar",
        prompt: "Build a 3-second title card for 'Hello'",
        engine: "codex",
        createdAt: 1_700_000_000_000,
        schemaVersion: 1,
      });
      // readJobSidecar round-trip.
      const read = await readJobSidecar(ws.workspaceDir);
      expect(read?.promptPreview).toContain("Hello");
    } finally {
      await fs.rm(starter, { recursive: true, force: true });
    }
  });

  it("rejects relative outputRoot", async () => {
    const starter = await makeTempStarter();
    try {
      await expect(
        prepareWorkspace(
          baseParams({
            jobId: "job-rel",
            outputRoot: "relative/path",
            starterDir: starter,
            defaultOutputRoot: tmpRoot,
          }),
        ),
      ).rejects.toBeInstanceOf(WorkspaceError);
    } finally {
      await fs.rm(starter, { recursive: true, force: true });
    }
  });

  it("rejects invalid jobId", async () => {
    const starter = await makeTempStarter();
    try {
      await expect(
        prepareWorkspace(
          baseParams({
            jobId: "../traversal",
            outputRoot: tmpRoot,
            starterDir: starter,
          }),
        ),
      ).rejects.toBeInstanceOf(WorkspaceError);
    } finally {
      await fs.rm(starter, { recursive: true, force: true });
    }
  });

  it("rejects when the starter is missing required files", async () => {
    const incomplete = await fs.mkdtemp(path.join(os.tmpdir(), "ai-starter-bad-"));
    try {
      await expect(
        prepareWorkspace(
          baseParams({
            jobId: "job-bad-starter",
            outputRoot: tmpRoot,
            starterDir: incomplete,
          }),
        ),
      ).rejects.toMatchObject({ code: "starter-missing" });
    } finally {
      await fs.rm(incomplete, { recursive: true, force: true });
    }
  });

  it("allows the managed defaultOutputRoot even without an allowlist", async () => {
    const starter = await makeTempStarter();
    try {
      // outputRoot === defaultOutputRoot → allowed implicitly.
      const ws = await prepareWorkspace(
        baseParams({
          jobId: "job-default",
          outputRoot: tmpRoot,
          defaultOutputRoot: tmpRoot,
          starterDir: starter,
        }),
      );
      expect(ws.workspaceDir).toContain("job-default");
    } finally {
      await fs.rm(starter, { recursive: true, force: true });
    }
  });

  it("rejects outputRoot outside default + missing allowlist", async () => {
    const starter = await makeTempStarter();
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "ai-out-"));
    try {
      await expect(
        prepareWorkspace(
          baseParams({
            jobId: "job-outside",
            outputRoot: other,
            defaultOutputRoot: tmpRoot,
            starterDir: starter,
          }),
        ),
      ).rejects.toMatchObject({ code: "output-root-not-allowed" });
    } finally {
      await fs.rm(starter, { recursive: true, force: true });
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it("respects outputRootAllowlist when configured", async () => {
    const starter = await makeTempStarter();
    const otherAllowed = await fs.mkdtemp(path.join(os.tmpdir(), "ai-allow-"));
    const notAllowed = await fs.mkdtemp(path.join(os.tmpdir(), "ai-not-allow-"));
    try {
      await expect(
        prepareWorkspace(
          baseParams({
            jobId: "job-not-allowed",
            outputRoot: notAllowed,
            outputRootAllowlist: [otherAllowed],
            defaultOutputRoot: tmpRoot,
            starterDir: starter,
          }),
        ),
      ).rejects.toMatchObject({ code: "output-root-not-allowed" });
      // Allow the actual root and the call should succeed.
      const ws = await prepareWorkspace(
        baseParams({
          jobId: "job-allowed",
          outputRoot: notAllowed,
          outputRootAllowlist: [notAllowed, otherAllowed],
          defaultOutputRoot: tmpRoot,
          starterDir: starter,
        }),
      );
      expect(ws.workspaceDir).toContain("job-allowed");
    } finally {
      await fs.rm(starter, { recursive: true, force: true });
      await fs.rm(otherAllowed, { recursive: true, force: true });
      await fs.rm(notAllowed, { recursive: true, force: true });
    }
  });

  it("rejects when the workspaceDir already exists", async () => {
    const starter = await makeTempStarter();
    try {
      await prepareWorkspace(
        baseParams({ jobId: "job-collide", outputRoot: tmpRoot, starterDir: starter }),
      );
      await expect(
        prepareWorkspace(
          baseParams({ jobId: "job-collide", outputRoot: tmpRoot, starterDir: starter }),
        ),
      ).rejects.toMatchObject({ code: "workspace-collision" });
    } finally {
      await fs.rm(starter, { recursive: true, force: true });
    }
  });
});

describe("disposeWorkspace", () => {
  it("removes the workspaceDir recursively without throwing on missing dirs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dispose-"));
    await fs.writeFile(path.join(dir, "x.txt"), "y");
    await disposeWorkspace(dir);
    await expect(fs.stat(dir)).rejects.toThrow();
    // Idempotent.
    await expect(disposeWorkspace(dir)).resolves.toBeUndefined();
  });
});

describe("readJobSidecar", () => {
  it("returns null when no sidecar exists", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-ns-"));
    try {
      expect(await readJobSidecar(dir)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when sidecar JSON is malformed or schema-mismatched", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-bad-"));
    try {
      await fs.mkdir(path.join(dir, ".remotion-ai"), { recursive: true });
      await fs.writeFile(path.join(dir, ".remotion-ai", "job.json"), "{not json");
      expect(await readJobSidecar(dir)).toBeNull();

      await fs.writeFile(
        path.join(dir, ".remotion-ai", "job.json"),
        JSON.stringify({ jobId: "x", prompt: "y" /* missing fields */ }),
      );
      expect(await readJobSidecar(dir)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
