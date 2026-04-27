# Deprecated: `yy-pixelle-video` plugin

> **Status**: Deprecated as of `2026-04-27`. No-op kept only for backwards
> compatibility with existing plugin manifests.

## What changed?

Video generation has moved from an out-of-process plugin ("HTTP bridge to a
stand-alone Pixelle service") to a **first-class embedded tab** inside
yyvideoclaw itself:

- **New home**: [`src/video-studio/`](../../src/video-studio/) (core / process
  management) and [`ui/src/ui/video-studio/`](../../ui/src/ui/video-studio/)
  (front-end SDK) with the user-facing tab at
  [`ui/src/ui/views/video-studio-view.ts`](../../ui/src/ui/views/).
- **Plan & requirements**:
  [`.codebuddy/plan/pixelle-video-integration/requirements.md`](../../.codebuddy/plan/pixelle-video-integration/requirements.md)
  and its sibling `task-item.md`.

## Why deprecate?

The embedded design:

1. Eliminates dual-auth (no Pixelle-side API key to manage).
2. Gives users a native Lit UI that matches yyvideoclaw's theme and i18n.
3. Lets yyvideoclaw fully manage the Pixelle sub-process lifecycle (start,
   health-check, crash-recovery, graceful shutdown).
4. Routes all Pixelle LLM calls through yyvideoclaw's Gateway as a transparent
   `llm-passthrough` agent, so model switching is a single setting.

## What does this directory still do?

- `index.ts` exports a plugin entry that is a deliberate **no-op** — it emits a
  one-shot console warning but never registers a `videoGenerationProvider`.
- `video-generation-provider.ts` + its `*.test.ts` are preserved as historical
  reference so that `git log` / `git blame` remain useful. They are **not**
  wired into the active runtime.
- `plugin-registration.contract.test.ts` is reduced to a `describe.skip` with a
  pointer to this doc.

## Removal policy

This directory will be fully removed once:

1. The Video Studio tab has shipped on a stable release.
2. No user config file still references `yy-pixelle-video` in its enabled
   plugin list.

Until then, **do not add new features here**; contribute to `src/video-studio/`
instead.
