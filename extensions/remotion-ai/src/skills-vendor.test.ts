import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { injectRemotionSkills } from "./skills-vendor.js";

let starter: string;
let workspace: string;

beforeEach(async () => {
  starter = await fs.mkdtemp(path.join(os.tmpdir(), "ai-starter-skills-"));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ai-ws-skills-"));
});

afterEach(async () => {
  await fs.rm(starter, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
});

describe("injectRemotionSkills", () => {
  it("returns injected=false when the starter has no .skills directory", async () => {
    const result = await injectRemotionSkills({ starterDir: starter, workspaceDir: workspace });
    expect(result.injected).toBe(false);
    expect(result.reason).toContain("VERSION");
  });

  it("returns injected=false when VERSION is the placeholder", async () => {
    await fs.mkdir(path.join(starter, ".skills"), { recursive: true });
    await fs.writeFile(
      path.join(starter, ".skills", "VERSION"),
      "ref = unvendored\nsha256 = 0000000000000000000000000000000000000000000000000000000000000000\n",
    );
    const result = await injectRemotionSkills({ starterDir: starter, workspaceDir: workspace });
    expect(result.injected).toBe(false);
    expect(result.reason).toContain("placeholder");
  });

  it("copies the .skills/ tree when VERSION is real", async () => {
    await fs.mkdir(path.join(starter, ".skills", "lib"), { recursive: true });
    await fs.writeFile(
      path.join(starter, ".skills", "VERSION"),
      "source = remotion-dev/remotion\nsubpath = packages/skills\nref = abc123\nsha256 = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
    );
    await fs.writeFile(path.join(starter, ".skills", "SKILL.md"), "# remotion skill\n");
    await fs.writeFile(path.join(starter, ".skills", "lib", "helpers.ts"), "export const x = 1;");

    const result = await injectRemotionSkills({ starterDir: starter, workspaceDir: workspace });
    expect(result.injected).toBe(true);
    expect(result.version).toBe("abc123");
    const skillFile = await fs.readFile(path.join(workspace, ".skills", "SKILL.md"), "utf8");
    expect(skillFile).toContain("remotion skill");
    const helpers = await fs.readFile(path.join(workspace, ".skills", "lib", "helpers.ts"), "utf8");
    expect(helpers).toContain("export const x = 1");
  });
});
