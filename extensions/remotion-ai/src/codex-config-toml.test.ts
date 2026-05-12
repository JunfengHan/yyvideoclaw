// extensions/remotion-ai/src/codex-config-toml.test.ts

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyOpenRouterEdits,
  configureCodexForOpenRouter,
  defaultCodexConfigPath,
  removeOpenRouterConfig,
  removeOpenRouterEdits,
} from "./codex-config-toml.js";

describe("applyOpenRouterEdits (pure)", () => {
  it("appends top-level keys + section to an empty file", () => {
    const out = applyOpenRouterEdits("", "anthropic/claude-3.5-sonnet");
    expect(out).toContain('model_provider = "openrouter"');
    expect(out).toContain('model = "anthropic/claude-3.5-sonnet"');
    expect(out).toContain("[model_providers.openrouter]");
    expect(out).toContain('base_url = "https://openrouter.ai/api/v1"');
    expect(out).toContain('env_key = "OPENROUTER_API_KEY"');
    expect(out).toContain('wire_api = "chat"');
  });

  it("preserves unrelated top-level keys", () => {
    const before = [
      "# user comment",
      'model_reasoning_effort = "medium"',
      "",
      "[plugins.foo]",
      "enabled = true",
      "",
    ].join("\n");
    const after = applyOpenRouterEdits(before, "openai/gpt-4.1");
    expect(after).toContain("# user comment");
    expect(after).toContain('model_reasoning_effort = "medium"');
    expect(after).toContain("[plugins.foo]");
    expect(after).toContain('model_provider = "openrouter"');
    expect(after).toContain("[model_providers.openrouter]");
  });

  it("replaces an existing top-level model_provider scalar in place", () => {
    const before = ['model_provider = "openai"', 'model = "gpt-5"', "", "[plugins.bar]", ""].join(
      "\n",
    );
    const after = applyOpenRouterEdits(before, "anthropic/claude-3.5-sonnet");
    // Exactly one `model_provider = "..."` line at top-level.
    const matches = after.match(/^\s*model_provider\s*=/gmu) ?? [];
    expect(matches.length).toBe(1);
    expect(after).toContain('model_provider = "openrouter"');
    expect(after).toContain('model = "anthropic/claude-3.5-sonnet"');
    expect(after).not.toContain('model_provider = "openai"');
  });

  it("replaces an existing [model_providers.openrouter] section", () => {
    const before = [
      'model_provider = "openrouter"',
      'model = "old/model"',
      "",
      "[model_providers.openrouter]",
      'name = "OpenRouter"',
      'base_url = "https://wrong.example/api/v1"',
      'env_key = "WRONG_KEY"',
      'wire_api = "responses"',
      "",
      "[plugins.zzz]",
      "enabled = true",
      "",
    ].join("\n");
    const after = applyOpenRouterEdits(before, "new/model");
    expect(after).toContain('model = "new/model"');
    expect(after).toContain('base_url = "https://openrouter.ai/api/v1"');
    expect(after).not.toContain("https://wrong.example");
    expect(after).not.toContain('wire_api = "responses"');
    expect(after).toContain('wire_api = "chat"');
    // Keeps the unrelated section after.
    expect(after).toContain("[plugins.zzz]");
  });

  it("escapes dangerous chars in the model id", () => {
    const out = applyOpenRouterEdits("", 'evil"injection');
    // The injection attempt must be escaped; the produced TOML stays
    // well-formed (no stray `"` ending the string early).
    expect(out).toContain('model = "evil\\"injection"');
  });

  it("settles to a no-op on second apply with the same model", () => {
    const after1 = applyOpenRouterEdits("", "anthropic/claude-3.5-sonnet");
    const after2 = applyOpenRouterEdits(after1, "anthropic/claude-3.5-sonnet");
    expect(after2).toBe(after1);
  });
});

describe("removeOpenRouterEdits (pure)", () => {
  it("strips the section + top-level keys when previously openrouter-bound", () => {
    const after1 = applyOpenRouterEdits(
      "# user comment\n[plugins.foo]\nenabled = true\n",
      "anthropic/claude-3.5-sonnet",
    );
    const restored = removeOpenRouterEdits(after1);
    expect(restored).not.toContain("[model_providers.openrouter]");
    expect(restored).not.toContain("model_provider");
    expect(restored).not.toContain("anthropic/claude-3.5-sonnet");
    // Unrelated content survives.
    expect(restored).toContain("# user comment");
    expect(restored).toContain("[plugins.foo]");
  });

  it("does NOT delete top-level model when model_provider was something else", () => {
    const before = [
      'model_provider = "openai"',
      'model = "gpt-5"',
      "",
      "[model_providers.openrouter]",
      'base_url = "https://openrouter.ai/api/v1"',
      "",
    ].join("\n");
    const after = removeOpenRouterEdits(before);
    // Section is gone but the user's openai model picks survive.
    expect(after).not.toContain("[model_providers.openrouter]");
    expect(after).toContain('model_provider = "openai"');
    expect(after).toContain('model = "gpt-5"');
  });

  it("is a no-op when there's nothing to remove", () => {
    const before = "# nothing here\n[plugins.foo]\nenabled = true\n";
    expect(removeOpenRouterEdits(before)).toBe(before);
  });
});

describe("configureCodexForOpenRouter / removeOpenRouterConfig (filesystem)", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cfg-"));
    configPath = path.join(tmpDir, "config.toml");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("creates the file (+ parent dir) on first configure", async () => {
    const nested = path.join(tmpDir, "deep", "config.toml");
    await configureCodexForOpenRouter({
      modelId: "anthropic/claude-3.5-sonnet",
      configPath: nested,
    });
    const raw = await fs.readFile(nested, "utf8");
    expect(raw).toContain("[model_providers.openrouter]");
  });

  it("preserves an existing user config", async () => {
    await fs.writeFile(
      configPath,
      [
        "# my comment",
        'model_reasoning_effort = "high"',
        "",
        "[marketplaces.openai-bundled]",
        'last_updated = "2026-01-01T00:00:00Z"',
        'source_type = "local"',
        'source = "/some/path"',
        "",
        '[projects."/some/project"]',
        'trust_level = "trusted"',
        "",
      ].join("\n"),
    );
    await configureCodexForOpenRouter({
      modelId: "anthropic/claude-3.5-sonnet",
      configPath,
    });
    const raw = await fs.readFile(configPath, "utf8");
    expect(raw).toContain("# my comment");
    expect(raw).toContain('model_reasoning_effort = "high"');
    expect(raw).toContain("[marketplaces.openai-bundled]");
    expect(raw).toContain('[projects."/some/project"]');
    expect(raw).toContain("[model_providers.openrouter]");
    expect(raw).toContain('model_provider = "openrouter"');
  });

  it("round-trips configure → remove cleanly", async () => {
    const original = "# bare\n";
    await fs.writeFile(configPath, original);
    await configureCodexForOpenRouter({ modelId: "openai/gpt-4.1", configPath });
    await removeOpenRouterConfig({ configPath });
    const raw = await fs.readFile(configPath, "utf8");
    expect(raw).not.toContain("[model_providers.openrouter]");
    expect(raw).not.toContain("model_provider");
    expect(raw).toContain("# bare");
  });

  it("removeOpenRouterConfig is a no-op when the file is missing", async () => {
    await removeOpenRouterConfig({ configPath: path.join(tmpDir, "nonexistent.toml") });
    // Just shouldn't throw.
  });

  it("defaultCodexConfigPath points at ~/.codex/config.toml", () => {
    expect(defaultCodexConfigPath("/Users/test")).toBe("/Users/test/.codex/config.toml");
  });
});
