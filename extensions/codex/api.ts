// extensions/codex/api.ts
//
// Narrow public surface for other bundled extensions that need to drive
// Codex app-server as a headless code-generation backend.
//
// DO NOT expand this file freely. Per `extensions/AGENTS.md`:
//   > "When core needs plugin-owned static data on a hot path, expose a
//   > lightweight top-level artifact such as ... `*-api.ts`. Reuse the
//   > same local helper from the artifact and the full plugin so fast
//   > paths do not drift from runtime behavior."
//
// M1 contract (remotion-ai consumes via `@openclaw/codex/api.js`):
//   - `spawnCodexAppServerJob(options)` starts an isolated Codex thread,
//     runs one turn with the provided prompt, and returns a handle that
//     supports `sendUserTurn` (for retry), `abort`, and `close`.
//   - Events delivered via `onEvent` callback are NOT a transcript — they
//     are the minimum set needed to drive a code-generation job UI:
//     `thread_started`, `turn_started`, `agent_message`, `tool_call`,
//     `tool_result`, `turn_complete`.
//
// Stability:
//   - The exported type names and shape are the initial stable contract
//     for M1. Additive changes (new event variants, new options) are
//     allowed. Breaking renames require bumping the consuming extension
//     too in the same change.

export type {
  CodexAppServerJobEvent,
  CodexAppServerJobHandle,
  SpawnCodexAppServerJobOptions,
} from "./src/app-server/job-session.js";

export { spawnCodexAppServerJob } from "./src/app-server/job-session.js";
