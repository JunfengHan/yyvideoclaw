import type {
  CodexAppServerJobEvent,
  CodexAppServerJobHandle,
  SpawnCodexAppServerJobOptions,
} from "@openclaw/codex/api.js";
import { describe, expect, it, vi } from "vitest";
import type { JobEvent } from "../types.js";
import { createCodexEngine, __test__ } from "./codex-engine.js";

interface FakeHandleOptions {
  readonly threadId: string;
  readonly events: readonly CodexAppServerJobEvent[];
  /** Events emitted on each subsequent sendUserTurn call. */
  readonly retryEvents?: ReadonlyArray<readonly CodexAppServerJobEvent[]>;
}

function makeFakeSpawnJob(handles: FakeHandleOptions[]): {
  spawn: typeof import("@openclaw/codex/api.js").spawnCodexAppServerJob;
  closed: string[];
  sendCalls: Array<{ threadId: string; text: string }>;
} {
  const closed: string[] = [];
  const sendCalls: Array<{ threadId: string; text: string }> = [];
  let cursor = 0;
  // Auto-append a `turn_complete(completed)` if the scripted event list
  // doesn't already terminate with one. The real codex spawn helper only
  // resolves AFTER the turn settles, so the engine now insists on seeing
  // the terminal event — without this auto-append every test would have
  // to enumerate the boilerplate event.
  const ensureTerminal = (
    events: readonly CodexAppServerJobEvent[],
    threadId: string,
    turnId: string,
  ): readonly CodexAppServerJobEvent[] => {
    const last = events[events.length - 1];
    if (last && last.type === "turn_complete") {
      return events;
    }
    return [...events, { type: "turn_complete", threadId, turnId, status: "completed" }];
  };
  const spawn: typeof import("@openclaw/codex/api.js").spawnCodexAppServerJob = async (
    options: SpawnCodexAppServerJobOptions,
  ) => {
    const config = handles[cursor];
    cursor += 1;
    if (!config) {
      throw new Error(`unexpected spawn call at index ${cursor - 1}`);
    }
    // Replay scripted events for the initial turn.
    for (const event of ensureTerminal(config.events, config.threadId, "turn-initial")) {
      options.onEvent?.(event);
    }
    let retryIdx = 0;
    const handle: CodexAppServerJobHandle = {
      threadId: config.threadId,
      workspaceDir: options.workspaceDir,
      async sendUserTurn(text) {
        sendCalls.push({ threadId: config.threadId, text });
        const events = config.retryEvents?.[retryIdx] ?? [];
        retryIdx += 1;
        for (const event of ensureTerminal(events, config.threadId, `t-${retryIdx}`)) {
          options.onEvent?.(event);
        }
        return { turnId: `t-${retryIdx}`, status: "completed" };
      },
      abort() {
        // not exercised in these unit tests
      },
      async close() {
        closed.push(config.threadId);
      },
    };
    return handle;
  };
  return { spawn, closed, sendCalls };
}

describe("createCodexEngine", () => {
  it("forwards CodexAppServerJobEvents through the engine-events projector", async () => {
    const fake = makeFakeSpawnJob([
      {
        threadId: "thread-A",
        events: [
          { type: "thread_started", threadId: "thread-A", workspaceDir: "/tmp/ws" },
          { type: "turn_started", threadId: "thread-A", turnId: "turn-1" },
          { type: "agent_message", text: "Wrote Root.tsx", itemId: "m-1" },
          {
            type: "tool_call",
            callId: "c-1",
            name: "bash",
            input: { command: "ls" },
            status: "running",
          },
          {
            type: "tool_result",
            callId: "c-1",
            name: "bash",
            success: true,
            output: "ok",
          },
          {
            type: "turn_complete",
            threadId: "thread-A",
            turnId: "turn-1",
            status: "completed",
          },
        ],
      },
    ]);
    const engine = createCodexEngine({ spawnJob: fake.spawn });
    const events: JobEvent[] = [];
    const result = await engine.runAttempt({
      jobId: "job-1",
      workspaceDir: "/tmp/ws",
      prompt: "Make me a 5s title card.",
      allowNetwork: false,
      jobTimeoutMs: 60_000,
      abortSignal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });
    expect(result.sessionRef).toBe("thread-A");
    // thread_started + turn_started + turn_complete(completed) are dropped;
    // we should see message + tool_call + tool_result(synthesized).
    expect(events.map((e) => e.type)).toEqual(["engine_message", "engine_tool", "engine_tool"]);
    const [, toolCall, toolResult] = events;
    expect(toolCall).toMatchObject({ name: "bash", status: "running" });
    expect(toolResult).toMatchObject({ name: "bash → ok", status: "completed" });
  });

  it("retry() reuses the existing handle's sendUserTurn", async () => {
    const fake = makeFakeSpawnJob([
      {
        threadId: "thread-B",
        events: [],
        retryEvents: [
          [
            {
              type: "agent_message",
              text: "Fixed import",
              itemId: "m-2",
            },
            {
              type: "turn_complete",
              threadId: "thread-B",
              turnId: "turn-2",
              status: "completed",
            },
          ],
        ],
      },
    ]);
    const engine = createCodexEngine({ spawnJob: fake.spawn });
    const events: JobEvent[] = [];
    const initial = await engine.runAttempt({
      jobId: "job-2",
      workspaceDir: "/tmp/ws",
      prompt: "first try",
      allowNetwork: false,
      jobTimeoutMs: 60_000,
      abortSignal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });
    const retried = await engine.retry({
      jobId: "job-2",
      sessionRef: initial.sessionRef,
      digest: "validation failed at bundle: ...",
      abortSignal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });
    expect(retried.sessionRef).toBe(initial.sessionRef);
    expect(fake.sendCalls).toEqual([
      { threadId: "thread-B", text: "validation failed at bundle: ..." },
    ]);
    expect(events.map((e) => e.type)).toEqual(["engine_message"]);
  });

  it("retry throws when the sessionRef is unknown (orchestrator misuse)", async () => {
    const fake = makeFakeSpawnJob([{ threadId: "thread-C", events: [] }]);
    const engine = createCodexEngine({ spawnJob: fake.spawn });
    await engine.runAttempt({
      jobId: "job-3",
      workspaceDir: "/tmp/ws",
      prompt: "x",
      allowNetwork: false,
      jobTimeoutMs: 60_000,
      abortSignal: new AbortController().signal,
      onEvent: () => undefined,
    });
    await expect(
      engine.retry({
        jobId: "job-3",
        sessionRef: "no-such-thread",
        digest: "oops",
        abortSignal: new AbortController().signal,
        onEvent: () => undefined,
      }),
    ).rejects.toThrow(/unknown sessionRef/);
  });

  it("dispose closes the underlying handle and is idempotent", async () => {
    const fake = makeFakeSpawnJob([{ threadId: "thread-D", events: [] }]);
    const engine = createCodexEngine({ spawnJob: fake.spawn });
    await engine.runAttempt({
      jobId: "job-4",
      workspaceDir: "/tmp/ws",
      prompt: "x",
      allowNetwork: false,
      jobTimeoutMs: 60_000,
      abortSignal: new AbortController().signal,
      onEvent: () => undefined,
    });
    await engine.dispose("thread-D");
    await engine.dispose("thread-D");
    expect(fake.closed).toEqual(["thread-D"]);
  });

  it("hands sandbox+approvalPolicy defaults to spawnJob", async () => {
    const spawnSpy = vi.fn(async (options: SpawnCodexAppServerJobOptions) => {
      // Simulate the real codex spawn helper: it resolves only after the
      // first turn settles, so by the time the handle is returned the
      // engine must have observed a terminal `turn_complete` event.
      options.onEvent?.({
        type: "turn_complete",
        threadId: "thread-E",
        turnId: "turn-initial",
        status: "completed",
      });
      return {
        threadId: "thread-E",
        workspaceDir: options.workspaceDir,
        sendUserTurn: async () => ({ turnId: "t1", status: "completed" as const }),
        abort: () => undefined,
        close: async () => undefined,
      };
    });
    const engine = createCodexEngine({
      spawnJob:
        spawnSpy as unknown as typeof import("@openclaw/codex/api.js").spawnCodexAppServerJob,
    });
    await engine.runAttempt({
      jobId: "job-5",
      workspaceDir: "/tmp/ws",
      prompt: "noop",
      allowNetwork: false,
      jobTimeoutMs: 60_000,
      abortSignal: new AbortController().signal,
      onEvent: () => undefined,
    });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const opts = spawnSpy.mock.calls[0][0];
    expect(opts.sandbox).toBe("workspace-write");
    expect(opts.approvalPolicy).toBe("never");
    expect(opts.workspaceDir).toBe("/tmp/ws");
    expect(opts.initialPrompt).toBe("noop");
    expect(opts.developerInstructions).toContain("OpenClaw Remotion AI Create");
  });

  it("runAttempt throws when the first turn ends in failed", async () => {
    const fake = makeFakeSpawnJob([
      {
        threadId: "thread-fail",
        events: [
          {
            type: "turn_complete",
            threadId: "thread-fail",
            turnId: "turn-1",
            status: "failed",
            errorMessage: "model refused: rate limit",
          },
        ],
      },
    ]);
    const engine = createCodexEngine({ spawnJob: fake.spawn });
    await expect(
      engine.runAttempt({
        jobId: "job-fail",
        workspaceDir: "/tmp/ws",
        prompt: "x",
        allowNetwork: false,
        jobTimeoutMs: 60_000,
        abortSignal: new AbortController().signal,
        onEvent: () => undefined,
      }),
    ).rejects.toThrow(/codex agent attempt failed: model refused: rate limit/u);
  });

  it("runAttempt throws when the first turn ends in interrupted", async () => {
    const fake = makeFakeSpawnJob([
      {
        threadId: "thread-int",
        events: [
          {
            type: "turn_complete",
            threadId: "thread-int",
            turnId: "turn-1",
            status: "interrupted",
          },
        ],
      },
    ]);
    const engine = createCodexEngine({ spawnJob: fake.spawn });
    await expect(
      engine.runAttempt({
        jobId: "job-int",
        workspaceDir: "/tmp/ws",
        prompt: "x",
        allowNetwork: false,
        jobTimeoutMs: 60_000,
        abortSignal: new AbortController().signal,
        onEvent: () => undefined,
      }),
    ).rejects.toThrow(/codex agent attempt interrupted/u);
  });
});

describe("withBundledCodexCommand (codex bin resolution)", () => {
  // We exercise the helper directly (re-exported via __test__) rather than
  // mocking createRequire. In the test environment `@openai/codex` is a
  // declared remotion-ai dependency, so the bundled bin resolves to a real
  // absolute path and the helper injects `appServer.command`.
  const { withBundledCodexCommand, resolveBundledCodexBin } = __test__;

  it("resolves the bundled @openai/codex CLI to an absolute path", () => {
    const bin = resolveBundledCodexBin();
    expect(bin).toMatch(/node_modules\/@openai\/codex\/bin\/codex\.js$/);
  });

  it("injects appServer.command pointing at the bundled bin when none is configured", () => {
    const result = withBundledCodexCommand(undefined) as {
      appServer?: { command?: string; args?: string[] };
    };
    expect(result.appServer?.command).toBe(process.execPath);
    expect(result.appServer?.args?.[0]).toMatch(/codex\.js$/);
    expect(result.appServer?.args?.slice(1)).toEqual(["app-server", "--listen", "stdio://"]);
  });

  it("respects an explicit user-provided appServer.command", () => {
    const result = withBundledCodexCommand({
      appServer: { command: "/opt/local/bin/codex" },
    }) as { appServer?: { command?: string } };
    expect(result.appServer?.command).toBe("/opt/local/bin/codex");
  });

  it("respects OPENCLAW_CODEX_APP_SERVER_BIN env override", () => {
    const prev = process.env.OPENCLAW_CODEX_APP_SERVER_BIN;
    process.env.OPENCLAW_CODEX_APP_SERVER_BIN = "/usr/local/bin/codex";
    try {
      const result = withBundledCodexCommand(undefined) as {
        appServer?: { command?: string };
      };
      // The helper does NOT set command in this case — it leaves the env
      // var to win via the codex plugin's own resolution chain.
      expect(result.appServer?.command).toBeUndefined();
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCLAW_CODEX_APP_SERVER_BIN;
      } else {
        process.env.OPENCLAW_CODEX_APP_SERVER_BIN = prev;
      }
    }
  });
});
