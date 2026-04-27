import type { DebugState } from "./controllers/debug.ts";
import { loadDebug } from "./controllers/debug.ts";
import type { LogsState } from "./controllers/logs.ts";
import { loadLogs } from "./controllers/logs.ts";
import type { NodesState } from "./controllers/nodes.ts";
import { loadNodes } from "./controllers/nodes.ts";
import {
  loadVideoStudioStatusState,
  type VideoStudioControllerState,
  type VideoStudioHttpDeps,
} from "./controllers/video-studio.ts";

type PollingHost = {
  nodesPollInterval: number | null;
  logsPollInterval: number | null;
  debugPollInterval: number | null;
  videoStudioPollTimer?: number | null;
  tab: string;
};

export function startNodesPolling(host: PollingHost) {
  if (host.nodesPollInterval != null) {
    return;
  }
  host.nodesPollInterval = window.setInterval(
    () => void loadNodes(host as unknown as NodesState, { quiet: true }),
    5000,
  );
}

export function stopNodesPolling(host: PollingHost) {
  if (host.nodesPollInterval == null) {
    return;
  }
  clearInterval(host.nodesPollInterval);
  host.nodesPollInterval = null;
}

export function startLogsPolling(host: PollingHost) {
  if (host.logsPollInterval != null) {
    return;
  }
  host.logsPollInterval = window.setInterval(() => {
    if (host.tab !== "logs") {
      return;
    }
    void loadLogs(host as unknown as LogsState, { quiet: true });
  }, 2000);
}

export function stopLogsPolling(host: PollingHost) {
  if (host.logsPollInterval == null) {
    return;
  }
  clearInterval(host.logsPollInterval);
  host.logsPollInterval = null;
}

export function startDebugPolling(host: PollingHost) {
  if (host.debugPollInterval != null) {
    return;
  }
  host.debugPollInterval = window.setInterval(() => {
    if (host.tab !== "debug") {
      return;
    }
    void loadDebug(host as unknown as DebugState);
  }, 3000);
}

export function stopDebugPolling(host: PollingHost) {
  if (host.debugPollInterval == null) {
    return;
  }
  clearInterval(host.debugPollInterval);
  host.debugPollInterval = null;
}

export function startVideoStudioPolling(
  host: PollingHost & VideoStudioControllerState & VideoStudioHttpDeps,
) {
  if (host.videoStudioPollTimer != null) {
    return;
  }
  // Immediate fetch so the view doesn't wait 3s on first open.
  void loadVideoStudioStatusState(host);
  host.videoStudioPollTimer = window.setInterval(() => {
    if (host.tab !== "videoStudio") {
      return;
    }
    void loadVideoStudioStatusState(host);
  }, 3000);
}

export function stopVideoStudioPolling(host: PollingHost) {
  if (host.videoStudioPollTimer == null) {
    return;
  }
  clearInterval(host.videoStudioPollTimer);
  host.videoStudioPollTimer = null;
}
