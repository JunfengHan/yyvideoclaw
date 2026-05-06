import type { Socket } from "node:net";
import { describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import { createPreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { withTempConfig } from "./test-temp-config.js";

const WS_REJECT_TIMEOUT_MS = 2_000;
const WS_CONNECT_TIMEOUT_MS = 5_000;
const SERVER_CLOSE_TIMEOUT_MS = 5_000;

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
        "gateway remote terminal test server close",
      );
    },
  };
}

async function expectWsRejected(url: string, expectedStatus = 401): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("timeout")), WS_REJECT_TIMEOUT_MS);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error("expected ws to reject"));
    });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      expect(res.statusCode).toBe(expectedStatus);
      resolve();
    });
    ws.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function expectWsConnected(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
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
    ws.once("open", () => {
      finish(() => {
        ws.terminate();
        resolve();
      });
    });
    ws.once("unexpected-response", (_req, res) => {
      finish(() => reject(new Error(`unexpected response ${res.statusCode}`)));
    });
    ws.once("close", (code, reason) => {
      finish(() =>
        reject(
          new Error(
            `socket closed before open (${code}${reason.length > 0 ? `: ${reason.toString()}` : ""})`,
          ),
        ),
      );
    });
    ws.once("error", (err) => {
      finish(() => reject(err));
    });
  });
}

async function withRemoteTerminalGatewayHarness(params: {
  resolvedAuth: ResolvedGatewayAuth;
  controlUiBasePath?: string;
  run: (ctx: { listener: Awaited<ReturnType<typeof listen>> }) => Promise<void>;
}) {
  const clients = new Set<GatewayWsClient>();
  const httpServer = createGatewayHttpServer({
    clients,
    controlUiEnabled: false,
    controlUiBasePath: params.controlUiBasePath ?? "/__control__",
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
    controlUiBasePath: params.controlUiBasePath,
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

describe("remote terminal WebSocket upgrade", () => {
  const tokenResolvedAuth: ResolvedGatewayAuth = {
    mode: "token",
    token: "test-token",
    password: undefined,
    allowTailscale: false,
  };

  test("rejects missing credentials before upgrading", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
      run: async () => {
        await withRemoteTerminalGatewayHarness({
          resolvedAuth: tokenResolvedAuth,
          run: async ({ listener }) => {
            await expectWsRejected(`ws://${listener.host}:${listener.port}/remote-terminal/ws`);
          },
        });
      },
    });
  });

  test("accepts token credentials on the remote terminal route", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
      run: async () => {
        await withRemoteTerminalGatewayHarness({
          resolvedAuth: tokenResolvedAuth,
          run: async ({ listener }) => {
            await expectWsConnected(
              `ws://${listener.host}:${listener.port}/remote-terminal/ws?token=test-token`,
            );
          },
        });
      },
    });
  });

  test("accepts the same route under the Control UI base path", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
      run: async () => {
        await withRemoteTerminalGatewayHarness({
          resolvedAuth: tokenResolvedAuth,
          controlUiBasePath: "/ui",
          run: async ({ listener }) => {
            await expectWsConnected(
              `ws://${listener.host}:${listener.port}/ui/remote-terminal/ws?token=test-token`,
            );
          },
        });
      },
    });
  });
});
