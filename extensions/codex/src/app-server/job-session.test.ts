import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { spawnCodexAppServerJob, type CodexAppServerJobEvent } from "./job-session.js";
import { createClientHarness } from "./test-support.js";

const mocks = vi.hoisted(() => ({
  bridgeCodexAppServerStartOptions: vi.fn(async ({ startOptions }) => startOptions),
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
}));

vi.mock("./auth-bridge.js", () => ({
  bridgeCodexAppServerStartOptions: mocks.bridgeCodexAppServerStartOptions,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveOpenClawAgentDir: mocks.resolveOpenClawAgentDir,
}));

interface ScriptedResponse {
  readonly match: (method: string, params: unknown) => boolean;
  readonly respond: (harness: ReturnType<typeof createClientHarness>, id: number | string) => void;
}

/** Minimal `Thread` object that satisfies the ajv schema in `protocol-validators.ts`. */
function buildFakeThread(id: string, cwd: string): Record<string, unknown> {
  return {
    id,
    forkedFromId: null,
    preview: "",
    ephemeral: true,
    modelProvider: "openai",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    status: { type: "idle" },
    path: null,
    cwd,
    cliVersion: "0.999.0",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

describe("spawnCodexAppServerJob", () => {
  let harness: ReturnType<typeof createClientHarness>;
  let startSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    harness = createClientHarness();
    // Every test replaces `CodexAppServerClient.start(...)` with the harness'
    // in-memory transport so we don't spawn a real codex binary.
    startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
  });

  afterEach(() => {
    startSpy.mockRestore();
    vi.restoreAllMocks();
    mocks.bridgeCodexAppServerStartOptions.mockClear();
    mocks.resolveOpenClawAgentDir.mockClear();
  });

  /**
   * Start a background poller that watches every write issued by the
   * client, matches it against the scripted table (in order, consuming
   * each step once), and fires the configured response. Returns a stop
   * handle that must be called to tear down the poller.
   *
   * This is preferred over a one-shot "drain" because the test can run
   * multiple turns (initial + sendUserTurn), and each turn issues its
   * own `turn/start` after arbitrary async gaps.
   */
  function startHarnessResponder(script: ScriptedResponse[]): {
    stop(): void;
    scriptIndex(): number;
  } {
    let cursor = 0;
    let scriptIndex = 0;
    const interval = setInterval(() => {
      while (cursor < harness.writes.length && scriptIndex < script.length) {
        const message = JSON.parse(harness.writes[cursor] ?? "{}") as {
          id?: number | string;
          method?: string;
          params?: unknown;
        };
        cursor += 1;
        if (!message.method || message.id === undefined) {
          continue;
        }
        const step = script[scriptIndex];
        if (!step || !step.match(message.method, message.params)) {
          continue;
        }
        scriptIndex += 1;
        step.respond(harness, message.id);
      }
    }, 5);
    interval.unref?.();
    return {
      stop: () => clearInterval(interval),
      scriptIndex: () => scriptIndex,
    };
  }

  function captureEvents(): {
    events: CodexAppServerJobEvent[];
    onEvent: (event: CodexAppServerJobEvent) => void;
  } {
    const events: CodexAppServerJobEvent[] = [];
    return { events, onEvent: (event) => events.push(event) };
  }

  it("runs a single initial turn and projects turn/completed into job events", async () => {
    const { events, onEvent } = captureEvents();

    const script: ScriptedResponse[] = [
      {
        match: (method) => method === "initialize",
        respond: (h, id) => h.send({ id, result: { userAgent: "Codex/0.999.0 test" } }),
      },
      {
        match: (method) => method === "thread/start",
        respond: (h, id) =>
          h.send({
            id,
            result: {
              thread: buildFakeThread("thread-1", "/tmp/ws"),
              model: "gpt-5.4-codex",
              modelProvider: "openai",
              serviceTier: null,
              cwd: "/tmp/ws",
              instructionSources: [],
              approvalPolicy: "never",
              approvalsReviewer: "user",
              sandbox: {
                type: "workspaceWrite",
                writableRoots: ["/tmp/ws"],
                readOnlyAccess: { type: "fullAccess" },
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              },
              permissionProfile: null,
              reasoningEffort: null,
            },
          }),
      },
      {
        match: (method) => method === "turn/start",
        respond: (h, id) => {
          h.send({
            id,
            result: {
              turn: {
                id: "turn-1",
                items: [],
                status: "inProgress",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
              },
            },
          });
          // Server pushes a turn/completed notification shortly after.
          setImmediate(() => {
            h.send({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  error: null,
                  startedAt: 0,
                  completedAt: 0,
                  durationMs: 42,
                  items: [
                    {
                      type: "agentMessage",
                      id: "msg-1",
                      text: "Wrote src/Root.tsx",
                      phase: null,
                      memoryCitation: null,
                    },
                    {
                      type: "commandExecution",
                      id: "cmd-1",
                      command: "echo hi",
                      cwd: "/tmp/ws",
                      processId: null,
                      source: "agent",
                      status: "completed",
                      commandActions: [],
                      aggregatedOutput: "hi\n",
                      exitCode: 0,
                      durationMs: 10,
                    },
                  ],
                },
              },
            });
          });
        },
      },
    ];

    const handlePromise = spawnCodexAppServerJob({
      workspaceDir: "/tmp/ws",
      initialPrompt: "Build a title card video",
      pluginConfig: {},
      onEvent,
    });
    const responder = startHarnessResponder(script);
    const handle = await handlePromise;
    expect(handle.threadId).toBe("thread-1");
    expect(handle.workspaceDir).toBe("/tmp/ws");

    // thread_started → turn_started → agent_message → tool_call(bash) →
    // tool_result(bash) → turn_complete(completed)
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "thread_started",
      "turn_started",
      "agent_message",
      "tool_call",
      "tool_result",
      "turn_complete",
    ]);
    const [, , agentMsg, toolCall, toolResult, complete] = events;
    expect(agentMsg).toMatchObject({
      type: "agent_message",
      text: "Wrote src/Root.tsx",
      itemId: "msg-1",
    });
    expect(toolCall).toMatchObject({
      type: "tool_call",
      callId: "cmd-1",
      name: "bash",
      status: "completed",
    });
    expect(toolResult).toMatchObject({
      type: "tool_result",
      callId: "cmd-1",
      name: "bash",
      success: true,
      exitCode: 0,
      output: "hi\n",
      durationMs: 10,
    });
    expect(complete).toMatchObject({
      type: "turn_complete",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
    });

    await handle.close();
    responder.stop();
  });

  it("ignores retryable app-server error notifications while the turn continues", async () => {
    const { events, onEvent } = captureEvents();

    const script: ScriptedResponse[] = [
      {
        match: (method) => method === "initialize",
        respond: (h, id) => h.send({ id, result: { userAgent: "Codex/0.999.0 test" } }),
      },
      {
        match: (method) => method === "thread/start",
        respond: (h, id) =>
          h.send({
            id,
            result: {
              thread: buildFakeThread("thread-retryable", "/tmp/ws"),
              model: "gpt-5.4-codex",
              modelProvider: "openai",
              serviceTier: null,
              cwd: "/tmp/ws",
              instructionSources: [],
              approvalPolicy: "never",
              approvalsReviewer: "user",
              sandbox: { type: "dangerFullAccess" },
              permissionProfile: null,
              reasoningEffort: null,
            },
          }),
      },
      {
        match: (method) => method === "turn/start",
        respond: (h, id) => {
          h.send({
            id,
            result: {
              turn: {
                id: "turn-retryable",
                items: [],
                status: "inProgress",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
              },
            },
          });
          setImmediate(() => {
            h.send({
              method: "error",
              params: {
                threadId: "thread-retryable",
                turnId: "turn-retryable",
                willRetry: true,
                error: { message: "stream disconnected" },
              },
            });
            h.send({
              method: "turn/completed",
              params: {
                threadId: "thread-retryable",
                turnId: "turn-retryable",
                turn: {
                  id: "turn-retryable",
                  status: "completed",
                  error: null,
                  startedAt: 0,
                  completedAt: 0,
                  durationMs: 42,
                  items: [],
                },
              },
            });
          });
        },
      },
    ];

    const handlePromise = spawnCodexAppServerJob({
      workspaceDir: "/tmp/ws",
      initialPrompt: "Build a title card video",
      onEvent,
    });
    const responder = startHarnessResponder(script);
    const handle = await handlePromise;

    const completeEvents = events.filter(
      (event): event is Extract<CodexAppServerJobEvent, { type: "turn_complete" }> =>
        event.type === "turn_complete",
    );
    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0]).toMatchObject({ status: "completed" });

    await handle.close();
    responder.stop();
  });

  it("supports sendUserTurn (retry-with-digest) on the same thread", async () => {
    const { events, onEvent } = captureEvents();
    const script: ScriptedResponse[] = [
      {
        match: (method) => method === "initialize",
        respond: (h, id) => h.send({ id, result: { userAgent: "Codex/0.999.0 test" } }),
      },
      {
        match: (method) => method === "thread/start",
        respond: (h, id) =>
          h.send({
            id,
            result: {
              thread: buildFakeThread("thread-2", "/tmp/ws"),
              model: "gpt-5.4-codex",
              modelProvider: "openai",
              serviceTier: null,
              cwd: "/tmp/ws",
              instructionSources: [],
              approvalPolicy: "never",
              approvalsReviewer: "user",
              sandbox: { type: "dangerFullAccess" },
              permissionProfile: null,
              reasoningEffort: null,
            },
          }),
      },
      {
        match: (method) => method === "turn/start",
        respond: (h, id) => {
          h.send({
            id,
            result: {
              turn: {
                id: "turn-a",
                items: [],
                status: "inProgress",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
              },
            },
          });
          setImmediate(() => {
            h.send({
              method: "turn/completed",
              params: {
                threadId: "thread-2",
                turnId: "turn-a",
                turn: {
                  id: "turn-a",
                  status: "failed",
                  error: { message: "bundle failed" },
                  startedAt: 0,
                  completedAt: 0,
                  durationMs: 5,
                  items: [],
                },
              },
            });
          });
        },
      },
      {
        match: (method) => method === "turn/start",
        respond: (h, id) => {
          h.send({
            id,
            result: {
              turn: {
                id: "turn-b",
                items: [],
                status: "inProgress",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
              },
            },
          });
          setImmediate(() => {
            h.send({
              method: "turn/completed",
              params: {
                threadId: "thread-2",
                turnId: "turn-b",
                turn: {
                  id: "turn-b",
                  status: "completed",
                  error: null,
                  startedAt: 0,
                  completedAt: 0,
                  durationMs: 5,
                  items: [
                    {
                      type: "agentMessage",
                      id: "msg-fixed",
                      text: "Fixed the import path",
                      phase: null,
                      memoryCitation: null,
                    },
                  ],
                },
              },
            });
          });
        },
      },
    ];

    const handlePromise = spawnCodexAppServerJob({
      workspaceDir: "/tmp/ws",
      initialPrompt: "Build a title card video",
      onEvent,
    });
    const responder = startHarnessResponder(script);
    const handle = await handlePromise;

    // First turn should have completed (with failed status).
    expect(events.filter((e) => e.type === "turn_complete")).toHaveLength(1);
    const firstComplete = events.find(
      (e): e is Extract<CodexAppServerJobEvent, { type: "turn_complete" }> =>
        e.type === "turn_complete",
    );
    expect(firstComplete?.status).toBe("failed");
    expect(firstComplete?.errorMessage).toBe("bundle failed");

    events.length = 0;
    const outcome = await handle.sendUserTurn("Digest: bundle failed at src/Root.tsx:12");
    expect(outcome).toEqual({ turnId: "turn-b", status: "completed" });
    const followUpTypes = events.map((e) => e.type);
    expect(followUpTypes).toEqual(["turn_started", "agent_message", "turn_complete"]);

    await handle.close();
    responder.stop();
  });

  it("aborts in-flight work and closes the app-server when abort() is called", async () => {
    const { events, onEvent } = captureEvents();

    const script: ScriptedResponse[] = [
      {
        match: (method) => method === "initialize",
        respond: (h, id) => h.send({ id, result: { userAgent: "Codex/0.999.0 test" } }),
      },
      {
        match: (method) => method === "thread/start",
        respond: (h, id) =>
          h.send({
            id,
            result: {
              thread: buildFakeThread("thread-3", "/tmp/ws"),
              model: "gpt-5.4-codex",
              modelProvider: "openai",
              serviceTier: null,
              cwd: "/tmp/ws",
              instructionSources: [],
              approvalPolicy: "never",
              approvalsReviewer: "user",
              sandbox: { type: "dangerFullAccess" },
              permissionProfile: null,
              reasoningEffort: null,
            },
          }),
      },
      {
        match: (method) => method === "turn/start",
        respond: (h, id) => {
          h.send({
            id,
            result: {
              turn: {
                id: "turn-x",
                items: [],
                status: "inProgress",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
              },
            },
          });
          // No turn/completed — we simulate an in-flight turn that the
          // caller aborts.
        },
      },
    ];

    const abortController = new AbortController();
    const handlePromise = spawnCodexAppServerJob({
      workspaceDir: "/tmp/ws",
      initialPrompt: "Build a title card video",
      abortSignal: abortController.signal,
      onEvent,
    });

    const responder = startHarnessResponder(script);

    // Wait until the initial turn has actually started before firing the
    // abort; otherwise we'd race the abort against the in-flight
    // `thread/start` / `turn/start` RPCs and end up failing the RPC
    // itself rather than exercising the "cancel an in-flight turn" path.
    await vi.waitFor(
      () => {
        expect(events.map((e) => e.type)).toContain("turn_started");
      },
      { timeout: 5000, interval: 10 },
    );

    // Fire the upstream abort; the in-flight initial turn should reject.
    abortController.abort("user cancel");

    await expect(handlePromise).rejects.toThrow(/aborted/i);
    expect(events.map((e) => e.type)).toContain("thread_started");
    expect(events.map((e) => e.type)).toContain("turn_started");
    responder.stop();
  });
});
