# AI Create Starter — Agent Writing Guide

You are authoring a Remotion video project inside this workspace. This
file is offline guidance for you; the human user's prompt was delivered
as a separate message.

## Required Contract

- Keep `src/index.ts` and its `registerRoot(Root)` call unchanged.
- Export a React component named `Root` from `src/Root.tsx`. It must
  return one or more `<Composition>` elements. Every `<Composition>`
  needs a stable string `id`, a `component`, and the four required
  numeric props: `durationInFrames`, `fps`, `width`, `height`.
- Do NOT remove the placeholder composition until you have at least one
  valid replacement — validation runs `bundle + selectComposition +
render-still` on the first composition it finds. An empty registry
  fails.
- Use relative imports WITHOUT file extensions inside this Remotion
  project (this contradicts the outer repo convention; Remotion's
  webpack config requires the extensionless form).

## Idiomatic Remotion

- Animate with hooks: `useCurrentFrame`, `useVideoConfig`, `spring`,
  `interpolate`, `interpolateColors`.
- Prefer `<AbsoluteFill>` for full-frame layers and `<Sequence>` for
  timeline segmentation.
- Assets: bundle images under `src/assets/` and import them; do not
  hot-link remote URLs (network is blocked during validation).
- Typography: use system font stacks. Web fonts require
  `<Font.preload>` and will not load offline during validation.

## Validation Loop

After you finish writing, the host runs:

1. `@remotion/bundler#bundle({ entryPoint: "<workspace>/src/index.ts" })`
2. `@remotion/renderer#selectComposition({ serveUrl, id })` for the
   first registered composition.
3. `@remotion/renderer#renderStill({ composition, output, frame: 0 })`.

If any step fails, the digest (trimmed stderr + the first failing
relative path) is fed back to you as the next user turn. You have up to
3 retries. Do not guess — look at the digest.

## What Not To Do

- Do not install new npm packages. The workspace inherits from
  `remotion-templates/ai-starter/package.json` (react, react-dom,
  remotion). If you need more, say so in your response; the human will
  add it.
- Do not write outside this workspace. Your sandbox forbids it anyway.
- Do not touch `.skills/` — that directory is a pinned copy of the
  official Remotion Agent Skills and is loaded read-only.
