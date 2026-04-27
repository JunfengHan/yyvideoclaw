// DEPRECATED: This contract test used to assert that the yy-pixelle-video
// plugin registers a `videoGenerationProviders` entry named "yy-pixelle-video".
//
// The plugin has since been turned into a no-op (see ./index.ts) because the
// video-generation feature now lives inside yyvideoclaw itself as the embedded
// Video Studio tab. Registering a duplicate provider from a plugin would
// therefore conflict with the canonical in-tree implementation.
//
// We keep the file (and leave it green) so that:
//   1. historical git blame still resolves to the original contract, and
//   2. future contributors get a clear pointer to the new integration path.
//
// Once the Video Studio rollout is complete and the old plugin directory is
// removed, this file can be deleted alongside it.

import { describe, it } from "vitest";

describe("yy-pixelle-video plugin registration (deprecated)", () => {
  it.skip("no longer registers a video-generation provider; see ../../.codebuddy/plan/pixelle-video-integration/", () => {
    // Intentionally empty. Kept as a breadcrumb.
  });
});
