import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { resolveControlUiAuthToken } from "../control-ui-auth.ts";
import { icons } from "../icons.ts";
import { normalizeBasePath } from "../navigation.ts";
import type { UiSettings } from "../storage.ts";

const STORAGE_KEY = "yyvideoclaw.remoteTerminal.sshProfiles.v1";
const MAX_TERMINAL_OUTPUT_LENGTH = 40_000;
const REMOTE_TERMINAL_CONNECT_TIMEOUT_MS = 30_000;

export type SshProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  forwardPort: number;
  username: string;
  privateKeyPath: string;
  password: string;
  sshConfigHost: string;
  description: string;
  lastConnectedAt?: number;
};

type Draft = Omit<SshProfile, "id" | "lastConnectedAt">;
type TerminalStatus = "idle" | "connecting" | "connected" | "closed" | "error";
export type ComfyUiPhase =
  | "idle"
  | "checking"
  | "starting"
  | "waiting"
  | "ready"
  | "applying"
  | "active"
  | "failed";

type RemoteTerminalRuntimeState = typeof globalThis & {
  __yyRemoteTerminalDraft?: Draft;
  __yyRemoteTerminalSelectedId?: string | null;
  __yyRemoteTerminalDeleteConfirmId?: string | null;
  __yyRemoteTerminalMessage?: string | null;
  __yyRemoteTerminalOutput?: string;
  __yyRemoteTerminalInput?: string;
  __yyRemoteTerminalStatus?: TerminalStatus;
  __yyRemoteTerminalSocket?: WebSocket | null;
  __yyRemoteTerminalConnectTimer?: ReturnType<typeof setTimeout> | null;
  __yyRemoteTerminalProfileDialogOpen?: boolean;
  __yyRemoteTerminalServiceUrl?: string | null;
  __yyRemoteTerminalServicePort?: number | null;
  __yyRemoteTerminalLocalBindUrl?: string | null;
  __yyRemoteTerminalComfyUiApplying?: boolean;
  __yyRemoteTerminalComfyUiPhase?: ComfyUiPhase;
  __yyRemoteTerminalComfyUiMessage?: string | null;
  __yyRemoteTerminalActiveProfileId?: string | null;
  __yyRemoteTerminalEnsureScheduled?: boolean;
  __yyRemoteTerminalEnsureRetried?: boolean;
  __yyRemoteTerminalEnsureFirstDataAt?: number | null;
};

export type RemoteTerminalViewProps = {
  basePath: string;
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  settings?: Pick<UiSettings, "token"> | null;
  password?: string | null;
  requestUpdate?: () => void;
};

const DEFAULT_DRAFT: Draft = {
  name: "",
  host: "",
  port: 22,
  forwardPort: 6006,
  username: "root",
  privateKeyPath: "",
  password: "",
  sshConfigHost: "",
  description: "",
};

function cloneDefaultDraft(): Draft {
  return { ...DEFAULT_DRAFT };
}

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `ssh-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeProfile(value: unknown): SshProfile | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const profile = value as Partial<SshProfile>;
  const id = typeof profile.id === "string" ? profile.id.trim() : "";
  const name = typeof profile.name === "string" ? profile.name.trim() : "";
  const host = typeof profile.host === "string" ? profile.host.trim() : "";
  const username = typeof profile.username === "string" ? profile.username.trim() : "";
  const privateKeyPath =
    typeof profile.privateKeyPath === "string" ? profile.privateKeyPath.trim() : "";
  const password = typeof profile.password === "string" ? profile.password : "";
  const sshConfigHost =
    typeof profile.sshConfigHost === "string" ? profile.sshConfigHost.trim() : "";
  const description = typeof profile.description === "string" ? profile.description.trim() : "";
  const port = Number.isFinite(profile.port) ? Number(profile.port) : 22;
  const forwardPort = Number.isFinite(profile.forwardPort) ? Number(profile.forwardPort) : 6006;
  const lastConnectedAt = Number.isFinite(profile.lastConnectedAt)
    ? Number(profile.lastConnectedAt)
    : undefined;

  if (!id || !name || (!host && !sshConfigHost)) {
    return null;
  }

  return {
    id,
    name,
    host,
    port: Math.max(1, Math.min(65535, Math.trunc(port || 22))),
    forwardPort: Math.max(1, Math.min(65535, Math.trunc(forwardPort || 6006))),
    username,
    privateKeyPath,
    password,
    sshConfigHost,
    description,
    lastConnectedAt,
  };
}

export function loadSshProfiles(): SshProfile[] {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return [];
  }
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map(normalizeProfile)
      .filter((profile): profile is SshProfile => Boolean(profile));
  } catch {
    return [];
  }
}

function saveSshProfiles(profiles: SshProfile[]) {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  } catch {
    // Storage may be unavailable in private browsing or locked-down contexts.
  }
}

function relativeTime(ts?: number) {
  if (!ts) {
    return t("remoteTerminal.profile.neverConnected");
  }
  const seconds = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) {
    return t("common.secondsAgo", { count: String(seconds) });
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function buildRemoteTerminalWsUrl(props: RemoteTerminalViewProps): string {
  const basePath = normalizeBasePath(props.basePath ?? "");
  const protocol = globalThis.location?.protocol === "https:" ? "wss:" : "ws:";
  const host = globalThis.location?.host ?? "localhost";
  const token = resolveControlUiAuthToken({
    hello: props.hello,
    settings: props.settings,
    password: props.password,
  });
  const url = new URL(`${protocol}//${host}${basePath}/remote-terminal/ws`);
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

function appendTerminalOutput(win: RemoteTerminalRuntimeState, text: string) {
  win.__yyRemoteTerminalOutput = `${win.__yyRemoteTerminalOutput ?? ""}${text}`.slice(
    -MAX_TERMINAL_OUTPUT_LENGTH,
  );
}

function appendTerminalLog(win: RemoteTerminalRuntimeState, text: string) {
  const timestamp = new Date().toLocaleTimeString();
  appendTerminalOutput(win, `[${timestamp}] ${text}\n`);
}

function setComfyUiPhase(
  win: RemoteTerminalRuntimeState,
  phase: ComfyUiPhase,
  message: string | null = null,
) {
  win.__yyRemoteTerminalComfyUiPhase = phase;
  win.__yyRemoteTerminalComfyUiMessage = message;
}

function sendEnsureComfyUi(
  win: RemoteTerminalRuntimeState,
  ws: WebSocket,
  props: RemoteTerminalViewProps,
): boolean {
  if (ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  if (!win.__yyRemoteTerminalLocalBindUrl) {
    return false;
  }
  try {
    ws.send(JSON.stringify({ type: "ensure-comfyui" }));
    setComfyUiPhase(win, "checking", t("remoteTerminal.terminal.comfyUiCheckingLine"));
    appendTerminalLog(win, t("remoteTerminal.terminal.comfyUiCheckingLine"));
    props.requestUpdate?.();
    return true;
  } catch {
    setComfyUiPhase(
      win,
      "failed",
      t("remoteTerminal.terminal.comfyUiEnsureFailedLine", { error: "send failed" }),
    );
    props.requestUpdate?.();
    return false;
  }
}

function terminalStatusLabel(status: TerminalStatus) {
  switch (status) {
    case "connecting":
      return t("remoteTerminal.terminal.connecting");
    case "connected":
      return t("remoteTerminal.terminal.connected");
    case "closed":
      return t("remoteTerminal.terminal.closed");
    case "error":
      return t("remoteTerminal.terminal.error");
    default:
      return t("remoteTerminal.terminal.idle");
  }
}

function comfyUiPhaseLabel(phase: ComfyUiPhase) {
  switch (phase) {
    case "checking":
      return t("remoteTerminal.terminal.comfyUiPhaseChecking");
    case "starting":
      return t("remoteTerminal.terminal.comfyUiPhaseStarting");
    case "waiting":
      return t("remoteTerminal.terminal.comfyUiPhaseWaiting");
    case "ready":
      return t("remoteTerminal.terminal.comfyUiPhaseReady");
    case "applying":
      return t("remoteTerminal.terminal.comfyUiPhaseApplying");
    case "active":
      return t("remoteTerminal.terminal.comfyUiPhaseActive");
    case "failed":
      return t("remoteTerminal.terminal.comfyUiPhaseFailed");
    default:
      return t("remoteTerminal.terminal.comfyUiPhaseIdle");
  }
}

function closeRemoteTerminal(win: RemoteTerminalRuntimeState, props: RemoteTerminalViewProps) {
  if (win.__yyRemoteTerminalConnectTimer) {
    clearTimeout(win.__yyRemoteTerminalConnectTimer);
    win.__yyRemoteTerminalConnectTimer = null;
  }
  try {
    win.__yyRemoteTerminalSocket?.close();
  } catch {
    // Ignore stale socket close failures.
  }
  win.__yyRemoteTerminalSocket = null;
  win.__yyRemoteTerminalStatus = "closed";
  win.__yyRemoteTerminalServiceUrl = null;
  win.__yyRemoteTerminalServicePort = null;
  win.__yyRemoteTerminalLocalBindUrl = null;
  setComfyUiPhase(win, "idle");
  win.__yyRemoteTerminalActiveProfileId = null;
  win.__yyRemoteTerminalEnsureScheduled = false;
  win.__yyRemoteTerminalEnsureRetried = false;
  win.__yyRemoteTerminalEnsureFirstDataAt = null;
  appendTerminalLog(win, t("remoteTerminal.terminal.disconnectedLine"));
  props.requestUpdate?.();
}

/**
 * C-1 ComfyUI wiring: write `http://127.0.0.1:<bind>` into the embedded
 * Pixelle-Video `config.yaml` via the gateway's config endpoint, then
 * kick Pixelle's restart endpoint so the singleton `ConfigManager`
 * reloads the YAML. Failures surface as terminal log lines — this is
 * intentionally a zero-modal flow to stay out of the user's way.
 */
async function applyComfyUiConfig(
  win: RemoteTerminalRuntimeState,
  props: RemoteTerminalViewProps,
): Promise<void> {
  const bindUrl = win.__yyRemoteTerminalLocalBindUrl;
  if (!bindUrl) {
    appendTerminalLog(win, t("remoteTerminal.terminal.useForComfyUiNoBind"));
    setComfyUiPhase(win, "failed", t("remoteTerminal.terminal.useForComfyUiNoBind"));
    props.requestUpdate?.();
    return;
  }
  if (win.__yyRemoteTerminalComfyUiApplying) {
    return;
  }
  win.__yyRemoteTerminalComfyUiApplying = true;
  setComfyUiPhase(
    win,
    "applying",
    t("remoteTerminal.terminal.comfyUiApplyingLine", { url: bindUrl }),
  );
  props.requestUpdate?.();
  appendTerminalLog(win, t("remoteTerminal.terminal.useForComfyUiStartLine", { url: bindUrl }));

  const basePath = normalizeBasePath(props.basePath);
  const token = resolveControlUiAuthToken({
    hello: props.hello ?? null,
    settings: props.settings ?? null,
    password: props.password ?? null,
  });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const writeResp = await fetch(`${basePath}/video-studio/config/comfyui`, {
      method: "POST",
      headers,
      body: JSON.stringify({ comfyuiUrl: bindUrl }),
    });
    if (!writeResp.ok) {
      const rawBody = await writeResp.text().catch(() => "");
      const detail =
        rawBody.trim().length > 0 ? rawBody.trim() : writeResp.statusText || "no response body";
      const errText = `HTTP ${writeResp.status} ${detail}`;
      appendTerminalLog(
        win,
        t("remoteTerminal.terminal.useForComfyUiFailedLine", { error: errText }),
      );
      setComfyUiPhase(win, "failed", errText);
      win.__yyRemoteTerminalComfyUiApplying = false;
      props.requestUpdate?.();
      return;
    }
    appendTerminalLog(win, t("remoteTerminal.terminal.useForComfyUiWroteLine", { url: bindUrl }));

    // Best-effort restart so upstream Pixelle's singleton ConfigManager
    // reloads the YAML. If it fails (backend not running yet, for
    // instance) we still keep the file change — next Pixelle start
    // will pick it up.
    try {
      const restartHeaders: Record<string, string> = {};
      if (token) {
        restartHeaders.Authorization = `Bearer ${token}`;
      }
      const restartResp = await fetch(`${basePath}/video-studio/restart`, {
        method: "POST",
        headers: restartHeaders,
      });
      if (restartResp.ok) {
        appendTerminalLog(win, t("remoteTerminal.terminal.useForComfyUiRestartedLine"));
      } else {
        appendTerminalLog(win, t("remoteTerminal.terminal.useForComfyUiRestartSkippedLine"));
      }
    } catch {
      appendTerminalLog(win, t("remoteTerminal.terminal.useForComfyUiRestartSkippedLine"));
    }
    setComfyUiPhase(
      win,
      "active",
      t("remoteTerminal.terminal.comfyUiActiveLine", { url: bindUrl }),
    );
    win.__yyRemoteTerminalActiveProfileId = win.__yyRemoteTerminalSelectedId ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendTerminalLog(
      win,
      t("remoteTerminal.terminal.useForComfyUiFailedLine", { error: message }),
    );
    setComfyUiPhase(win, "failed", message);
  } finally {
    win.__yyRemoteTerminalComfyUiApplying = false;
    props.requestUpdate?.();
  }
}

function openRemoteTerminal(
  win: RemoteTerminalRuntimeState,
  props: RemoteTerminalViewProps,
  profile: SshProfile,
) {
  if (win.__yyRemoteTerminalConnectTimer) {
    clearTimeout(win.__yyRemoteTerminalConnectTimer);
    win.__yyRemoteTerminalConnectTimer = null;
  }
  try {
    win.__yyRemoteTerminalSocket?.close();
  } catch {
    // Ignore stale socket close failures.
  }

  win.__yyRemoteTerminalOutput = "";
  win.__yyRemoteTerminalStatus = "connecting";
  win.__yyRemoteTerminalSelectedId = profile.id;
  win.__yyRemoteTerminalServiceUrl = null;
  win.__yyRemoteTerminalServicePort = null;
  win.__yyRemoteTerminalLocalBindUrl = null;
  setComfyUiPhase(win, "idle");
  win.__yyRemoteTerminalEnsureScheduled = false;
  win.__yyRemoteTerminalEnsureRetried = false;
  win.__yyRemoteTerminalEnsureFirstDataAt = null;
  appendTerminalLog(
    win,
    t("remoteTerminal.terminal.connectingLine", {
      target: profile.sshConfigHost || profile.host || profile.name,
    }),
  );
  props.requestUpdate?.();

  const ws = new WebSocket(buildRemoteTerminalWsUrl(props));
  win.__yyRemoteTerminalSocket = ws;
  win.__yyRemoteTerminalConnectTimer = setTimeout(() => {
    if (win.__yyRemoteTerminalSocket !== ws || win.__yyRemoteTerminalStatus !== "connecting") {
      return;
    }
    win.__yyRemoteTerminalStatus = "error";
    appendTerminalLog(win, t("remoteTerminal.terminal.connectTimeoutLine"));
    try {
      ws.close();
    } catch {
      // Ignore stale socket close failures.
    }
    props.requestUpdate?.();
  }, REMOTE_TERMINAL_CONNECT_TIMEOUT_MS);

  ws.addEventListener("open", () => {
    appendTerminalLog(win, t("remoteTerminal.terminal.socketOpenLine"));
    props.requestUpdate?.();
    ws.send(
      JSON.stringify({
        type: "start",
        cols: 120,
        rows: 32,
        profile: {
          host: profile.host,
          port: profile.port,
          servicePort: profile.forwardPort,
          forwardPort: profile.forwardPort,
          username: profile.username,
          privateKeyPath: profile.privateKeyPath,
          password: profile.password,
          sshConfigHost: profile.sshConfigHost,
        },
      }),
    );
  });

  ws.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(String(event.data ?? "")) as {
        type?: string;
        data?: string;
        message?: string;
        code?: number | null;
        signal?: number | string | null;
        phase?: ComfyUiPhase;
        healthUrl?: string;
        alreadyRunning?: boolean;
        service?: {
          proxyUrl?: string;
          servicePort?: number;
          localBindUrl?: string;
        } | null;
      };
      if (payload.type === "ready") {
        if (win.__yyRemoteTerminalConnectTimer) {
          clearTimeout(win.__yyRemoteTerminalConnectTimer);
          win.__yyRemoteTerminalConnectTimer = null;
        }
        win.__yyRemoteTerminalStatus = "connected";
        if (payload.service?.proxyUrl) {
          win.__yyRemoteTerminalServiceUrl = payload.service.proxyUrl;
          win.__yyRemoteTerminalServicePort = payload.service.servicePort ?? null;
          win.__yyRemoteTerminalLocalBindUrl = payload.service.localBindUrl ?? null;
          appendTerminalLog(
            win,
            t("remoteTerminal.terminal.serviceReadyLine", {
              port: String(payload.service.servicePort ?? ""),
            }),
          );
        } else {
          win.__yyRemoteTerminalServiceUrl = null;
          win.__yyRemoteTerminalServicePort = null;
          win.__yyRemoteTerminalLocalBindUrl = null;
        }
        appendTerminalLog(win, t("remoteTerminal.terminal.readyLine"));
        // Pixelle-Video 原始需求：连上即让 ComfyUI 可用。
        // 但 ready 帧只代表 SSH 进程被 fork、本地端口被 listen——SSH 还在认证阶段，
        // -L 转发尚未生效，立刻探活 127.0.0.1:<localPort>/system_stats 必失败。
        // 改为：标记需要 ensure，等到 SSH 第一次回数据（密码已写入并开始进入会话）
        // 再延迟 1.2s 触发，给认证 + 远端 shell 准备留窗口。
        if (win.__yyRemoteTerminalLocalBindUrl) {
          win.__yyRemoteTerminalEnsureScheduled = true;
          win.__yyRemoteTerminalEnsureRetried = false;
          win.__yyRemoteTerminalEnsureFirstDataAt = null;
          setComfyUiPhase(win, "waiting", t("remoteTerminal.terminal.comfyUiWaitingSshLine"));
        }
      } else if (payload.type === "status") {
        appendTerminalLog(win, payload.message ?? t("remoteTerminal.terminal.statusLine"));
      } else if (payload.type === "data") {
        appendTerminalOutput(win, payload.data ?? "");
        if (
          win.__yyRemoteTerminalEnsureScheduled === true &&
          win.__yyRemoteTerminalEnsureFirstDataAt == null
        ) {
          win.__yyRemoteTerminalEnsureFirstDataAt = Date.now();
          // Defer ensure: SSH likely still in password / auth handshake.
          setTimeout(() => {
            if (win.__yyRemoteTerminalEnsureScheduled !== true) {
              return;
            }
            win.__yyRemoteTerminalEnsureScheduled = false;
            sendEnsureComfyUi(win, ws, props);
          }, 1200);
        }
      } else if (payload.type === "comfyui-status") {
        const phase = (payload.phase ?? "checking") as ComfyUiPhase;
        const message = payload.message ?? t("remoteTerminal.terminal.comfyUiStatusLine");
        setComfyUiPhase(win, phase, message);
        appendTerminalLog(win, `[ComfyUI] ${message}`);
      } else if (payload.type === "comfyui-ready") {
        const message =
          payload.alreadyRunning === true
            ? t("remoteTerminal.terminal.comfyUiReadyAlreadyLine")
            : t("remoteTerminal.terminal.comfyUiReadyStartedLine");
        setComfyUiPhase(win, "ready", message);
        appendTerminalLog(win, `[ComfyUI] ${message}`);
        // Auto-apply Pixelle config + restart so the user does not need
        // to click anything else to satisfy the original requirement.
        void applyComfyUiConfig(win, props);
      } else if (payload.type === "comfyui-error") {
        const phase = (payload.phase ?? "failed") as ComfyUiPhase;
        const message = payload.message ?? t("remoteTerminal.terminal.comfyUiEnsureFailedGeneric");
        // Auto-retry once for the early-tunnel race (password not yet
        // accepted / -L forwarding not active yet). The retry waits a
        // bit longer to give SSH time to finish auth + spawn shell.
        const isRaceyPhase = phase === "checking" || phase === "starting" || phase === "waiting";
        if (
          isRaceyPhase &&
          win.__yyRemoteTerminalEnsureRetried !== true &&
          win.__yyRemoteTerminalLocalBindUrl
        ) {
          win.__yyRemoteTerminalEnsureRetried = true;
          setComfyUiPhase(win, "waiting", t("remoteTerminal.terminal.comfyUiRetryWaitingLine"));
          appendTerminalLog(win, t("remoteTerminal.terminal.comfyUiRetryWaitingLine"));
          setTimeout(() => {
            sendEnsureComfyUi(win, ws, props);
          }, 4000);
        } else {
          setComfyUiPhase(win, "failed", message);
          appendTerminalLog(
            win,
            t("remoteTerminal.terminal.comfyUiEnsureFailedLine", { error: message }),
          );
        }
      } else if (payload.type === "error") {
        if (win.__yyRemoteTerminalConnectTimer) {
          clearTimeout(win.__yyRemoteTerminalConnectTimer);
          win.__yyRemoteTerminalConnectTimer = null;
        }
        win.__yyRemoteTerminalStatus = "error";
        appendTerminalLog(win, payload.message ?? t("remoteTerminal.terminal.error"));
      } else if (payload.type === "exit") {
        if (win.__yyRemoteTerminalConnectTimer) {
          clearTimeout(win.__yyRemoteTerminalConnectTimer);
          win.__yyRemoteTerminalConnectTimer = null;
        }
        win.__yyRemoteTerminalStatus = "closed";
        appendTerminalLog(
          win,
          `[exit ${payload.code ?? "null"}${payload.signal ? `/${payload.signal}` : ""}]`,
        );
      }
      props.requestUpdate?.();
    } catch {
      appendTerminalOutput(win, String(event.data ?? ""));
      props.requestUpdate?.();
    }
  });

  ws.addEventListener("close", (event) => {
    if (win.__yyRemoteTerminalConnectTimer) {
      clearTimeout(win.__yyRemoteTerminalConnectTimer);
      win.__yyRemoteTerminalConnectTimer = null;
    }
    if (win.__yyRemoteTerminalSocket === ws) {
      win.__yyRemoteTerminalSocket = null;
    }
    if (
      win.__yyRemoteTerminalStatus === "connecting" ||
      win.__yyRemoteTerminalStatus === "connected"
    ) {
      win.__yyRemoteTerminalStatus = "closed";
    }
    const reason = event.reason ? ` (${event.reason})` : "";
    appendTerminalLog(
      win,
      t("remoteTerminal.terminal.socketClosedLine", {
        code: String(event.code),
        reason,
      }),
    );
    props.requestUpdate?.();
  });

  ws.addEventListener("error", () => {
    if (win.__yyRemoteTerminalConnectTimer) {
      clearTimeout(win.__yyRemoteTerminalConnectTimer);
      win.__yyRemoteTerminalConnectTimer = null;
    }
    win.__yyRemoteTerminalStatus = "error";
    appendTerminalLog(win, t("remoteTerminal.terminal.socketError"));
    props.requestUpdate?.();
  });
}

function sendTerminalInput(win: RemoteTerminalRuntimeState, props: RemoteTerminalViewProps) {
  const input = win.__yyRemoteTerminalInput ?? "";
  const socket = win.__yyRemoteTerminalSocket;
  if (!input.trim() || !socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify({ type: "input", data: `${input}\n` }));
  win.__yyRemoteTerminalInput = "";
  props.requestUpdate?.();
}

/**
 * Preset shell commands surfaced under the live terminal input as
 * one-click shortcuts. These target the standard AutoDL ComfyUI
 * workflow on connect.*.seetacloud.com:
 *   1. cd into the ComfyUI tree
 *   2. enable the AutoDL network accelerator
 *   3. launch ComfyUI on :6006 bound to 0.0.0.0 with permissive CORS
 *
 * Clicking a shortcut fills the input field (so the user can tweak it
 * if needed) and immediately sends it when the terminal is connected.
 */
type QuickCommand = {
  label: string;
  command: string;
  title: string;
};

const QUICK_COMMANDS: readonly QuickCommand[] = [
  {
    label: "cd ComfyUI",
    command: "cd /root/autodl-tmp/ComfyUI",
    title: "cd /root/autodl-tmp/ComfyUI",
  },
  {
    // Translation key resolved at render time so the label tracks the
    // current shell locale instead of being baked into the constant.
    label: "remoteTerminal.quickCommands.enableProxy",
    command: "source /etc/network_turbo",
    title: "source /etc/network_turbo",
  },
  {
    label: "remoteTerminal.quickCommands.startComfyUi",
    command: 'python main.py --port 6006 --listen 0.0.0.0 --enable-cors-header "*"',
    title: 'python main.py --port 6006 --listen 0.0.0.0 --enable-cors-header "*"',
  },
];

function runQuickCommand(
  win: RemoteTerminalRuntimeState,
  props: RemoteTerminalViewProps,
  command: string,
) {
  win.__yyRemoteTerminalInput = command;
  const socket = win.__yyRemoteTerminalSocket;
  if (socket && socket.readyState === WebSocket.OPEN) {
    sendTerminalInput(win, props);
    return;
  }
  // Not connected yet: just leave the command in the input so the user
  // can review/edit and send it after the session comes up.
  props.requestUpdate?.();
}

/**
 * Resolve the `service.proxyUrl` returned by the gateway into a URL
 * that will definitely open the gateway (and not be swallowed by the
 * Vite dev server / SPA router).
 *
 * The gateway returns a relative path like
 * `/remote-terminal/proxy/<id>/?access=<token>`. If the UI is being
 * served by `vite dev` on a different port than the gateway (the
 * typical Control UI dev loop: Vite on :5173, gateway on :<gateway>),
 * a relative path ends up hitting Vite's `index.html` SPA fallback
 * instead of the gateway proxy handler. Detect that case and fall
 * back to the gateway origin recorded in the Hello payload when we
 * have it; otherwise keep the relative URL and let the outer layer
 * (`window.open`) at least open it in a new tab instead of replacing
 * the current terminal page.
 */
function resolveRemoteServiceOpenUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const origin = globalThis.location?.origin;
  if (!origin) {
    return trimmed;
  }
  try {
    return new URL(trimmed, origin).toString();
  } catch {
    return trimmed;
  }
}

/** Guard: prevent accidental double-open from rapid re-renders during the click cycle. */
let _openServiceOpen = false;

function openRemoteServiceUrl(raw: string | null | undefined) {
  if (!raw || _openServiceOpen) {
    return;
  }
  _openServiceOpen = true;
  const url = resolveRemoteServiceOpenUrl(raw);
  // Always open in a new tab via window.open so the click can never
  // re-navigate the current page — protecting the live SSH session
  // from being torn down if routing somehow misbehaves.
  try {
    const opened = globalThis.window?.open(url, "_blank", "noopener,noreferrer");
    if (opened) {
      return;
    }
  } catch {
    // Pop-up blocked or not available; fall through.
  }
  // Popup was blocked — clear guard after a short delay so the user can
  // try again via a second click without the button appearing dead.
  setTimeout(() => {
    _openServiceOpen = false;
  }, 300);
}

export function renderRemoteTerminalView(props: RemoteTerminalViewProps) {
  const win = globalThis as RemoteTerminalRuntimeState;
  const draft = win.__yyRemoteTerminalDraft ?? cloneDefaultDraft();
  win.__yyRemoteTerminalDraft = draft;
  win.__yyRemoteTerminalStatus ??= "idle";
  win.__yyRemoteTerminalProfileDialogOpen ??= false;

  const profiles = loadSshProfiles();
  const selected =
    profiles.find((profile) => profile.id === win.__yyRemoteTerminalSelectedId) ??
    profiles[0] ??
    null;

  const setMessage = (message: string | null) => {
    win.__yyRemoteTerminalMessage = message;
    props.requestUpdate?.();
  };

  const updateDraft = (patch: Partial<Draft>) => {
    const currentDraft = win.__yyRemoteTerminalDraft ?? cloneDefaultDraft();
    win.__yyRemoteTerminalDraft = { ...currentDraft, ...patch };
    props.requestUpdate?.();
  };

  const openProfileDialog = () => {
    win.__yyRemoteTerminalProfileDialogOpen = true;
    props.requestUpdate?.();
  };

  const closeProfileDialog = (resetDraft = false) => {
    win.__yyRemoteTerminalProfileDialogOpen = false;
    if (resetDraft) {
      win.__yyRemoteTerminalDraft = cloneDefaultDraft();
    }
    props.requestUpdate?.();
  };

  const connectProfile = (profile: SshProfile) => {
    const nextProfiles = profiles.map((item) =>
      item.id === profile.id ? { ...item, lastConnectedAt: Date.now() } : item,
    );
    saveSshProfiles(nextProfiles);
    setMessage(t("remoteTerminal.messages.commandReady", { name: profile.name }));
    openRemoteTerminal(win, props, profile);
  };

  const saveProfile = (event?: Event) => {
    event?.preventDefault();
    const currentDraft = win.__yyRemoteTerminalDraft ?? cloneDefaultDraft();
    const form = event?.currentTarget instanceof HTMLFormElement ? event.currentTarget : null;
    const formData = form ? new FormData(form) : null;
    const readField = (key: keyof Draft) => {
      const value = formData?.get(key);
      return typeof value === "string" ? value : String(currentDraft[key] ?? "");
    };
    const host = readField("host").trim();
    const sshConfigHost = readField("sshConfigHost").trim();
    const name = readField("name").trim() || sshConfigHost || host;
    const username = readField("username").trim();
    const privateKeyPath = readField("privateKeyPath").trim();
    const password = readField("password");
    const port = Math.max(1, Math.min(65535, Math.trunc(Number(readField("port")) || 22)));
    const forwardPort = Math.max(
      1,
      Math.min(65535, Math.trunc(Number(readField("forwardPort")) || 6006)),
    );

    if (!host && !sshConfigHost) {
      setMessage(t("remoteTerminal.messages.required"));
      return;
    }

    const profile: SshProfile = {
      id: createId(),
      name,
      host,
      port,
      forwardPort,
      username,
      privateKeyPath,
      password,
      sshConfigHost,
      description: readField("description").trim(),
    };

    const nextProfiles = [profile, ...profiles];
    saveSshProfiles(nextProfiles);
    win.__yyRemoteTerminalSelectedId = profile.id;
    win.__yyRemoteTerminalDraft = cloneDefaultDraft();
    win.__yyRemoteTerminalProfileDialogOpen = false;
    setMessage(t("remoteTerminal.messages.saved", { name }));
  };

  const requestDeleteProfile = (profile: SshProfile) => {
    win.__yyRemoteTerminalDeleteConfirmId = profile.id;
    props.requestUpdate?.();
  };

  const cancelDeleteProfile = () => {
    win.__yyRemoteTerminalDeleteConfirmId = null;
    props.requestUpdate?.();
  };

  const deleteProfile = (profile: SshProfile) => {
    const nextProfiles = profiles.filter((item) => item.id !== profile.id);
    saveSshProfiles(nextProfiles);
    if (win.__yyRemoteTerminalSelectedId === profile.id) {
      win.__yyRemoteTerminalSelectedId = nextProfiles[0]?.id ?? null;
    }
    win.__yyRemoteTerminalDeleteConfirmId = null;
    setMessage(t("remoteTerminal.messages.deleted", { name: profile.name }));
  };

  return html`
    <div class="remote-terminal-page">
      ${win.__yyRemoteTerminalMessage
        ? html`<div class="callout info remote-terminal-message">
            ${win.__yyRemoteTerminalMessage}
          </div>`
        : nothing}
      ${win.__yyRemoteTerminalProfileDialogOpen
        ? html`
            <div
              class="remote-terminal-modal-backdrop"
              role="presentation"
              @click=${(event: Event) => {
                if (event.target === event.currentTarget) {
                  closeProfileDialog();
                }
              }}
            >
              <form
                class="panel-card remote-terminal-card remote-terminal-profile-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="remote-terminal-profile-dialog-title"
                @submit=${saveProfile}
              >
                <div class="remote-terminal-dialog__header">
                  <div>
                    <h3 id="remote-terminal-profile-dialog-title">
                      ${t("remoteTerminal.form.title")}
                    </h3>
                    <p>${t("remoteTerminal.form.subtitle")}</p>
                  </div>
                  <button
                    class="btn btn--sm btn--subtle"
                    type="button"
                    @click=${() => closeProfileDialog()}
                  >
                    ${t("common.cancel")}
                  </button>
                </div>

                ${win.__yyRemoteTerminalMessage
                  ? html`<div class="callout info remote-terminal-dialog__message">
                      ${win.__yyRemoteTerminalMessage}
                    </div>`
                  : nothing}

                <div class="remote-terminal-form-grid">
                  <label class="field">
                    <span>${t("remoteTerminal.form.name")}</span>
                    <input
                      name="name"
                      .value=${draft.name}
                      placeholder="prod-web-1"
                      @input=${(event: Event) =>
                        updateDraft({ name: (event.target as HTMLInputElement).value })}
                    />
                  </label>
                  <label class="field">
                    <span>${t("remoteTerminal.form.sshConfigHost")}</span>
                    <input
                      name="sshConfigHost"
                      .value=${draft.sshConfigHost}
                      placeholder="prod-web"
                      @input=${(event: Event) =>
                        updateDraft({ sshConfigHost: (event.target as HTMLInputElement).value })}
                    />
                  </label>
                  <label class="field">
                    <span>${t("remoteTerminal.form.host")}</span>
                    <input
                      name="host"
                      .value=${draft.host}
                      placeholder="192.168.1.10"
                      @input=${(event: Event) =>
                        updateDraft({ host: (event.target as HTMLInputElement).value })}
                    />
                  </label>
                  <label class="field">
                    <span>${t("remoteTerminal.form.port")}</span>
                    <input
                      name="port"
                      type="number"
                      min="1"
                      max="65535"
                      .value=${String(draft.port)}
                      @input=${(event: Event) =>
                        updateDraft({ port: Number((event.target as HTMLInputElement).value) })}
                    />
                  </label>
                  <label class="field">
                    <span>${t("remoteTerminal.form.forwardPort")}</span>
                    <input
                      name="forwardPort"
                      type="number"
                      min="1"
                      max="65535"
                      .value=${String(draft.forwardPort)}
                      placeholder="6006"
                      @input=${(event: Event) =>
                        updateDraft({
                          forwardPort: Number((event.target as HTMLInputElement).value),
                        })}
                    />
                    <small>${t("remoteTerminal.form.forwardPortHelp")}</small>
                  </label>
                  <label class="field">
                    <span>${t("remoteTerminal.form.username")}</span>
                    <input
                      name="username"
                      .value=${draft.username}
                      placeholder="root"
                      @input=${(event: Event) =>
                        updateDraft({ username: (event.target as HTMLInputElement).value })}
                    />
                  </label>
                  <label class="field">
                    <span>${t("remoteTerminal.form.privateKeyPath")}</span>
                    <input
                      name="privateKeyPath"
                      .value=${draft.privateKeyPath}
                      placeholder="${t("remoteTerminal.form.privateKeyPathPlaceholder")}"
                      @input=${(event: Event) =>
                        updateDraft({ privateKeyPath: (event.target as HTMLInputElement).value })}
                    />
                  </label>
                  <label class="field remote-terminal-password-field">
                    <span>${t("remoteTerminal.form.password")}</span>
                    <input
                      name="password"
                      type="password"
                      autocomplete="new-password"
                      .value=${draft.password}
                      placeholder="${t("remoteTerminal.form.passwordPlaceholder")}"
                      @input=${(event: Event) =>
                        updateDraft({ password: (event.target as HTMLInputElement).value })}
                    />
                    <small>${t("remoteTerminal.form.passwordHelp")}</small>
                  </label>
                </div>

                <label class="field remote-terminal-description-field">
                  <span>${t("remoteTerminal.form.description")}</span>
                  <textarea
                    name="description"
                    rows="3"
                    .value=${draft.description}
                    placeholder="${t("remoteTerminal.form.descriptionPlaceholder")}"
                    @input=${(event: Event) =>
                      updateDraft({ description: (event.target as HTMLTextAreaElement).value })}
                  ></textarea>
                </label>

                <div class="remote-terminal-actions remote-terminal-dialog__actions">
                  <button class="btn btn--primary" type="submit">
                    ${t("remoteTerminal.form.save")}
                  </button>
                  <button
                    class="btn btn--subtle"
                    type="button"
                    @click=${() => closeProfileDialog(true)}
                  >
                    ${t("common.cancel")}
                  </button>
                </div>
              </form>
            </div>
          `
        : nothing}

      <div class="remote-terminal-grid remote-terminal-grid--profiles">
        <section class="panel-card remote-terminal-card">
          <div class="section-heading">
            <h3>${t("remoteTerminal.profile.title")}</h3>
          </div>

          <div class="remote-terminal-profile-list">
            <button
              type="button"
              class="remote-terminal-profile remote-terminal-profile--add"
              @click=${openProfileDialog}
              aria-label=${t("remoteTerminal.profile.add")}
            >
              <span class="remote-terminal-profile__add-icon">${icons.plus}</span>
              <span class="remote-terminal-profile__add-label">
                ${t("remoteTerminal.profile.add")}
              </span>
            </button>
            ${profiles.map(
              (profile) => html`
                <article
                  class="remote-terminal-profile ${selected?.id === profile.id
                    ? "remote-terminal-profile--active"
                    : ""} ${selected?.id === profile.id &&
                  win.__yyRemoteTerminalStatus === "connected"
                    ? "remote-terminal-profile--connected"
                    : ""}"
                >
                  <div class="remote-terminal-profile__main">
                    <span class="remote-terminal-profile__icon">${icons.monitor}</span>
                    <span class="remote-terminal-profile__body">
                      <strong>${profile.name}</strong>
                      <small
                        >${profile.sshConfigHost ||
                        `${profile.username ? `${profile.username}@` : ""}${profile.host}:${profile.port}`}</small
                      >
                      <small>
                        ${t("remoteTerminal.profile.forwardPort", {
                          port: String(profile.forwardPort),
                        })}
                      </small>
                      ${profile.description ? html`<em>${profile.description}</em>` : nothing}
                    </span>
                  </div>
                  <div class="remote-terminal-profile__actions">
                    <span>${relativeTime(profile.lastConnectedAt)}</span>
                    <div class="remote-terminal-profile__buttons">
                      <button
                        class="btn btn--sm btn--primary"
                        title=${t("remoteTerminal.profile.connectTitle")}
                        @click=${() => connectProfile(profile)}
                      >
                        ${t("remoteTerminal.profile.connect")}
                      </button>
                      <button
                        class="btn btn--sm btn--subtle"
                        @click=${() => requestDeleteProfile(profile)}
                      >
                        ${t("remoteTerminal.profile.delete")}
                      </button>
                    </div>
                  </div>
                  ${win.__yyRemoteTerminalDeleteConfirmId === profile.id
                    ? html`
                        <div class="remote-terminal-delete-confirm" role="alertdialog">
                          <div>
                            <strong>${t("remoteTerminal.profile.deleteConfirmTitle")}</strong>
                            <p>
                              ${t("remoteTerminal.profile.deleteConfirmBody", {
                                name: profile.name,
                              })}
                            </p>
                          </div>
                          <div class="remote-terminal-delete-confirm__actions">
                            <button class="btn btn--sm btn--subtle" @click=${cancelDeleteProfile}>
                              ${t("common.cancel")}
                            </button>
                            <button
                              class="btn btn--sm danger"
                              @click=${() => deleteProfile(profile)}
                            >
                              ${t("remoteTerminal.profile.delete")}
                            </button>
                          </div>
                        </div>
                      `
                    : nothing}
                </article>
              `,
            )}
          </div>
        </section>
      </div>

      <section
        class="panel-card remote-terminal-console"
        aria-label=${t("remoteTerminal.terminal.title")}
      >
        <div class="remote-terminal-live">
          <div class="remote-terminal-live__header">
            <strong>${t("remoteTerminal.terminal.title")}</strong>
            <span
              class="remote-terminal-live__status remote-terminal-live__status--${win.__yyRemoteTerminalStatus ??
              "idle"}"
            >
              ${terminalStatusLabel(win.__yyRemoteTerminalStatus ?? "idle")}
            </span>
            ${win.__yyRemoteTerminalStatus === "connected" &&
            (win.__yyRemoteTerminalComfyUiPhase ?? "idle") !== "idle"
              ? html`<span
                  class="remote-terminal-live__comfyui remote-terminal-live__comfyui--${win.__yyRemoteTerminalComfyUiPhase}"
                  title=${win.__yyRemoteTerminalComfyUiMessage ?? ""}
                >
                  ${comfyUiPhaseLabel(win.__yyRemoteTerminalComfyUiPhase ?? "idle")}
                </span>`
              : nothing}
            ${win.__yyRemoteTerminalStatus === "connected" && win.__yyRemoteTerminalLocalBindUrl
              ? html`<button
                  class="btn btn--sm btn--subtle"
                  ?disabled=${win.__yyRemoteTerminalComfyUiApplying === true}
                  title=${t("remoteTerminal.terminal.retryApplyTitle", {
                    url: win.__yyRemoteTerminalLocalBindUrl ?? "",
                  })}
                  @click=${() => applyComfyUiConfig(win, props)}
                >
                  ${win.__yyRemoteTerminalComfyUiApplying === true
                    ? t("remoteTerminal.terminal.useForComfyUiApplying")
                    : t("remoteTerminal.terminal.retryApply")}
                </button>`
              : nothing}
            ${win.__yyRemoteTerminalStatus === "connected" && win.__yyRemoteTerminalServiceUrl
              ? html`<button
                  class="btn btn--sm btn--subtle"
                  type="button"
                  title=${t("remoteTerminal.terminal.openComfyUiTitle", {
                    port: String(win.__yyRemoteTerminalServicePort ?? ""),
                  })}
                  @click=${() => openRemoteServiceUrl(win.__yyRemoteTerminalServiceUrl)}
                >
                  ${t("remoteTerminal.terminal.openComfyUi", {
                    port: String(win.__yyRemoteTerminalServicePort ?? ""),
                  })}
                </button>`
              : nothing}
            <button class="btn btn--sm btn--subtle" @click=${() => closeRemoteTerminal(win, props)}>
              ${t("remoteTerminal.terminal.disconnect")}
            </button>
          </div>
          <pre class="remote-terminal-live__output"><code>${win.__yyRemoteTerminalOutput ||
          t("remoteTerminal.terminal.empty")}</code></pre>
          <div class="remote-terminal-live__input-row">
            <input
              class="remote-terminal-live__input"
              .value=${win.__yyRemoteTerminalInput ?? ""}
              placeholder=${t("remoteTerminal.terminal.inputPlaceholder")}
              @input=${(event: Event) => {
                win.__yyRemoteTerminalInput = (event.target as HTMLInputElement).value;
                props.requestUpdate?.();
              }}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  sendTerminalInput(win, props);
                }
              }}
            />
            <button class="btn btn--sm btn--primary" @click=${() => sendTerminalInput(win, props)}>
              ${t("remoteTerminal.terminal.send")}
            </button>
          </div>
          <div
            class="remote-terminal-live__quick-row"
            role="toolbar"
            aria-label=${t("remoteTerminal.quickCommands.ariaLabel")}
          >
            <span class="remote-terminal-live__quick-label"
              >${t("remoteTerminal.quickCommands.label")}</span
            >
            ${QUICK_COMMANDS.map(
              (preset) => html`
                <button
                  class="btn btn--sm btn--subtle remote-terminal-live__quick-btn"
                  type="button"
                  title=${preset.title}
                  ?disabled=${win.__yyRemoteTerminalStatus !== "connected"}
                  @click=${() => runQuickCommand(win, props, preset.command)}
                >
                  ${preset.label.includes(".") ? t(preset.label) : preset.label}
                </button>
              `,
            )}
          </div>
        </div>
      </section>
    </div>
  `;
}
