import { randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { pipeline } from "node:stream";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { loadConfig } from "../config/config.js";
import { rawDataToString } from "../infra/ws.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { sendGatewayAuthFailure, sendJson as sendHttpJson } from "./http-common.js";
import { getBearerToken, resolveHttpBrowserOriginPolicy } from "./http-utils.js";
import { resolveRequestClientIp } from "./net.js";
import { ensureComfyUi, type ComfyUiEnsurePhase } from "./remote-comfyui-ensure.js";

type PtyExitEvent = { exitCode: number; signal?: number };
type PtyDisposable = { dispose: () => void };
type PtyHandle = {
  pid: number;
  write: (data: string | Buffer) => void;
  onData: (listener: (value: string) => void) => PtyDisposable | void;
  onExit: (listener: (event: PtyExitEvent) => void) => PtyDisposable | void;
  kill?: (signal?: string) => void;
  resize?: (cols: number, rows: number) => void;
};
type PtySpawn = (
  file: string,
  args: string[] | string,
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  },
) => PtyHandle;
type PtyModule = {
  spawn?: PtySpawn;
  default?: {
    spawn?: PtySpawn;
  };
};

type RemoteTerminalStartMessage = {
  type: "start";
  profile: {
    host?: string;
    port?: number;
    servicePort?: number;
    forwardPort?: number;
    username?: string;
    privateKeyPath?: string;
    password?: string;
    sshConfigHost?: string;
  };
  cols?: number;
  rows?: number;
};

type RemoteTerminalInputMessage = {
  type: "input";
  data: string;
};

type RemoteTerminalResizeMessage = {
  type: "resize";
  cols: number;
  rows: number;
};

type RemoteTerminalEnsureComfyUiMessage = {
  type: "ensure-comfyui";
};

type RemoteTerminalClientMessage =
  | RemoteTerminalStartMessage
  | RemoteTerminalInputMessage
  | RemoteTerminalResizeMessage
  | RemoteTerminalEnsureComfyUiMessage;

const REMOTE_TERMINAL_WS_PATH = "/remote-terminal/ws";
const REMOTE_SERVICE_PROXY_PREFIX = "/remote-terminal/proxy";
const MAX_FRAME_BYTES = 32 * 1024;
const MAX_TEXT_FIELD_LENGTH = 2048;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type RemoteServiceTunnel = {
  id: string;
  localPort: number;
  servicePort: number;
  target: string;
  createdAt: number;
  accessToken: string;
};

type RemoteTerminalServiceInfo = {
  proxyUrl: string;
  servicePort: number;
  localPort: number;
  localBindUrl: string;
  tunnelId: string;
};

const remoteServiceTunnels = new Map<string, RemoteServiceTunnel>();

let ptyModulePromise: Promise<PtyModule> | null = null;

async function loadPtyModule(): Promise<PtyModule> {
  ptyModulePromise ??= import("@lydell/node-pty") as Promise<unknown> as Promise<PtyModule>;
  return ptyModulePromise;
}

async function allocateLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      const port = address?.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error("Failed to allocate local proxy port."));
          return;
        }
        resolve(port);
      });
    });
  });
}

// C-1 scheme: always bind the SSH tunnel to 127.0.0.1:6006 so that the
// embedded Pixelle backend (and any other tool the user points at ComfyUI)
// can reach it at a stable, well-known URL. If 6006 is already in use (for
// example a previous run left a zombie process), fall back to an ephemeral
// port rather than failing the whole connection.
const PIXELLE_COMFYUI_PREFERRED_BIND_PORT = 6006;

async function tryListenOnPort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createNetServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function allocatePixelleBindPort(): Promise<number> {
  const preferred = PIXELLE_COMFYUI_PREFERRED_BIND_PORT;
  if (await tryListenOnPort(preferred)) {
    return preferred;
  }
  return allocateLoopbackPort();
}

function sendJson(ws: WebSocket, value: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(value));
  }
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePort(value: unknown): number {
  const port = Number(value);
  if (!Number.isFinite(port)) {
    return 22;
  }
  return Math.max(1, Math.min(65535, Math.trunc(port)));
}

function normalizeServicePort(profile: RemoteTerminalStartMessage["profile"]): number {
  const raw = profile.servicePort ?? profile.forwardPort ?? 6006;
  const port = Number(raw);
  if (!Number.isFinite(port)) {
    return 6006;
  }
  return Math.max(1, Math.min(65535, Math.trunc(port || 6006)));
}

function normalizePtySize(value: unknown, fallback: number, max: number): number {
  const size = Number(value);
  if (!Number.isFinite(size)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.trunc(size)));
}

function isSafeValue(value: string): boolean {
  return value.length <= MAX_TEXT_FIELD_LENGTH && !/[\0\r\n]/.test(value);
}

function isSafeSshConfigAlias(value: string): boolean {
  return (
    Boolean(value) &&
    isSafeValue(value) &&
    !value.startsWith("-") &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function isSafeHost(value: string): boolean {
  return Boolean(value) && isSafeValue(value) && !value.startsWith("-");
}

function looksLikePasswordPrompt(value: string): boolean {
  return /(?:^|[\r\n])[^\r\n]*(?:password|passcode)[^\r\n]*:\s*$/i.test(value);
}

/**
 * Matches the noisy stderr lines that OpenSSH emits every time a local
 * port-forward (-L) client tries to reach the upstream service while
 * the remote side is not yet listening. Examples we deduplicate:
 *   - `channel 3: open failed: connect failed: Connection refused`
 *   - `channel 12: open failed: administratively prohibited: ...`
 * These lines come in bursts (one per failed HTTP request from the
 * embedded Pixelle backend) and otherwise flood the live terminal so
 * badly that the user cannot tell SSH itself is healthy.
 */
const SSH_CHANNEL_FORWARD_ERROR_REGEX = /channel\s+\d+:\s*open failed:\s*[^\r\n]*/gi;

type ChannelErrorFilterState = {
  suppressedCount: number;
  lastFlushAt: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  firstSuppressedMessage: string | null;
};

function createChannelErrorFilterState(): ChannelErrorFilterState {
  return {
    suppressedCount: 0,
    lastFlushAt: 0,
    flushTimer: null,
    firstSuppressedMessage: null,
  };
}

/**
 * Strip SSH local-forward channel open errors out of `chunk` and record
 * them on `state` for a throttled summary. Returns the cleaned string
 * (may be empty) that is safe to forward to the client terminal.
 */
function filterSshChannelForwardErrors(
  chunk: string,
  state: ChannelErrorFilterState,
): { cleaned: string; suppressed: number; firstMessage: string | null } {
  let suppressed = 0;
  let firstMessage: string | null = null;
  const cleaned = chunk.replace(SSH_CHANNEL_FORWARD_ERROR_REGEX, (match) => {
    suppressed += 1;
    if (!firstMessage) {
      firstMessage = match.trim();
    }
    return "";
  });
  if (suppressed > 0) {
    state.suppressedCount += suppressed;
    if (!state.firstSuppressedMessage && firstMessage) {
      state.firstSuppressedMessage = firstMessage;
    }
  }
  // Collapse the blank lines left behind by removed error text so the
  // terminal does not fill with empty rows.
  const collapsed = cleaned.replace(/(?:\r?\n){3,}/g, "\n\n");
  return { cleaned: collapsed, suppressed, firstMessage };
}

function buildSshArgs(
  profile: RemoteTerminalStartMessage["profile"],
  tunnel: Pick<RemoteServiceTunnel, "localPort" | "servicePort">,
): string[] {
  const sshConfigHost = normalizeString(profile.sshConfigHost);
  const host = normalizeString(profile.host);
  const username = normalizeString(profile.username);
  const privateKeyPath = normalizeString(profile.privateKeyPath);
  const password = typeof profile.password === "string" ? profile.password : "";
  const port = normalizePort(profile.port);
  const forwardArgs = ["-L", `${tunnel.localPort}:127.0.0.1:${tunnel.servicePort}`];

  if (password && !isSafeValue(password)) {
    throw new Error("Invalid SSH password.");
  }

  if (sshConfigHost) {
    if (!isSafeSshConfigAlias(sshConfigHost)) {
      throw new Error("Invalid SSH config alias.");
    }
    return [...forwardArgs, sshConfigHost];
  }

  if (!isSafeHost(host)) {
    throw new Error("Host/IP is required.");
  }
  if (username && !isSafeValue(username)) {
    throw new Error("Invalid SSH username.");
  }
  if (privateKeyPath && !isSafeValue(privateKeyPath)) {
    throw new Error("Invalid private key path.");
  }

  const args = [
    "-p",
    String(port),
    ...forwardArgs,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    // Do NOT kill the SSH session when the local -L forward cannot
    // reach the remote service (e.g. ComfyUI on :6006 is not running
    // yet). We surface that as a friendly notice instead of tearing
    // the whole terminal down.
    "-o",
    "ExitOnForwardFailure=no",
  ];
  if (privateKeyPath) {
    args.push("-o", "IdentitiesOnly=yes", "-i", privateKeyPath);
  } else if (password) {
    args.push("-o", "PreferredAuthentications=password,keyboard-interactive,publickey");
  }
  const target = username ? `${username}@${host}` : host;
  args.push("--", target);
  return args;
}

function parseClientMessage(raw: RawData): RemoteTerminalClientMessage | null {
  const text = rawDataToString(raw);
  if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as { type?: unknown };
    if (parsed.type === "start") {
      return parsed as RemoteTerminalStartMessage;
    }
    if (parsed.type === "input") {
      return typeof (parsed as RemoteTerminalInputMessage).data === "string"
        ? (parsed as RemoteTerminalInputMessage)
        : null;
    }
    if (parsed.type === "resize") {
      return parsed as RemoteTerminalResizeMessage;
    }
    if (parsed.type === "ensure-comfyui") {
      return parsed as RemoteTerminalEnsureComfyUiMessage;
    }
  } catch {
    return null;
  }
  return null;
}

function closeSocket(socket: Duplex) {
  try {
    socket.destroy();
  } catch {
    // ignore close failures
  }
}

function matchesRemoteTerminalPath(pathname: string, controlUiBasePath: string): boolean {
  if (pathname === REMOTE_TERMINAL_WS_PATH) {
    return true;
  }
  const normalizedBase = controlUiBasePath.trim().replace(/\/+$/, "");
  if (!normalizedBase || normalizedBase === "/") {
    return false;
  }
  return pathname === `${normalizedBase}${REMOTE_TERMINAL_WS_PATH}`;
}

function resolveScopedRemoteServiceProxyPath(pathname: string, controlUiBasePath: string) {
  if (
    pathname === REMOTE_SERVICE_PROXY_PREFIX ||
    pathname.startsWith(`${REMOTE_SERVICE_PROXY_PREFIX}/`)
  ) {
    return pathname.slice(REMOTE_SERVICE_PROXY_PREFIX.length) || "/";
  }
  const normalizedBase = controlUiBasePath.trim().replace(/\/+$/, "");
  if (!normalizedBase || normalizedBase === "/") {
    return null;
  }
  const scopedPrefix = `${normalizedBase}${REMOTE_SERVICE_PROXY_PREFIX}`;
  if (pathname === scopedPrefix || pathname.startsWith(`${scopedPrefix}/`)) {
    return pathname.slice(scopedPrefix.length) || "/";
  }
  return null;
}

function buildRemoteServiceProxyUrl(params: {
  basePath: string;
  tunnelId: string;
  accessToken?: string;
}) {
  const normalizedBase = params.basePath.trim().replace(/\/+$/, "");
  const prefix = !normalizedBase || normalizedBase === "/" ? "" : normalizedBase;
  const base = `${prefix}${REMOTE_SERVICE_PROXY_PREFIX}/${encodeURIComponent(params.tunnelId)}/`;
  if (!params.accessToken) {
    return base;
  }
  const query = new URLSearchParams({ access: params.accessToken }).toString();
  return `${base}?${query}`;
}

function copyProxyResponseHeaders(upstream: IncomingMessage, res: ServerResponse) {
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value === undefined) {
      continue;
    }
    res.setHeader(name, value);
  }
}

function buildProxyRequestHeaders(req: IncomingMessage) {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName) || value === undefined) {
      continue;
    }
    if (lowerName === "host" || lowerName === "authorization" || lowerName === "x-openclaw-token") {
      continue;
    }
    headers[name] = value;
  }
  return headers;
}

function buildProxySearch(url: URL): string {
  const params = new URLSearchParams(url.searchParams);
  params.delete("token");
  params.delete("access");
  const value = params.toString();
  return value ? `?${value}` : "";
}

function proxyRemoteServiceRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  tunnel: RemoteServiceTunnel;
  upstreamPath: string;
  search: string;
}) {
  const upstreamPath = `${params.upstreamPath || "/"}${params.search}`;
  const proxyReq = httpRequest(
    {
      host: "127.0.0.1",
      port: params.tunnel.localPort,
      method: params.req.method,
      path: upstreamPath,
      headers: buildProxyRequestHeaders(params.req),
    },
    (upstream) => {
      params.res.statusCode = upstream.statusCode ?? 502;
      params.res.statusMessage = upstream.statusMessage ?? "";
      copyProxyResponseHeaders(upstream, params.res);
      pipeline(upstream, params.res, () => {});
    },
  );
  proxyReq.on("error", () => {
    if (!params.res.headersSent) {
      sendHttpJson(params.res, 502, {
        ok: false,
        error: {
          type: "remote_service_unavailable",
          message: "Remote service tunnel is not reachable yet.",
        },
      });
    } else {
      params.res.destroy();
    }
  });
  pipeline(params.req, proxyReq, () => {});
}

export async function handleRemoteServiceProxyHttpRequest(opts: {
  req: IncomingMessage;
  res: ServerResponse;
  controlUiBasePath?: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
}): Promise<boolean> {
  const url = new URL(opts.req.url ?? "/", "http://localhost");
  const scopedPath = resolveScopedRemoteServiceProxyPath(
    url.pathname,
    opts.controlUiBasePath ?? "",
  );
  if (scopedPath === null) {
    return false;
  }

  const parts = scopedPath.split("/").filter(Boolean);
  const tunnelId = parts.shift() ?? "";
  const tunnel = tunnelId ? remoteServiceTunnels.get(tunnelId) : undefined;
  if (!tunnel) {
    sendHttpJson(opts.res, 404, {
      ok: false,
      error: {
        type: "remote_service_not_connected",
        message: "Connect to the remote server before using its service proxy.",
      },
    });
    return true;
  }

  const providedAccess = url.searchParams.get("access")?.trim() ?? "";
  const tunnelAccessOk = Boolean(tunnel.accessToken) && providedAccess === tunnel.accessToken;
  if (!tunnelAccessOk) {
    const bearer = getBearerToken(opts.req);
    const authResult = await authorizeHttpGatewayConnect({
      auth: opts.resolvedAuth,
      connectAuth: bearer ? { token: bearer, password: bearer } : null,
      req: opts.req,
      trustedProxies: opts.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
      browserOriginPolicy: resolveHttpBrowserOriginPolicy(opts.req),
    });
    if (!authResult.ok) {
      sendGatewayAuthFailure(opts.res, authResult);
      return true;
    }
  }

  const upstreamPath = `/${parts.map((part) => encodeURIComponent(decodeURIComponent(part))).join("/")}`;
  proxyRemoteServiceRequest({
    req: opts.req,
    res: opts.res,
    tunnel,
    upstreamPath,
    search: url.search,
  });
  return true;
}

export function handleRemoteTerminalUpgrade(opts: {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  controlUiBasePath?: string;
  resolvedAuth: ResolvedGatewayAuth;
  getResolvedAuth?: () => ResolvedGatewayAuth;
  rateLimiter?: AuthRateLimiter;
  log?: { warn: (msg: string) => void };
}): boolean {
  const url = new URL(opts.req.url ?? "/", "http://localhost");
  if (!matchesRemoteTerminalPath(url.pathname, opts.controlUiBasePath ?? "")) {
    return false;
  }

  void (async () => {
    const configSnapshot = loadConfig();
    const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
    const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
    const token = getBearerToken(opts.req) ?? url.searchParams.get("token")?.trim() ?? "";
    const resolvedAuth = opts.getResolvedAuth?.() ?? opts.resolvedAuth;
    const authResult = await authorizeHttpGatewayConnect({
      auth: resolvedAuth,
      connectAuth: token ? { token, password: token } : null,
      req: opts.req,
      trustedProxies,
      allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
      browserOriginPolicy: resolveHttpBrowserOriginPolicy(opts.req, configSnapshot),
      clientIp: resolveRequestClientIp(opts.req, trustedProxies, allowRealIpFallback),
    });

    if (!authResult.ok) {
      opts.socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      closeSocket(opts.socket);
      return;
    }

    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    wss.handleUpgrade(opts.req, opts.socket, opts.head, (ws) => {
      wss.emit("connection", ws, opts.req);
      let pty: PtyHandle | null = null;
      let dataDisposable: PtyDisposable | null = null;
      let exitDisposable: PtyDisposable | null = null;
      let activeTunnelId: string | null = null;
      let activeServiceInfo: RemoteTerminalServiceInfo | null = null;
      let ensureAbort: AbortController | null = null;
      let ensureInFlight: Promise<void> | null = null;
      let started = false;
      const channelErrorFilter = createChannelErrorFilterState();
      const CHANNEL_ERROR_FLUSH_MS = 2_000;

      const flushSuppressedChannelErrors = (reason: "timer" | "final") => {
        if (channelErrorFilter.flushTimer) {
          clearTimeout(channelErrorFilter.flushTimer);
          channelErrorFilter.flushTimer = null;
        }
        const count = channelErrorFilter.suppressedCount;
        if (count <= 0) {
          return;
        }
        const firstMessage = channelErrorFilter.firstSuppressedMessage ?? "";
        channelErrorFilter.suppressedCount = 0;
        channelErrorFilter.firstSuppressedMessage = null;
        channelErrorFilter.lastFlushAt = Date.now();
        const summary =
          count === 1
            ? `[remote service not listening] ${firstMessage}`
            : `[remote service not listening] ${firstMessage} (repeated ${count} times)`;
        sendJson(ws, { type: "status", message: summary });
        if (reason === "timer") {
          sendJson(ws, {
            type: "data",
            data: `\r\n\u001b[33m[remote service not ready on port ${
              activeTunnelId ? (remoteServiceTunnels.get(activeTunnelId)?.servicePort ?? "") : ""
            } \u2014 SSH kept alive; start it on the remote host]\u001b[0m\r\n`,
          });
        }
      };

      const runEnsureComfyUi = (activePty: PtyHandle, tunnel: RemoteServiceTunnel) => {
        if (!activeServiceInfo) {
          sendJson(ws, {
            type: "comfyui-error",
            phase: "checking",
            message: "Remote service tunnel is not ready yet.",
          });
          return;
        }
        if (ensureInFlight) {
          sendJson(ws, {
            type: "comfyui-status",
            phase: "waiting",
            message: "ComfyUI activation is already running.",
          });
          return;
        }
        const service = activeServiceInfo;
        const controller = new AbortController();
        ensureAbort = controller;
        ensureInFlight = (async () => {
          const result = await ensureComfyUi({
            localPort: tunnel.localPort,
            servicePort: tunnel.servicePort,
            writePty: (data) => activePty.write(data),
            signal: controller.signal,
            onStatus: (phase: ComfyUiEnsurePhase, message: string) => {
              sendJson(ws, { type: "comfyui-status", phase, message });
            },
          });
          if (controller.signal.aborted) {
            return;
          }
          if (result.ok) {
            sendJson(ws, {
              type: "comfyui-ready",
              service,
              healthUrl: result.healthUrl,
              alreadyRunning: result.alreadyRunning,
            });
          } else {
            sendJson(ws, {
              type: "comfyui-error",
              phase: result.phase,
              message: result.message,
            });
          }
        })()
          .catch((error) => {
            if (!controller.signal.aborted) {
              sendJson(ws, {
                type: "comfyui-error",
                phase: "failed",
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })
          .finally(() => {
            if (ensureAbort === controller) {
              ensureAbort = null;
              ensureInFlight = null;
            }
          });
      };

      const cleanup = () => {
        try {
          ensureAbort?.abort();
        } catch {
          // ignore abort failures
        }
        ensureAbort = null;
        ensureInFlight = null;
        activeServiceInfo = null;
        try {
          dataDisposable?.dispose();
        } catch {
          // ignore cleanup failures
        }
        try {
          exitDisposable?.dispose();
        } catch {
          // ignore cleanup failures
        }
        try {
          pty?.kill?.("SIGTERM");
        } catch {
          // ignore kill failures
        }
        if (channelErrorFilter.flushTimer) {
          clearTimeout(channelErrorFilter.flushTimer);
          channelErrorFilter.flushTimer = null;
        }
        if (activeTunnelId) {
          remoteServiceTunnels.delete(activeTunnelId);
          activeTunnelId = null;
        }
        activeServiceInfo = null;
        dataDisposable = null;
        exitDisposable = null;
        pty = null;
      };

      ws.on("message", (raw) => {
        void (async () => {
          const message = parseClientMessage(raw);
          if (!message) {
            sendJson(ws, { type: "error", message: "Invalid terminal message." });
            return;
          }

          if (message.type === "start") {
            if (started) {
              return;
            }
            started = true;
            try {
              sendJson(ws, { type: "status", message: "Start request received." });
              const module = await loadPtyModule();
              const spawn = module.spawn ?? module.default?.spawn;
              if (!spawn) {
                throw new Error("PTY support is unavailable.");
              }
              sendJson(ws, { type: "status", message: "PTY backend loaded." });
              const tunnel: RemoteServiceTunnel = {
                id: randomUUID(),
                localPort: await allocatePixelleBindPort(),
                servicePort: normalizeServicePort(message.profile ?? {}),
                target: "SSH target",
                createdAt: Date.now(),
                accessToken: randomUUID().replaceAll("-", ""),
              };
              const args = buildSshArgs(message.profile ?? {}, tunnel);
              const password =
                typeof message.profile?.password === "string" ? message.profile.password : "";
              tunnel.target = args.at(-1) ?? "SSH target";
              sendJson(ws, {
                type: "status",
                message: `Starting SSH process for ${tunnel.target}.`,
              });
              let passwordWritten = false;
              const activePty = spawn("ssh", args, {
                name: "xterm-256color",
                cols: normalizePtySize(message.cols, 120, 300),
                rows: normalizePtySize(message.rows, 30, 120),
                env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
              });
              remoteServiceTunnels.set(tunnel.id, tunnel);
              activeTunnelId = tunnel.id;
              pty = activePty;
              dataDisposable =
                activePty.onData((chunk) => {
                  sendJson(ws, { type: "data", data: chunk });
                  if (password && !passwordWritten && looksLikePasswordPrompt(chunk)) {
                    passwordWritten = true;
                    activePty.write(`${password}\r`);
                  }
                }) ?? null;
              exitDisposable =
                activePty.onExit((event) => {
                  sendJson(ws, {
                    type: "exit",
                    code: event.exitCode ?? null,
                    signal: event.signal ?? null,
                  });
                  ws.close();
                }) ?? null;
              sendJson(ws, {
                type: "status",
                message: `SSH process started (pid ${activePty.pid}).`,
              });
              const proxyUrl = buildRemoteServiceProxyUrl({
                basePath: opts.controlUiBasePath ?? "",
                tunnelId: tunnel.id,
                accessToken: tunnel.accessToken,
              });
              activeServiceInfo = {
                proxyUrl,
                servicePort: tunnel.servicePort,
                localPort: tunnel.localPort,
                localBindUrl: `http://127.0.0.1:${tunnel.localPort}`,
                tunnelId: tunnel.id,
              };
              sendJson(ws, {
                type: "ready",
                pid: activePty.pid,
                service: activeServiceInfo,
              });
            } catch (error) {
              sendJson(ws, {
                type: "error",
                message: error instanceof Error ? error.message : String(error),
              });
              ws.close();
            }
            return;
          }

          if (!pty) {
            return;
          }
          if (message.type === "ensure-comfyui") {
            const tunnel = activeTunnelId ? remoteServiceTunnels.get(activeTunnelId) : null;
            if (!tunnel) {
              sendJson(ws, {
                type: "comfyui-error",
                phase: "checking",
                message: "Remote service tunnel is not ready yet.",
              });
              return;
            }
            runEnsureComfyUi(pty, tunnel);
            return;
          }
          if (message.type === "input") {
            pty.write(message.data);
            return;
          }
          if (message.type === "resize") {
            pty.resize?.(
              normalizePtySize(message.cols, 120, 300),
              normalizePtySize(message.rows, 30, 120),
            );
          }
        })().catch((error) => {
          opts.log?.warn(`remote terminal ws message failed: ${String(error)}`);
          sendJson(ws, { type: "error", message: "Remote terminal failed." });
          ws.close();
        });
      });

      ws.on("close", () => {
        cleanup();
        wss.close();
      });
      ws.on("error", cleanup);
    });
  })().catch((error) => {
    opts.log?.warn(`remote terminal ws upgrade failed: ${String(error)}`);
    closeSocket(opts.socket);
  });

  return true;
}
