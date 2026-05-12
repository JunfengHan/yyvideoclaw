# @openclaw/remotion-ai

**Remotion AI Create** — generate a working Remotion project from a prompt by
driving Codex (M1) in an isolated workspace, then auto-validating with
`bundle + selectComposition + render-still`.

## Status

- **M1 complete**: plugin scaffold, codex public surface
  (`@openclaw/codex/api.js`), AI starter template + skills vendor pipeline,
  engine + codex adapter, isolated render worker, orchestrator + retry
  loop, HTTP routes (submit / poll / cancel / history / SSE), UI controller
  - panel view, en + zh-CN i18n. The plugin still ships
    `enabledByDefault: false` — it must be opted into per workspace.
- **Engine**: M1 ships Codex only (via `@openclaw/codex/api.js`). Claude
  Code and remote-worker adapters are reserved for M2; they slot in as new
  cases inside `src/engine/engine-registry.ts`.

## How It Works

1. UI (`Remotion Studio → AI Create` panel) posts a prompt + output root.
2. `remotion-ai` creates `<output-root>/<jobId>/`, copies
   `remotion-templates/ai-starter` (includes pinned Remotion Agent Skills
   under `.skills/`).
3. The selected engine runs the prompt inside the workspace (Codex with
   `sandbox=workspace-write`, `approvalPolicy=never`). Engine events are
   forwarded into the orchestrator's `JobsStore` for SSE / polling
   subscribers.
4. The isolated `ai-render-worker` subprocess runs `bundle` →
   `selectComposition` → `render-still` (1 frame). On failure, the digest
   is fed back into the SAME agent session via
   `engine.retry(digest)`. Up to `retryMax` retries.
5. On success, the panel shows the generated workspace path and an inline
   hint pointing the user to `plugins.entries.remotion.config.templateRoots`.
   **We never modify `templateRoots` automatically.**

## Boundaries

- No deep-import of `extensions/codex/src/**` or
  `extensions/remotion/src/**`. Codex is consumed via
  `@openclaw/codex/api.js` (resolved by tsconfig paths
  `"@openclaw/*": ["./extensions/*"]`); Remotion validation goes through a
  local worker that mirrors `extensions/remotion/src/render-worker.ts`
  without importing it.
- The validation worker is the only thing that spawns Remotion; it
  accepts a single `cwd` and rejects any path escape.
- `codex-engine.ts` uses a **type-only** import + dynamic `import()` for
  the codex public surface, so vitest (whose ESM resolver does not honor
  the tsconfig paths alias) can run unit tests by injecting a fake
  `spawnJob` without touching the real codex package.

## Config

See `openclaw.plugin.json` `configSchema`. Keys:

| Key                      | Default                                     | Notes                                                                                         |
| ------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `engine`                 | `"codex"`                                   | M2 will accept `"claude-code" \| "remote-worker"`.                                            |
| `outputRootAllowlist`    | `[]`                                        | Optional allowlist of acceptable parent directories for `outputRoot`. Empty = no restriction. |
| `retryMax`               | `3`                                         | Server clamps; also surfaced as a UI control.                                                 |
| `jobTimeoutMs`           | `600000`                                    | Soft per-job budget.                                                                          |
| `skillsBundled`          | `true`                                      | Whether to copy `ai-starter/.skills/` into each workspace.                                    |
| `starterDir`             | resolves to `remotion-templates/ai-starter` | Override for forks.                                                                           |
| `allowNetwork`           | `false`                                     | Worker `--allow-network` flag (rejects bundle network calls otherwise).                       |
| `chromiumExecutablePath` | unset                                       | Forwarded to `@remotion/renderer`.                                                            |
| `maxOutputBytes`         | `4_194_304`                                 | Worker output truncation cap.                                                                 |

## Wiring The UI Panel

The panel ships as an **opt-in** prop on `renderRemotionStudioView`. To
enable it inside the Remotion Studio tab, pass an `aiPanel` view-state
object alongside the existing props:

```ts
// ui/src/ui/app-render.ts (Remotion Studio dispatch)
import {
  defaultRemotionAiState,
  startRemotionAiJobPolling,
  submitRemotionAiJob,
  cancelRemotionAiJob,
  updateRemotionAiDraft,
} from "./controllers/remotion-ai.ts";

// state.remotionAi seeded from defaultRemotionAiState() at app boot.
return renderRemotionStudioView({
  // ... existing props ...
  aiPanel: {
    draft: state.remotionAi.remotionAiDraft,
    currentJob: state.remotionAi.remotionAiCurrentJob,
    submitting: state.remotionAi.remotionAiSubmitting,
    submitError: state.remotionAi.remotionAiSubmitError,
    cancelling: state.remotionAi.remotionAiCancelling,
    lastAgentMessage: state.remotionAi.remotionAiLastAgentMessage,
    collapsed: state.remotionAi.remotionAiCollapsed ?? false,
    callbacks: {
      onDraftChange: (patch) => updateRemotionAiDraft(state.remotionAi, patch),
      onSubmit: () => orchestratorSubmit(state),
      onCancel: () => orchestratorCancel(state),
      onToggleCollapsed: () => toggleCollapsed(state),
      onCopyPath: (path) => navigator.clipboard.writeText(path),
    },
  },
});
```

When `aiPanel` is omitted (the M1 default in `app-render.ts`), the legacy
Remotion Studio layout renders unchanged.

## Refreshing Vendored Skills

The `ai-starter/.skills/` directory ships pinned to a specific Remotion
commit. Maintainers refresh it explicitly (offline builds and CI
sandboxes do not need network access at build time):

```bash
# Pull a new pinned commit + write VERSION:
OPENCLAW_VENDOR_NETWORK=1 pnpm vendor:remotion-skills --ref <sha>

# Verify the on-disk tree matches VERSION (e.g. in CI):
pnpm check:vendor-remotion-skills
```

Both scripts default to **offline-safe**: without `--ref` and without
`OPENCLAW_VENDOR_NETWORK=1`, the script exits 0 without touching the
network.

## Tests

- `index.test.ts` — plugin registers, all routes register.
- `src/config.test.ts` — config schema resolution + clamps.
- `src/jobs-store.test.ts` — LRU + state machine + per-job/global
  subscribers + replay buffer.
- `src/orchestrator.test.ts` — happy path, retry-then-success, retry
  exhausted, cancel, retryMax=0.
- `src/workspace.test.ts` — `prepareWorkspace` + `disposeWorkspace`
  (allowlist, jobId format, starter resolution, collisions).
- `src/skills-vendor.test.ts` — placeholder VERSION skip + real copy.
- `src/engine/engine-events.test.ts` — every Codex event variant maps to
  a stable `JobEvent`.
- `src/engine/codex-engine.test.ts` — runAttempt / retry / dispose /
  default arg path (via injected `spawnJob`).
- `src/validator/validator.test.ts` + `src/validator/error-digest.test.ts`
  — success / failure / worker-error projection + path sanitization.
- `src/server/routes.test.ts` — HTTP surface: submit / lookup / cancel /
  history + path helpers.

The cross-extension flow test (controller → routes → orchestrator) is
intentionally **not** end-to-end here; the controller is exercised in
`ui/src/ui/controllers/remotion-ai.test.ts` against a fake fetch, and the
orchestrator + routes are exercised here against fake engines / fake
validator.
