# `src/video-studio/` — Embedded Video Studio core

> Hosts the yyvideoclaw-side TypeScript modules that manage the embedded
> Pixelle Video backend (process supervisor, installer, ephemeral Gateway
> tokens, preflight checks). The user-facing Lit view lives under
> [`ui/src/ui/video-studio/`](../../ui/src/ui/video-studio/) and
> [`ui/src/ui/views/video-studio-view.ts`](../../ui/src/ui/views/).

## Boundaries

- **This folder owns**:
  - Feature flag (`feature-flag.ts`) — read-only helper answering "is Video
    Studio enabled for this build / this user?".
  - Process lifecycle (`process-manager.ts`) — spawning, health-check,
    crash recovery, graceful shutdown of the Pixelle FastAPI subprocess.
  - Installer / preflight (`installer.ts`, `preflight.ts`) — binary /
    virtualenv bootstrapping and FFmpeg / Playwright detection.
  - Ephemeral Gateway token issuance (`internal-token.ts`).
- **This folder does NOT own**:
  - UI rendering → `ui/src/ui/video-studio/` + `ui/src/ui/views/video-studio-view.ts`.
  - Pixelle business logic (prompting, frame templating, ffmpeg composing) →
    those live upstream in `yy-Pixelle-Video` and are invoked via HTTP only.

## Entry point

`index.ts` re-exports the public surface consumed by the rest of yyvideoclaw
(Settings page, main-process bootstrap, debug/diagnostics). Everything else is
internal and should not be imported across package boundaries.

## Planning doc

See [`.codebuddy/plan/pixelle-video-integration/requirements.md`](../../.codebuddy/plan/pixelle-video-integration/requirements.md).
