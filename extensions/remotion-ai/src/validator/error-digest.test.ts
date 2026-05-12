import { describe, expect, it } from "vitest";
import { buildErrorDigest, sanitizeAbsolutePaths } from "./error-digest.js";

describe("sanitizeAbsolutePaths", () => {
  const workspace = "/Users/alice/projects/ws-1";

  it("strips workspace-prefixed absolute paths to relative form", () => {
    const input = `Cannot resolve "${workspace}/src/Root.tsx" from "${workspace}/src/index.ts"`;
    expect(sanitizeAbsolutePaths(input, workspace)).toBe(
      'Cannot resolve "src/Root.tsx" from "src/index.ts"',
    );
  });

  it("replaces non-workspace absolute paths inside quotes with <host>", () => {
    const input = `Module not found: "/etc/passwd"`;
    expect(sanitizeAbsolutePaths(input, workspace)).toBe('Module not found: "<host>"');
  });

  it("leaves text without absolute paths untouched", () => {
    expect(sanitizeAbsolutePaths("nothing to sanitize", workspace)).toBe("nothing to sanitize");
  });
});

describe("buildErrorDigest", () => {
  const workspace = "/tmp/ws";

  it("renders a Markdown digest with the failing stage and remaining retries", () => {
    const digest = buildErrorDigest(
      {
        kind: "validation-failure",
        stage: "bundle",
        errorName: "ResolveError",
        errorMessage: "cannot resolve ./Root",
        errorPreview: 'at Module._resolveFilename "/tmp/ws/src/index.ts:3:1"',
        stages: {},
      },
      { workspaceDir: workspace, attemptIndex: 0, retryMax: 3 },
    );
    expect(digest).toContain("Validation failed at **Bundle**");
    expect(digest).toContain("attempt 1 of 4, 3 retries remaining");
    expect(digest).toContain("**ResolveError**: cannot resolve ./Root");
    expect(digest).toContain("src/index.ts:3:1");
    expect(digest).not.toContain("/tmp/ws");
  });

  it("uses singular 'retry remaining' when only one retry is left", () => {
    const digest = buildErrorDigest(
      {
        kind: "validation-failure",
        stage: "select_composition",
        errorName: "NotFound",
        errorMessage: "no compositions registered",
        errorPreview: "no compositions registered",
        stages: { bundleMs: 100 },
      },
      { workspaceDir: workspace, attemptIndex: 2, retryMax: 3 },
    );
    expect(digest).toContain("attempt 3 of 4, 1 retry remaining");
    expect(digest).toContain("Validation failed at **selectComposition**");
  });

  it("renders 'render_still' as 'renderStill' in the header", () => {
    const digest = buildErrorDigest(
      {
        kind: "validation-failure",
        stage: "render_still",
        errorName: "TimeoutError",
        errorMessage: "Chromium hung",
        errorPreview: "Chromium hung",
        stages: { bundleMs: 1, selectCompositionMs: 1 },
      },
      { workspaceDir: workspace, attemptIndex: 1, retryMax: 1 },
    );
    expect(digest).toContain("Validation failed at **renderStill**");
    expect(digest).toContain("attempt 2 of 2, 0 retries remaining");
  });
});
