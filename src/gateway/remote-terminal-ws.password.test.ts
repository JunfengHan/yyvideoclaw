import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import { createPreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { withTempConfig } from "./test-temp-config.js";

const WS_CONNECT_TIMEOUT_MS = 5_000;
const SERVER_CLOSE_TIMEOUT_MS = 5_000;

const ptyHandles: Array<{
  pid: number;
  writes: string[];
  dataEmitter: EventEmitter;
  exitEmitter: EventEmitter;
  args: string[] | string;
}> = [];

vi.mock("@lydell/node-pty", () => ({
  spawn: vi.fn((_file: string, args: string[] | string) => {
    const dataEmitter = new EventEmitter();
    const exitEmitter = new EventEmitter();
    const handle = {
      pid: 1234,
      writes: [] as string[],
      dataEmitter,
      exitEmitter,
      args,
      write(data: string | Buffer) {
        this.writes.push(String(data));
      },
      onData(listener: (value: string) => void) {
        dataEmitter.on("data", listener);
        return { dispose: () => dataEmitter.off("data", listener) };
      },
      onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
        exitEmitter.on("exit", listener);
        return { dispose: () => exitEmitter.off("exit", listener) };
      },
      kill: vi.fn(),
      resize: vi.fn(),
    };
    ptyHandles.push(handle);
    return handle;
  }),
}));

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function listen(
  server: ReturnType<typeof createGatewayHttpServer>,
  host = "127.0.0.1",
): Promise<{
  host: string;
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    host,
    port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await withTimeout(
        new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        ),
        SERVER_CLOSE_TIMEOUT_MS,
        "gateway remote terminal password test server close",
      );
    },
  };
}

async function connectWs(url: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() => {
          ws.terminate();
          reject(new Error("timeout"));
        }),
      WS_CONNECT_TIMEOUT_MS,
    );
    ws.once("open", () => finish(() => resolve(ws)));
    ws.once("unexpected-response", (_req, res) => {
      finish(() => reject(new Error(`unexpected response ${res.statusCode}`)));
    });
    ws.once("error", (err) => finish(() => reject(err)));
  });
}

async function withRemoteTerminalGatewayHarness(params: {
  resolvedAuth: ResolvedGatewayAuth;
  run: (ctx: { listener: Awaited<ReturnType<typeof listen>> }) => Promise<void>;
}) {
  const clients = new Set<GatewayWsClient>();
  const httpServer = createGatewayHttpServer({
    clients,
    controlUiEnabled: false,
    controlUiBasePath: "/__control__",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    handleHooksRequest: async () => false,
    resolvedAuth: params.resolvedAuth,
  });
  const wss = new WebSocketServer({ noServer: true });
  const rateLimiter = createAuthRateLimiter({ windowMs: 60_000, maxFailures: 10 });

  attachGatewayUpgradeHandler({
    httpServer,
    wss,
    clients,
    preauthConnectionBudget: createPreauthConnectionBudget(8),
    resolvedAuth: params.resolvedAuth,
    rateLimiter,
  });

  const listener = await listen(httpServer);
  try {
    await params.run({ listener });
  } finally {
    for (const ws of wss.clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await listener.close();
    rateLimiter.dispose();
  }
}

beforeEach(() => {
  ptyHandles.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("remote terminal SSH password login", () => {
  const tokenResolvedAuth: ResolvedGatewayAuth = {
    mode: "token",
    token: "test-token",
    password: undefined,
    allowTailscale: false,
  };

  test("omits private-key args and writes the password when SSH prompts", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
      run: async () => {
        await withRemoteTerminalGatewayHarness({
          resolvedAuth: tokenResolvedAuth,
          run: async ({ listener }) => {
            const ws = await connectWs(
              `ws://${listener.host}:${listener.port}/remote-terminal/ws?token=test-token`,
            );
            const messages: Array<{ type?: string; message?: string; pid?: number }> = [];
            ws.on("message", (raw) => {
              messages.push(
                JSON.parse(String(raw)) as { type?: string; message?: string; pid?: number },
              );
            });
            try {
              ws.send(
                JSON.stringify({
                  type: "start",
                  cols: 100,
                  rows: 24,
                  profile: {
                    host: "example.internal",
                    port: 2222,
                    username: "deploy",
                    privateKeyPath: "",
                    password: "secret-pass",
                  },
                }),
              );

              await vi.waitFor(() => expect(ptyHandles).toHaveLength(1));
              const handle = ptyHandles[0];
              await vi.waitFor(() =>
                expect(messages.map((message) => message.type)).toEqual([
                  "status",
                  "status",
                  "status",
                  "status",
                  "ready",
                ]),
              );
              expect(messages.map((message) => message.message)).toEqual([
                "Start request received.",
                "PTY backend loaded.",
                "Starting SSH process for deploy@example.internal.",
                "SSH process started (pid 1234).",
                undefined,
              ]);
              expect(messages.at(-1)).toMatchObject({
                type: "ready",
                pid: 1234,
                service: expect.objectContaining({
                  servicePort: 6006,
                  proxyUrl: expect.stringMatching(/^\/remote-terminal\/proxy\/[^/]+\/\?access=/),
                  tunnelId: expect.any(String),
                  localPort: expect.any(Number),
                }),
              });
              const argsArray = handle.args as string[];
              expect(argsArray.slice(0, 2)).toEqual(["-p", "2222"]);
              expect(argsArray[2]).toBe("-L");
              expect(argsArray[3]).toMatch(/^\d+:127\.0\.0\.1:6006$/);
              expect(argsArray.slice(4)).toEqual([
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "-o",
                "ExitOnForwardFailure=no",
                "-o",
                "PreferredAuthentications=password,keyboard-interactive,publickey",
                "--",
                "deploy@example.internal",
              ]);

              handle.dataEmitter.emit("data", "deploy@example.internal's password: ");
              await vi.waitFor(() => expect(handle.writes).toEqual(["secret-pass\r"]));

              handle.dataEmitter.emit("data", "Password: ");
              await new Promise((resolve) => setTimeout(resolve, 10));
              expect(handle.writes).toEqual(["secret-pass\r"]);
            } finally {
              ws.terminate();
            }
          },
        });
      },
    });
  });

  test("uses the requested local forward port when starting SSH", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
      run: async () => {
        await withRemoteTerminalGatewayHarness({
          resolvedAuth: tokenResolvedAuth,
          run: async ({ listener }) => {
            const ws = await connectWs(
              `ws://${listener.host}:${listener.port}/remote-terminal/ws?token=test-token`,
            );
            try {
              ws.send(
                JSON.stringify({
                  type: "start",
                  profile: {
                    host: "example.internal",
                    port: 22,
                    servicePort: 7860,
                    username: "deploy",
                  },
                }),
              );

              await vi.waitFor(() => expect(ptyHandles).toHaveLength(1));
              const argsArray = ptyHandles[0].args as string[];
              expect(argsArray).toContain("-L");
              const forwardArg = argsArray[argsArray.indexOf("-L") + 1];
              expect(forwardArg).toMatch(/^\d+:127\.0\.0\.1:7860$/);
            } finally {
              ws.terminate();
            }
          },
        });
      },
    });
  });
});
