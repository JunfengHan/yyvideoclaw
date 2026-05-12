# remotion-ai Plugin Boundary

## Purpose

Drive a coding agent to author a Remotion project from a prompt in an
isolated AI workspace, and auto-validate the result via `bundle +
selectComposition + render-still` before handing control back to the user.

## Cross-Extension Boundary

- **Codex** is consumed ONLY through `@openclaw/codex/api.js` (the
  top-level `extensions/codex/api.ts` public surface). Do NOT deep-import
  `extensions/codex/src/**`, `extensions/codex/harness.ts`, or
  `extensions/codex/index.ts`. See `extensions/AGENTS.md` rule:
  > "When core needs plugin-owned static data on a hot path, expose a
  > lightweight top-level artifact such as ... `*-api.ts`."
- **Remotion** is not called through its HTTP routes or agent tools for
  validation. AI workspaces live outside the user's `templateRoots` by
  design — routing validation through `/remotion/*` would be rejected by
  `extensions/remotion/src/template-resolver.ts` (allowlist + realpath).
- The validation seam is `src/validator/ai-render-worker.ts`, a dedicated
  Node subprocess that accepts a single `cwd=workspaceDir` and rejects any
  path escape. It intentionally duplicates the spawn + env-scrub pattern
  from `extensions/remotion/src/render-queue.ts` instead of importing it,
  to keep the isolation contract obvious at the call site.

## Agent Engine Abstraction

- `src/engine/engine.ts` defines `RemotionAgentEngine`. M1 ships one
  implementation, `codex-engine.ts`, which wraps
  `spawnCodexAppServerJob({ workspaceDir, initialPrompt, sandbox,
approvalPolicy, onEvent, … })` from `@openclaw/codex/api.js` and maps
  `CodexAppServerJobEvent` to the plugin's internal `JobEvent` union.
- M2 adapters (`claude-code`, `remote-worker`) register under the same
  `engine-registry.ts`; UI never observes engine differences beyond
  `engine.id`.

## Retry / Validation Loop

- Run the engine once, then `validator.validate({ workspaceDir })`.
- On failure, build an error digest (`error-digest.ts`, stderr capped at
  2 KiB, relative paths only) and feed it as the next user turn on the
  SAME agent session. Retry at most `retryMax` (default 3), exponential
  backoff (500 ms → 2 s → 8 s).
- Cancellation (HTTP `POST /remotion-ai/jobs/:id/cancel`) must `abort()`
  the Codex job handle AND SIGKILL any in-flight render worker.

## Security

- `allowNetwork: false` by default (Chromium blocks all network).
- Agent `cwd` is forced to the AI workspace; sandbox is
  `workspace-write`; approval policy is `never`.
- Never persist user prompts to disk logs; the history store keeps only
  phase summaries + the generated project path.
- env scrub on subprocess spawn; inherit only the minimum required vars.

## Do Not

- Auto-add the generated project directory to the remotion plugin's
  `templateRoots`. That is the user's explicit opt-in, surfaced via the
  "Add to templateRoots" quick-config link after success.
- Run the full `render-video` validator in M1. Still-frame is the M1 bar.
- Fall back to the OpenClaw main-session `AgentHarness` path. If Codex is
  unavailable, surface the error to the user.
