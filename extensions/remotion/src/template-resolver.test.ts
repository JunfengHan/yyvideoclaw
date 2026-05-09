import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTemplateEntryPoint, TemplateResolutionError } from "./template-resolver.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-remotion-resolver-"));
  // Canonicalise once up front: macOS prefixes /var with /private which
  // would otherwise confuse symlink-boundary tests.
  const real = await fs.realpath(dir);
  tempDirs.push(real);
  return real;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("resolveTemplateEntryPoint", () => {
  it("accepts a file inside an allowlisted root", async () => {
    const root = await makeTempDir();
    const entry = path.join(root, "index.ts");
    await fs.writeFile(entry, "// fixture", "utf8");

    const resolved = await resolveTemplateEntryPoint({
      entryPoint: entry,
      templateRoots: [root],
    });
    expect(resolved).toBe(entry);
  });

  it("accepts a file in a deeply nested subdirectory", async () => {
    const root = await makeTempDir();
    const nested = path.join(root, "a", "b", "c");
    await fs.mkdir(nested, { recursive: true });
    const entry = path.join(nested, "index.ts");
    await fs.writeFile(entry, "// fixture", "utf8");

    const resolved = await resolveTemplateEntryPoint({
      entryPoint: entry,
      templateRoots: [root],
    });
    expect(resolved).toBe(entry);
  });

  it("rejects relative entryPoint", async () => {
    const root = await makeTempDir();
    await expect(
      resolveTemplateEntryPoint({ entryPoint: "./index.ts", templateRoots: [root] }),
    ).rejects.toMatchObject({ code: "not-absolute" });
  });

  it("rejects entryPoint outside the allowlist", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    const entry = path.join(outside, "index.ts");
    await fs.writeFile(entry, "// fixture", "utf8");

    await expect(
      resolveTemplateEntryPoint({ entryPoint: entry, templateRoots: [root] }),
    ).rejects.toMatchObject({ code: "not-in-allowlist" });
  });

  it("rejects the prefix-match attack: /opt/allow vs /opt/allow-attacker", async () => {
    // Construct two siblings whose names share a prefix. A naive
    // `startsWith(root)` check would erroneously accept the second.
    const parent = await makeTempDir();
    const allow = path.join(parent, "allow");
    const attacker = path.join(parent, "allow-attacker");
    await fs.mkdir(allow);
    await fs.mkdir(attacker);
    const entry = path.join(attacker, "evil.ts");
    await fs.writeFile(entry, "// evil", "utf8");

    await expect(
      resolveTemplateEntryPoint({ entryPoint: entry, templateRoots: [allow] }),
    ).rejects.toMatchObject({ code: "not-in-allowlist" });
  });

  it("rejects symlink escape: a symlink inside the root pointing outside it", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    const realTarget = path.join(outside, "secret.ts");
    await fs.writeFile(realTarget, "// secret", "utf8");

    const link = path.join(root, "alias.ts");
    await fs.symlink(realTarget, link);

    await expect(
      resolveTemplateEntryPoint({ entryPoint: link, templateRoots: [root] }),
    ).rejects.toMatchObject({ code: "not-in-allowlist" });
  });

  it("rejects path-traversal segments that escape the root", async () => {
    const parent = await makeTempDir();
    const root = path.join(parent, "templates");
    const sibling = path.join(parent, "secrets");
    await fs.mkdir(root);
    await fs.mkdir(sibling);
    const target = path.join(sibling, "leak.ts");
    await fs.writeFile(target, "// leak", "utf8");

    // Caller hands us an absolute path with `..` segments that resolve
    // outside the allowlist root.
    const traversed = path.join(root, "..", "secrets", "leak.ts");

    await expect(
      resolveTemplateEntryPoint({ entryPoint: traversed, templateRoots: [root] }),
    ).rejects.toMatchObject({ code: "not-in-allowlist" });
  });

  it("rejects directories", async () => {
    const root = await makeTempDir();
    const sub = path.join(root, "subdir");
    await fs.mkdir(sub);
    await expect(
      resolveTemplateEntryPoint({ entryPoint: sub, templateRoots: [root] }),
    ).rejects.toMatchObject({ code: "not-a-file" });
  });

  it("rejects nonexistent paths", async () => {
    const root = await makeTempDir();
    const ghost = path.join(root, "does-not-exist.ts");
    await expect(
      resolveTemplateEntryPoint({ entryPoint: ghost, templateRoots: [root] }),
    ).rejects.toMatchObject({ code: "realpath-failed" });
  });

  it("rejects an empty allowlist", async () => {
    const root = await makeTempDir();
    const entry = path.join(root, "index.ts");
    await fs.writeFile(entry, "// fixture", "utf8");
    await expect(
      resolveTemplateEntryPoint({ entryPoint: entry, templateRoots: [] }),
    ).rejects.toMatchObject({ code: "empty-allowlist" });
  });

  it("accepts a file when the allowlist root itself is a symlink to the real dir", async () => {
    // The configured root is /tmp/x/link → /tmp/x/real. The entryPoint is
    // physically inside /tmp/x/real. Both must canonicalise to the same
    // real directory before the allowlist check.
    const parent = await makeTempDir();
    const real = path.join(parent, "real");
    const link = path.join(parent, "link");
    await fs.mkdir(real);
    await fs.symlink(real, link);
    const entry = path.join(real, "index.ts");
    await fs.writeFile(entry, "// fixture", "utf8");

    const resolved = await resolveTemplateEntryPoint({
      entryPoint: entry,
      templateRoots: [link],
    });
    expect(resolved).toBe(entry);
  });

  it("TemplateResolutionError is throwable and instanceof-checkable", () => {
    const err = new TemplateResolutionError("x", "not-absolute");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("TemplateResolutionError");
    expect(err.code).toBe("not-absolute");
  });
});
