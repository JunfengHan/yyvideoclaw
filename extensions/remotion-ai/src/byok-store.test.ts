// extensions/remotion-ai/src/byok-store.test.ts

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultCodexAuthPath,
  deleteCodexAuth,
  isPlausibleOpenAiKey,
  readCodexAuth,
  writeCodexAuthApiKey,
} from "./byok-store.js";

describe("isPlausibleOpenAiKey", () => {
  it("accepts the common OpenAI key shapes", () => {
    expect(isPlausibleOpenAiKey("sk-abcdefghijklmnopqrstuvwx")).toBe(true);
    expect(isPlausibleOpenAiKey("sk-proj-abcdefghijklmnopqrst")).toBe(true);
    expect(isPlausibleOpenAiKey("sk-svcacct-abcdefghijklmnopq")).toBe(true);
  });
  it("rejects clearly-wrong values", () => {
    expect(isPlausibleOpenAiKey(undefined)).toBe(false);
    expect(isPlausibleOpenAiKey(123)).toBe(false);
    expect(isPlausibleOpenAiKey("")).toBe(false);
    expect(isPlausibleOpenAiKey("not-a-key")).toBe(false);
    expect(isPlausibleOpenAiKey("sk-")).toBe(false);
    expect(isPlausibleOpenAiKey("sk-tooshort")).toBe(false);
  });
});

describe("writeCodexAuthApiKey / readCodexAuth", () => {
  let tmpDir: string;
  let authPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "remotion-ai-byok-"));
    authPath = path.join(tmpDir, ".codex", "auth.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("writes the codex auth.json shape with 0600 perms", async () => {
    await writeCodexAuthApiKey("sk-test-abcdefghijklmnopqrst", authPath);
    const stat = await fs.stat(authPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const round = await readCodexAuth(authPath);
    expect(round).toEqual({
      auth_mode: "apikey",
      OPENAI_API_KEY: "sk-test-abcdefghijklmnopqrst",
    });
  });

  it("trims surrounding whitespace before writing", async () => {
    await writeCodexAuthApiKey("  sk-test-abcdefghijklmnopqrst  \n", authPath);
    const round = await readCodexAuth(authPath);
    expect(round?.OPENAI_API_KEY).toBe("sk-test-abcdefghijklmnopqrst");
  });

  it("refuses to write a value that doesn't look like an OpenAI key", async () => {
    await expect(writeCodexAuthApiKey("not-a-key", authPath)).rejects.toThrow(
      /does not look like an OpenAI API key/u,
    );
    // And the file MUST NOT exist after a refusal.
    await expect(fs.stat(authPath)).rejects.toThrow();
  });

  it("readCodexAuth returns null for a missing file", async () => {
    expect(await readCodexAuth(authPath)).toBeNull();
  });

  it("readCodexAuth returns null for a malformed payload", async () => {
    await fs.mkdir(path.dirname(authPath), { recursive: true });
    await fs.writeFile(authPath, JSON.stringify({ auth_mode: "wrong" }));
    expect(await readCodexAuth(authPath)).toBeNull();
  });

  it("deleteCodexAuth removes the file and is idempotent", async () => {
    await writeCodexAuthApiKey("sk-test-abcdefghijklmnopqrst", authPath);
    await deleteCodexAuth(authPath);
    expect(await readCodexAuth(authPath)).toBeNull();
    // Second call must not throw.
    await deleteCodexAuth(authPath);
  });

  it("defaultCodexAuthPath resolves to ~/.codex/auth.json", () => {
    expect(defaultCodexAuthPath("/Users/test")).toBe("/Users/test/.codex/auth.json");
  });
});

import {
  defaultOpenRouterKeyPath,
  deleteOpenRouterKey,
  looksLikeOpenRouterKey,
  readOpenRouterKey,
  writeOpenRouterKey,
} from "./byok-store.js";

describe("looksLikeOpenRouterKey", () => {
  it("matches sk-or-v1- prefix", () => {
    expect(looksLikeOpenRouterKey("sk-or-v1-abcdefghijklmnopqrst")).toBe(true);
  });
  it("rejects plain OpenAI keys", () => {
    expect(looksLikeOpenRouterKey("sk-abcdefghijklmnopqrst")).toBe(false);
    expect(looksLikeOpenRouterKey("sk-proj-abcdefghijklmnop")).toBe(false);
  });
  it("rejects non-strings / empty", () => {
    expect(looksLikeOpenRouterKey(undefined)).toBe(false);
    expect(looksLikeOpenRouterKey("")).toBe(false);
    expect(looksLikeOpenRouterKey(null)).toBe(false);
  });
});

describe("OpenRouter key sidecar", () => {
  let tmpDir: string;
  let keyPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "or-key-"));
    keyPath = path.join(tmpDir, "byok-openrouter.json");
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("writes sk-or-v1-… key with 0600 perms", async () => {
    await writeOpenRouterKey("sk-or-v1-abcdefghijklmnopqrst", keyPath);
    const stat = await fs.stat(keyPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const round = await readOpenRouterKey(keyPath);
    expect(round).toBe("sk-or-v1-abcdefghijklmnopqrst");
  });

  it("refuses to write a non-OpenRouter key", async () => {
    // sk- prefix that's NOT sk-or-v1- must be rejected — letting it
    // through would put an OpenAI key in the OpenRouter slot and cause
    // a confusing 401 at first turn.
    await expect(writeOpenRouterKey("sk-abcdefghijklmnopqrst", keyPath)).rejects.toThrow(
      /does not look like an OpenRouter API key/u,
    );
    await expect(fs.stat(keyPath)).rejects.toThrow();
  });

  it("readOpenRouterKey returns null for missing/malformed file", async () => {
    expect(await readOpenRouterKey(keyPath)).toBeNull();
    await fs.writeFile(keyPath, JSON.stringify({ schemaVersion: 99 }));
    expect(await readOpenRouterKey(keyPath)).toBeNull();
  });

  it("deleteOpenRouterKey is idempotent", async () => {
    await writeOpenRouterKey("sk-or-v1-abcdefghijklmnopqrst", keyPath);
    await deleteOpenRouterKey(keyPath);
    expect(await readOpenRouterKey(keyPath)).toBeNull();
    await deleteOpenRouterKey(keyPath); // must not throw
  });

  it("defaultOpenRouterKeyPath resolves to ~/.openclaw/remotion-ai/byok-openrouter.json", () => {
    expect(defaultOpenRouterKeyPath("/Users/test")).toBe(
      "/Users/test/.openclaw/remotion-ai/byok-openrouter.json",
    );
  });
});
