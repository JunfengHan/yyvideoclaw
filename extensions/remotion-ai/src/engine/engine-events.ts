// extensions/remotion-ai/src/engine/engine-events.ts
//
// Map `CodexAppServerJobEvent` (from @openclaw/codex/api.js) into the
// engine-agnostic `JobEvent` shape consumed by orchestrator + UI. Keep this
// file pure / sync / dependency-free so it stays easy to test.

import type { CodexAppServerJobEvent } from "@openclaw/codex/api.js";
import type { JobEvent, Phase } from "../types.js";

/**
 * Project a single Codex job event into one or more JobEvents. Returns an
 * empty array for events the UI does not need to display directly (e.g.
 * `thread_started` is encoded as a `phase=agent` transition by the engine
 * itself, not duplicated here).
 */
export function projectCodexJobEvent(
  jobId: string,
  event: CodexAppServerJobEvent,
  now: () => number = Date.now,
): JobEvent[] {
  const at = now();
  switch (event.type) {
    case "thread_started":
      return [];
    case "turn_started":
      return [];
    case "agent_message":
      return [{ type: "engine_message", jobId, text: event.text, at }];
    case "tool_call":
      return [{ type: "engine_tool", jobId, name: event.name, status: event.status, at }];
    case "tool_result":
      // tool_result is implicit in the next tool_call / turn_complete; emit
      // only when a status delta is informative. M1: treat it as a fresh
      // tool event with the result status appended so the UI can show
      // "ran bash → exit 0".
      return [
        {
          type: "engine_tool",
          jobId,
          name: `${event.name} → ${event.success ? "ok" : "error"}`,
          status: event.success ? "completed" : "failed",
          at,
        },
      ];
    case "turn_complete": {
      if (event.status === "failed" && event.errorMessage) {
        return [
          {
            type: "error",
            jobId,
            message: `agent turn failed: ${event.errorMessage}`,
            at,
          },
        ];
      }
      if (event.status === "interrupted") {
        return [
          {
            type: "error",
            jobId,
            message: "agent turn was interrupted",
            at,
          },
        ];
      }
      return [];
    }
    default: {
      // Exhaustiveness: TS will catch new variants here. Returning [] for
      // unknown events keeps the UI stream stable across Codex protocol
      // bumps.
      const _unused: never = event;
      void _unused;
      return [];
    }
  }
}

/**
 * Helper to emit a phase transition event consistently from the engine /
 * orchestrator. Kept here so all `JobEvent` construction lives next to its
 * type definitions.
 */
export function makePhaseEvent(
  jobId: string,
  phase: Phase,
  now: () => number = Date.now,
): JobEvent {
  return { type: "phase", jobId, phase, at: now() };
}
