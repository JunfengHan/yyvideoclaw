import type { CodexAppServerJobEvent } from "@openclaw/codex/api.js";
import { describe, expect, it } from "vitest";
import { makePhaseEvent, projectCodexJobEvent } from "./engine-events.js";

describe("projectCodexJobEvent", () => {
  const jobId = "job-1";
  const now = (): number => 100;

  it("drops thread_started and turn_started from the UI stream", () => {
    expect(
      projectCodexJobEvent(
        jobId,
        { type: "thread_started", threadId: "t1", workspaceDir: "/tmp/ws" },
        now,
      ),
    ).toEqual([]);
    expect(
      projectCodexJobEvent(jobId, { type: "turn_started", threadId: "t1", turnId: "u1" }, now),
    ).toEqual([]);
  });

  it("maps agent_message into engine_message", () => {
    const event: CodexAppServerJobEvent = {
      type: "agent_message",
      text: "Wrote src/Root.tsx",
      itemId: "msg-1",
    };
    expect(projectCodexJobEvent(jobId, event, now)).toEqual([
      { type: "engine_message", jobId, text: "Wrote src/Root.tsx", at: 100 },
    ]);
  });

  it("maps tool_call into engine_tool with raw status", () => {
    const event: CodexAppServerJobEvent = {
      type: "tool_call",
      callId: "c1",
      name: "bash",
      input: { command: "echo hi" },
      status: "running",
    };
    expect(projectCodexJobEvent(jobId, event, now)).toEqual([
      { type: "engine_tool", jobId, name: "bash", status: "running", at: 100 },
    ]);
  });

  it("maps tool_result into engine_tool with success/error suffix", () => {
    const ok: CodexAppServerJobEvent = {
      type: "tool_result",
      callId: "c1",
      name: "bash",
      success: true,
      output: "ok",
    };
    const fail: CodexAppServerJobEvent = {
      type: "tool_result",
      callId: "c2",
      name: "apply_patch",
      success: false,
    };
    expect(projectCodexJobEvent(jobId, ok, now)).toEqual([
      { type: "engine_tool", jobId, name: "bash → ok", status: "completed", at: 100 },
    ]);
    expect(projectCodexJobEvent(jobId, fail, now)).toEqual([
      { type: "engine_tool", jobId, name: "apply_patch → error", status: "failed", at: 100 },
    ]);
  });

  it("maps turn_complete(failed) into an error event", () => {
    const event: CodexAppServerJobEvent = {
      type: "turn_complete",
      threadId: "t1",
      turnId: "u1",
      status: "failed",
      errorMessage: "model refused",
    };
    expect(projectCodexJobEvent(jobId, event, now)).toEqual([
      { type: "error", jobId, message: "agent turn failed: model refused", at: 100 },
    ]);
  });

  it("maps turn_complete(interrupted) into an error event", () => {
    const event: CodexAppServerJobEvent = {
      type: "turn_complete",
      threadId: "t1",
      turnId: "u1",
      status: "interrupted",
    };
    expect(projectCodexJobEvent(jobId, event, now)).toEqual([
      { type: "error", jobId, message: "agent turn was interrupted", at: 100 },
    ]);
  });

  it("drops turn_complete(completed) from the UI stream (orchestrator emits the success phase)", () => {
    const event: CodexAppServerJobEvent = {
      type: "turn_complete",
      threadId: "t1",
      turnId: "u1",
      status: "completed",
    };
    expect(projectCodexJobEvent(jobId, event, now)).toEqual([]);
  });
});

describe("makePhaseEvent", () => {
  it("builds a phase JobEvent", () => {
    expect(makePhaseEvent("job-1", "agent", () => 999)).toEqual({
      type: "phase",
      jobId: "job-1",
      phase: "agent",
      at: 999,
    });
  });
});
