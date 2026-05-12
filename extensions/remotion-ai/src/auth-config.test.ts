// extensions/remotion-ai/src/auth-config.test.ts

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultAuthConfigPath,
  readAuthConfig,
  toPublicStatus,
  writeAuthConfig,
} from "./auth-config.js";

describe("auth-config", () => {
  let tmpDir: string;
  let authPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "remotion-ai-auth-"));
    authPath = path.join(tmpDir, "auth.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("returns the default unset config when the file is missing", async () => {
    const cfg = await readAuthConfig(authPath);
    expect(cfg).toEqual({ mode: "unset", schemaVersion: 1 });
  });

  it("returns unset when the file is malformed JSON (no throw)", async () => {
    await fs.writeFile(authPath, "{not-json");
    const cfg = await readAuthConfig(authPath);
    expect(cfg.mode).toBe("unset");
  });

  it("returns unset when schemaVersion mismatches", async () => {
    await fs.writeFile(
      authPath,
      JSON.stringify({ schemaVersion: 99, mode: "hosted", hostedToken: "x" }),
    );
    const cfg = await readAuthConfig(authPath);
    expect(cfg.mode).toBe("unset");
    // The mismatched token must NOT leak into the returned config.
    expect("hostedToken" in cfg).toBe(false);
  });

  it("round-trips a hosted config and writes the file with 0600 perms", async () => {
    await writeAuthConfig(
      {
        mode: "hosted",
        hostedToken: "tok-abc",
        hostedUserEmail: "user@test",
        hostedRemainingCredits: 42,
        hostedRefreshedAt: 1_700_000_000_000,
        schemaVersion: 1,
      },
      authPath,
    );
    const stat = await fs.stat(authPath);
    // Mask out the type bits — 0o600 == owner rw only.
    expect(stat.mode & 0o777).toBe(0o600);
    const round = await readAuthConfig(authPath);
    expect(round).toEqual({
      mode: "hosted",
      hostedToken: "tok-abc",
      hostedUserEmail: "user@test",
      hostedRemainingCredits: 42,
      hostedRefreshedAt: 1_700_000_000_000,
      schemaVersion: 1,
    });
  });

  it("toPublicStatus strips the hosted bearer token", () => {
    const pub = toPublicStatus({
      mode: "hosted",
      hostedToken: "secret",
      hostedUserEmail: "user@test",
      schemaVersion: 1,
    });
    expect(pub).toEqual({ mode: "hosted", hostedUserEmail: "user@test" });
    expect("hostedToken" in pub).toBe(false);
  });

  it("creates the parent dir on first write", async () => {
    const nested = path.join(tmpDir, "nested", "deeper", "auth.json");
    await writeAuthConfig({ mode: "byok", schemaVersion: 1 }, nested);
    const round = await readAuthConfig(nested);
    expect(round.mode).toBe("byok");
  });

  it("defaultAuthConfigPath points at ~/.openclaw/remotion-ai/auth.json", () => {
    const p = defaultAuthConfigPath("/Users/test");
    expect(p).toBe("/Users/test/.openclaw/remotion-ai/auth.json");
    // Sanity: the real default uses os.homedir().
    expect(defaultAuthConfigPath()).toContain(path.join(".openclaw", "remotion-ai"));
    expect(defaultAuthConfigPath().startsWith(os.homedir())).toBe(true);
  });
});
