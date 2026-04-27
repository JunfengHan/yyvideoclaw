// DEPRECATED: This plugin has been superseded by the embedded Video Studio tab
// in yyvideoclaw (see `src/video-studio/` and `.codebuddy/plan/pixelle-video-integration/`).
//
// Rationale: Pixelle is now hosted by yyvideoclaw itself as a managed subprocess
// exposed through a native Lit view (`<video-studio-view>`), rather than a
// standalone HTTP-bridged plugin. See `extensions/yy-pixelle-video/DEPRECATED.md`
// for the full migration story.
//
// This entry is kept so that fresh installs that still discover the extension
// directory fail gracefully (no-op register) instead of blowing up on import.
// It MUST NOT register any provider: the Video Studio tab is the single source
// of truth. The previous implementation is preserved in
// `video-generation-provider.ts` for historical reference only and is not
// imported from here.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "yy-pixelle-video",
  name: "yy-Pixelle-Video Plugin (deprecated)",
  description:
    "Deprecated. Video generation is now provided by the embedded Video Studio tab; this plugin is a no-op kept for backwards compatibility.",
  register(_api) {
    // Intentionally no-op. Do NOT call registerVideoGenerationProvider.
    // Emit a one-shot console warning so operators notice stale plugin configs.
    if (
      typeof globalThis !== "undefined" &&
      !(globalThis as Record<string, unknown>).__yyPixelleVideoDeprecationWarned
    ) {
      (globalThis as Record<string, unknown>).__yyPixelleVideoDeprecationWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[yy-pixelle-video] Plugin is deprecated and no longer registers a video-generation provider. Use the embedded Video Studio tab instead.",
      );
    }
  },
});
