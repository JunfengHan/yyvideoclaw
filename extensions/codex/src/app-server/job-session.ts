// extensions/codex/src/app-server/job-session.ts
//
// Thin, headless "run one coding job" layer over the Codex app-server.
//
// Purpose (A2, see extensions/codex/api.ts):
//   Other bundled extensions (M1 consumer: `@openclaw/remotion-ai`) sometimes
//   need to drive a Codex app-server thread purely as a code-generation
//   backend — no OpenClaw main-session transcript, no EmbeddedRunAttemptParams,
//   no pi-coding-agent SessionManager, no approval routing. This module
//   provides exactly that seam.
//
// It reuses:
//   - `CodexAppServerClient` for JSON-RPC + notifications + request handlers.
//   - `createIsolatedCodexAppServerClient` so every job owns its own
//     app-server child (no contention with the shared main-session client).
//   - `resolveCodexAppServerRuntimeOptions` to honor `plugins.entries.codex`
//     config (transport, command, url, authToken, requestTimeoutMs, ...).
//   - `codexSandboxPolicyForTurn` so the turn-level sandbox policy matches
//     what the main harness would use for the same workspaceDir.
//
// It does NOT reuse:
//   - `thread-lifecycle.ts` (takes `EmbeddedRunAttemptParams`, writes the
//     codex binding file next to a session file — wrong for job mode).
//   - `event-projector.ts` (projects into pi-coding-agent transcripts —
//     wrong for job mode).
//   - `run-attempt.ts` (orchestrates an OpenClaw main-session attempt end-
//     to-end, including tools, context engine, trajectory — wrong shape).

import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  resolveCodexAppServerRuntimeOptions,
  codexSandboxPolicyForTurn,
  type CodexAppServerApprovalPolicy,
  type CodexAppServerSandboxMode,
  type CodexAppServerTransportMode,
} from "./config.js";
import {
  assertCodexThreadStartResponse,
  assertCodexTurnStartResponse,
} from "./protocol-validators.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type CodexThreadItem,
  type CodexTurn,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

// --------------------------------------------------------------------------
// Public surface (re-exported by `extensions/codex/api.ts`).
// --------------------------------------------------------------------------

export type CodexAppServerJobEvent =
  | { readonly type: "thread_started"; readonly threadId: string; readonly workspaceDir: string }
  | { readonly type: "turn_started"; readonly threadId: string; readonly turnId: string }
  | { readonly type: "agent_message"; readonly text: string; readonly itemId: string }
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly name: string;
      readonly namespace?: string;
      readonly input: JsonValue;
      readonly status: string;
    }
  | {
      readonly type: "tool_result";
      readonly callId: string;
      readonly name: string;
      readonly namespace?: string;
      readonly success: boolean;
      readonly exitCode?: number;
      readonly output?: string;
      readonly durationMs?: number;
    }
  | {
      readonly type: "turn_complete";
      readonly threadId: string;
      readonly turnId: string;
      readonly status: "completed" | "failed" | "interrupted";
      readonly errorMessage?: string;
    };

export interface CodexAppServerJobHandle {
  readonly threadId: string;
  readonly workspaceDir: string;
  /**
   * Send a follow-up user turn on the SAME thread. Resolves when the new
   * turn is complete (or failed/interrupted). Use this for the retry-with-
   * error-digest loop.
   */
  sendUserTurn(
    text: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly turnId: string; readonly status: "completed" | "failed" | "interrupted" }>;
  /** Abort the currently-running turn (if any) and close the underlying app-server child. */
  abort(reason?: string): void;
  /** Wait for any in-flight turn to settle, then close the app-server child. Idempotent. */
  close(): Promise<void>;
}

export interface SpawnCodexAppServerJobOptions {
  /** Absolute path to the isolated AI workspace. The Codex agent's cwd is pinned to this directory. */
  readonly workspaceDir: string;
  /** First user turn to run after `thread/start`. */
  readonly initialPrompt: string;
  /** Optional model override. Leave undefined to let Codex app-server pick its default. */
  readonly model?: string;
  /**
   * Approval policy for server-side file/command approval requests. Defaults
   * to "never" for headless jobs (the caller owns the sandbox via
   * `workspaceDir`).
   */
  readonly approvalPolicy?: CodexAppServerApprovalPolicy;
  /**
   * Sandbox mode. Defaults to "workspace-write" so Codex can freely edit
   * files under `workspaceDir` but cannot reach outside it.
   */
  readonly sandbox?: CodexAppServerSandboxMode;
  /** Override transport (`stdio` | `websocket`). Falls back to pluginConfig / env. */
  readonly transport?: CodexAppServerTransportMode;
  /** Optional per-job auth profile. */
  readonly authProfileId?: string;
  /** Override app-server request timeout (ms). Falls back to pluginConfig (default 60_000). */
  readonly requestTimeoutMs?: number;
  /** Abort the entire job (thread/start + all turns). */
  readonly abortSignal?: AbortSignal;
  /** Event callback. Errors thrown here are swallowed to protect the turn lifecycle. */
  readonly onEvent?: (event: CodexAppServerJobEvent) => void;
  /**
   * Optional Codex plugin config object (parsed into runtime options). If
   * omitted the helper falls back to `resolveCodexAppServerRuntimeOptions()`'s
   * defaults, which read env vars.
   */
  readonly pluginConfig?: unknown;
  /**
   * Optional developer-facing prompt prepended to every turn. M1 callers
   * can use this to hand the agent project-specific rules (e.g. "always
   * keep src/Root.tsx exporting a named `Root` component").
   */
  readonly developerInstructions?: string;
}

/**
 * Start an isolated Codex app-server thread, send the initial user turn,
 * and return a handle that emits structured events for the consumer. The
 * returned promise resolves once the FIRST turn is fully settled (completed
 * / failed / interrupted). Use `handle.sendUserTurn(...)` to send retries.
 *
 * The caller owns the lifecycle: every successful `spawnCodexAppServerJob`
 * MUST be matched by `handle.close()` (or `handle.abort()` on cancellation).
 */
export async function spawnCodexAppServerJob(
  options: SpawnCodexAppServerJobOptions,
): Promise<CodexAppServerJobHandle> {
  const runtimeOptions = resolveCodexAppServerRuntimeOptions({
    pluginConfig: options.pluginConfig,
  });
  const transport = options.transport ?? runtimeOptions.start.transport;
  const approvalPolicy = options.approvalPolicy ?? "never";
  const sandbox = options.sandbox ?? "workspace-write";
  const requestTimeoutMs = options.requestTimeoutMs ?? runtimeOptions.requestTimeoutMs;

  const client = await createIsolatedCodexAppServerClient({
    startOptions: { ...runtimeOptions.start, transport },
    authProfileId: options.authProfileId,
    timeoutMs: requestTimeoutMs,
  });

  let closed = false;
  let currentRun: JobTurnRun | undefined;
  const emit = (event: CodexAppServerJobEvent): void => {
    try {
      options.onEvent?.(event);
    } catch (error) {
      embeddedAgentLog.debug("codex job onEvent handler threw", { error });
    }
  };

  const onCloseHandler = (): void => {
    if (closed) {
      return;
    }
    currentRun?.rejectPending(new Error("codex app-server closed"));
  };
  client.addCloseHandler(onCloseHandler);
  client.addNotificationHandler((notification) => {
    currentRun?.handleNotification(notification);
  });
  client.addRequestHandler(() => {
    // Let the default server-request response handle approval / tool_call
    // fallbacks. In headless mode with approvalPolicy=never / sandbox=
    // workspace-write, Codex should not be sending these; if it does, the
    // defaults (decline approvals, reject tool calls) keep the turn alive.
    return undefined;
  });

  let threadStart;
  try {
    threadStart = assertCodexThreadStartResponse(
      await client.request(
        "thread/start",
        {
          ...(options.model ? { model: options.model } : {}),
          cwd: options.workspaceDir,
          approvalPolicy,
          sandbox,
          serviceName: "OpenClaw (remotion-ai job)",
          ...(options.developerInstructions
            ? { developerInstructions: options.developerInstructions }
            : {}),
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
        { timeoutMs: requestTimeoutMs, signal: options.abortSignal },
      ),
    );
  } catch (error) {
    client.close();
    throw error;
  }

  const threadId = threadStart.thread.id;
  emit({ type: "thread_started", threadId, workspaceDir: options.workspaceDir });

  const runTurn = async (
    text: string,
    turnSignal: AbortSignal | undefined,
  ): Promise<{ turnId: string; status: "completed" | "failed" | "interrupted" }> => {
    if (closed) {
      throw new Error("codex app-server job is closed");
    }
    const run = new JobTurnRun({ threadId, emit });
    currentRun = run;
    try {
      const startResponse = assertCodexTurnStartResponse(
        await client.request(
          "turn/start",
          {
            threadId,
            input: [{ type: "text", text, text_elements: [] }],
            cwd: options.workspaceDir,
            approvalPolicy,
            sandboxPolicy: codexSandboxPolicyForTurn(sandbox, options.workspaceDir),
            ...(options.model ? { model: options.model } : {}),
          },
          { timeoutMs: requestTimeoutMs, signal: turnSignal },
        ),
      );
      const turnId = startResponse.turn.id;
      run.bindTurnId(turnId);
      emit({ type: "turn_started", threadId, turnId });

      if (isTerminalTurnStatus(startResponse.turn.status)) {
        run.forceCompletionFromResponse(startResponse.turn);
      }

      const outcome = await run.waitForCompletion(turnSignal);
      return { turnId, status: outcome.status };
    } finally {
      if (currentRun === run) {
        currentRun = undefined;
      }
    }
  };

  const initialSignal = mergeSignals(options.abortSignal);
  try {
    await runTurn(options.initialPrompt, initialSignal.signal);
  } catch (error) {
    initialSignal.dispose();
    closed = true;
    client.close();
    throw error;
  }
  initialSignal.dispose();

  return {
    threadId,
    workspaceDir: options.workspaceDir,
    async sendUserTurn(text, turnOptions) {
      const merged = mergeSignals(options.abortSignal, turnOptions?.signal);
      try {
        return await runTurn(text, merged.signal);
      } finally {
        merged.dispose();
      }
    },
    abort(reason?: string) {
      if (closed) {
        return;
      }
      const error = new Error(reason ?? "codex app-server job aborted");
      currentRun?.rejectPending(error);
      closed = true;
      client.close();
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await currentRun?.waitForCompletion(undefined).catch(() => undefined);
      } finally {
        client.close();
      }
    },
  } satisfies CodexAppServerJobHandle;
}

// --------------------------------------------------------------------------
// Internal: per-turn notification projection.
// --------------------------------------------------------------------------

interface JobTurnRunParams {
  readonly threadId: string;
  readonly emit: (event: CodexAppServerJobEvent) => void;
}

class JobTurnRun {
  private readonly threadId: string;
  private readonly emit: (event: CodexAppServerJobEvent) => void;
  private turnId: string | undefined;
  private readonly pendingNotifications: CodexServerNotification[] = [];
  private settled = false;
  private resolver:
    | ((value: { status: "completed" | "failed" | "interrupted" }) => void)
    | undefined;
  private rejecter: ((error: Error) => void) | undefined;
  private waitPromise: Promise<{ status: "completed" | "failed" | "interrupted" }> | undefined;
  private readonly emittedToolCallIds = new Set<string>();

  constructor(params: JobTurnRunParams) {
    this.threadId = params.threadId;
    this.emit = params.emit;
  }

  bindTurnId(turnId: string): void {
    this.turnId = turnId;
    for (const notification of this.pendingNotifications.splice(0)) {
      this.handleNotification(notification);
    }
  }

  handleNotification(notification: CodexServerNotification): void {
    if (this.settled) {
      return;
    }
    if (!this.turnId) {
      this.pendingNotifications.push(notification);
      return;
    }
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return;
    }
    if (!this.isForThisTurn(params)) {
      return;
    }
    switch (notification.method) {
      case "turn/completed":
        this.handleTurnCompleted(params);
        break;
      case "error":
        this.handleErrorNotification(params);
        break;
      default:
        break;
    }
  }

  async waitForCompletion(
    signal: AbortSignal | undefined,
  ): Promise<{ status: "completed" | "failed" | "interrupted" }> {
    if (this.settled) {
      return { status: "completed" };
    }
    this.waitPromise ??= new Promise<{ status: "completed" | "failed" | "interrupted" }>(
      (resolve, reject) => {
        this.resolver = resolve;
        this.rejecter = reject;
      },
    );
    const waitSignal = signal;
    if (waitSignal) {
      if (waitSignal.aborted) {
        this.rejectPending(new Error("codex app-server turn aborted"));
      } else {
        const listener = (): void => {
          this.rejectPending(new Error("codex app-server turn aborted"));
        };
        waitSignal.addEventListener("abort", listener, { once: true });
        // Dispose on settle.
        this.waitPromise = this.waitPromise.finally(() => {
          waitSignal.removeEventListener("abort", listener);
        });
      }
    }
    return this.waitPromise;
  }

  rejectPending(error: Error): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.rejecter?.(error);
  }

  forceCompletionFromResponse(turn: CodexTurn): void {
    // `turn/start` response only populates `items` on resume/fork; for a
    // fresh turn items are [] but status may already be terminal in
    // pathological/stubbed cases. Emit a synthetic turn_complete.
    this.applyTerminalTurn(turn);
  }

  private isForThisTurn(params: JsonObject): boolean {
    const threadId = readStringField(params, "threadId");
    if (threadId && threadId !== this.threadId) {
      return false;
    }
    const turnId =
      readStringField(params, "turnId") ??
      readStringField(isJsonObject(params.turn) ? params.turn : undefined, "id");
    if (turnId && this.turnId && turnId !== this.turnId) {
      return false;
    }
    return true;
  }

  private handleTurnCompleted(params: JsonObject): void {
    const turnValue = params.turn;
    if (!isJsonObject(turnValue)) {
      return;
    }
    this.applyTerminalTurn(turnValue as unknown as CodexTurn);
  }

  private handleErrorNotification(params: JsonObject): void {
    const message = readErrorNotificationMessage(params);
    if (readBooleanField(params, "willRetry") === true) {
      embeddedAgentLog.debug("codex job turn saw retryable app-server error", {
        ...(message ? { error: message } : {}),
      });
      return;
    }
    this.emit({
      type: "turn_complete",
      threadId: this.threadId,
      turnId: this.turnId ?? "",
      status: "failed",
      errorMessage: message ?? "codex app-server error",
    });
    this.settled = true;
    this.resolver?.({ status: "failed" });
  }

  private applyTerminalTurn(turn: CodexTurn): void {
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const item of items) {
      this.projectThreadItem(item);
    }
    const status = normalizeTurnStatus(turn.status);
    const errorMessage = turn.error?.message;
    this.emit({
      type: "turn_complete",
      threadId: this.threadId,
      turnId: this.turnId ?? turn.id ?? "",
      status,
      ...(errorMessage ? { errorMessage } : {}),
    });
    this.settled = true;
    this.resolver?.({ status });
  }

  private projectThreadItem(item: CodexThreadItem): void {
    switch (item.type) {
      case "agentMessage": {
        if (item.text) {
          this.emit({ type: "agent_message", text: item.text, itemId: item.id });
        }
        break;
      }
      case "dynamicToolCall": {
        this.emitToolCallPair({
          callId: item.id,
          name: item.tool,
          namespace: item.namespace ?? undefined,
          input: item.arguments ?? null,
          status: item.status,
          success: item.success ?? undefined,
          contentItems: item.contentItems ?? undefined,
          durationMs: item.durationMs ?? undefined,
        });
        break;
      }
      case "commandExecution": {
        this.emitToolCallPair({
          callId: item.id,
          name: "bash",
          input: { command: item.command, cwd: item.cwd },
          status: item.status,
          success: typeof item.exitCode === "number" ? item.exitCode === 0 : undefined,
          exitCode: item.exitCode ?? undefined,
          output: item.aggregatedOutput ?? undefined,
          durationMs: item.durationMs ?? undefined,
        });
        break;
      }
      case "fileChange": {
        this.emitToolCallPair({
          callId: item.id,
          name: "apply_patch",
          input: { changes: item.changes as unknown as JsonValue },
          status: item.status,
          success: item.status === "applied",
        });
        break;
      }
      default:
        // reasoning / plan / userMessage / mcpToolCall / etc. are ignored in
        // job mode to keep the UI event stream small and stable.
        break;
    }
  }

  private emitToolCallPair(params: {
    readonly callId: string;
    readonly name: string;
    readonly namespace?: string;
    readonly input: JsonValue;
    readonly status: string;
    readonly success?: boolean;
    readonly exitCode?: number;
    readonly output?: string;
    readonly durationMs?: number;
    readonly contentItems?: ReadonlyArray<unknown>;
  }): void {
    if (this.emittedToolCallIds.has(params.callId)) {
      return;
    }
    this.emittedToolCallIds.add(params.callId);
    this.emit({
      type: "tool_call",
      callId: params.callId,
      name: params.name,
      ...(params.namespace ? { namespace: params.namespace } : {}),
      input: params.input,
      status: params.status,
    });
    const derivedSuccess = params.success ?? !isFailureStatus(params.status);
    const output = params.output ?? contentItemsToText(params.contentItems);
    this.emit({
      type: "tool_result",
      callId: params.callId,
      name: params.name,
      ...(params.namespace ? { namespace: params.namespace } : {}),
      success: derivedSuccess,
      ...(typeof params.exitCode === "number" ? { exitCode: params.exitCode } : {}),
      ...(output ? { output } : {}),
      ...(typeof params.durationMs === "number" ? { durationMs: params.durationMs } : {}),
    });
  }
}

function contentItemsToText(items: ReadonlyArray<unknown> | undefined): string | undefined {
  if (!items || items.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as { type?: unknown; text?: unknown };
    if (record.type === "outputText" && typeof record.text === "string") {
      parts.push(record.text);
    } else if (record.type === "inputText" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function normalizeTurnStatus(value: unknown): "completed" | "failed" | "interrupted" {
  if (value === "failed" || value === "interrupted") {
    return value;
  }
  return "completed";
}

function isTerminalTurnStatus(value: unknown): boolean {
  return value === "completed" || value === "failed" || value === "interrupted";
}

function isFailureStatus(value: string): boolean {
  return value === "failed" || value === "interrupted" || value === "error";
}

function readStringField(value: JsonObject | undefined, key: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const entry = value[key];
  return typeof entry === "string" ? entry : undefined;
}

function readBooleanField(value: JsonObject | undefined, key: string): boolean | undefined {
  if (!value) {
    return undefined;
  }
  const entry = value[key];
  return typeof entry === "boolean" ? entry : undefined;
}

function readErrorNotificationMessage(params: JsonObject): string | undefined {
  const nestedError = isJsonObject(params.error) ? params.error : undefined;
  return readStringField(params, "message") ?? readStringField(nestedError, "message");
}

interface SignalMerge {
  readonly signal: AbortSignal | undefined;
  dispose(): void;
}

function mergeSignals(...signals: Array<AbortSignal | undefined>): SignalMerge {
  const defined = signals.filter((entry): entry is AbortSignal => Boolean(entry));
  if (defined.length === 0) {
    return { signal: undefined, dispose: () => undefined };
  }
  if (defined.length === 1) {
    return { signal: defined[0], dispose: () => undefined };
  }
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  for (const signal of defined) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const listener = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push(() => signal.removeEventListener("abort", listener));
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const remove of listeners) {
        remove();
      }
    },
  };
}
