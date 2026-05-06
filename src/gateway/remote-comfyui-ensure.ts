import { request as httpRequest } from "node:http";

export type ComfyUiEnsurePhase = "checking" | "starting" | "waiting" | "ready" | "failed";

export type EnsureComfyUiResult =
  | { ok: true; alreadyRunning: boolean; healthUrl: string }
  | { ok: false; phase: Exclude<ComfyUiEnsurePhase, "ready">; message: string };

export type EnsureComfyUiParams = {
  localPort: number;
  servicePort: number;
  writePty: (data: string) => void;
  onStatus?: (phase: ComfyUiEnsurePhase, message: string) => void;
  signal?: AbortSignal;
  healthPath?: string;
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  startupTimeoutMs?: number;
  commandStartDelayMs?: number;
  healthCheck?: (url: URL, signal?: AbortSignal) => Promise<boolean>;
};

const DEFAULT_HEALTH_PATH = "/system_stats";
const DEFAULT_HEALTH_TIMEOUT_MS = 2_500;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;
const DEFAULT_COMMAND_START_DELAY_MS = 2_500;
const DEFAULT_COMFYUI_CWD = "/root/autodl-tmp/ComfyUI";
const COMFYUI_SCREEN_NAME = "yyvideo-comfyui";
const COMFYUI_LOG_PATH = "/tmp/yyvideo-comfyui.log";

function normalizePort(value: number): number {
  if (!Number.isFinite(value)) {
    return 6006;
  }
  return Math.max(1, Math.min(65535, Math.trunc(value || 6006)));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `"'"'`)}'`;
}

function buildHealthUrl(localPort: number, healthPath = DEFAULT_HEALTH_PATH): URL {
  const path = healthPath.startsWith("/") ? healthPath : `/${healthPath}`;
  return new URL(`http://127.0.0.1:${normalizePort(localPort)}${path}`);
}

export function buildDetachedComfyUiStartCommand(servicePort: number): string {
  const port = normalizePort(servicePort);
  const inner = [
    `cd ${shellQuote(DEFAULT_COMFYUI_CWD)}`,
    "if [ -f /etc/network_turbo ]; then . /etc/network_turbo; fi",
    `exec python main.py --port ${port} --listen 0.0.0.0 --enable-cors-header ${shellQuote("*")}`,
  ].join(" && ");
  const quotedInner = shellQuote(inner);
  return [
    "if command -v screen >/dev/null 2>&1; then",
    `screen -dmS ${COMFYUI_SCREEN_NAME} bash -lc ${quotedInner};`,
    "else",
    `nohup bash -lc ${quotedInner} >${shellQuote(COMFYUI_LOG_PATH)} 2>&1 </dev/null &`,
    "fi",
  ].join(" ");
}

async function defaultHealthCheck(
  url: URL,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        signal,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function delay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) {
    return !signal?.aborted;
  }
  if (signal?.aborted) {
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      resolve(false);
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function ensureComfyUi(params: EnsureComfyUiParams): Promise<EnsureComfyUiResult> {
  const healthUrl = buildHealthUrl(params.localPort, params.healthPath).toString();
  const check =
    params.healthCheck ??
    ((url: URL, checkSignal?: AbortSignal) =>
      defaultHealthCheck(url, checkSignal, params.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS));
  const signal = params.signal;
  const status = (phase: ComfyUiEnsurePhase, message: string) => params.onStatus?.(phase, message);

  status("checking", "Checking ComfyUI health through the SSH tunnel.");
  if (await check(new URL(healthUrl), signal)) {
    status("ready", "ComfyUI is already reachable.");
    return { ok: true, alreadyRunning: true, healthUrl };
  }

  if (signal?.aborted) {
    return { ok: false, phase: "checking", message: "ComfyUI check was cancelled." };
  }

  status("starting", "ComfyUI is not reachable yet. Starting it in a detached remote session.");
  if (!(await delay(params.commandStartDelayMs ?? DEFAULT_COMMAND_START_DELAY_MS, signal))) {
    return { ok: false, phase: "starting", message: "ComfyUI start was cancelled." };
  }
  params.writePty(`${buildDetachedComfyUiStartCommand(params.servicePort)}\r`);

  const startupTimeoutMs = params.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + startupTimeoutMs;
  status("waiting", "Waiting for ComfyUI /system_stats to become healthy.");

  while (Date.now() <= deadline) {
    if (await check(new URL(healthUrl), signal)) {
      status("ready", "ComfyUI is reachable and ready for Pixelle.");
      return { ok: true, alreadyRunning: false, healthUrl };
    }
    if (signal?.aborted) {
      return { ok: false, phase: "waiting", message: "ComfyUI wait was cancelled." };
    }
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining <= 0) {
      break;
    }
    await delay(Math.min(pollIntervalMs, remaining), signal);
  }

  status(
    "failed",
    `ComfyUI did not become healthy within ${Math.round(startupTimeoutMs / 1000)}s.`,
  );
  return {
    ok: false,
    phase: "waiting",
    message: `ComfyUI did not become healthy within ${Math.round(startupTimeoutMs / 1000)}s.`,
  };
}
