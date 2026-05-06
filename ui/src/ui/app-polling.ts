import type { DebugState } from "./controllers/debug.ts";
import { loadDebug } from "./controllers/debug.ts";
import type { LogsState } from "./controllers/logs.ts";
import { loadLogs } from "./controllers/logs.ts";
import type { NodesState } from "./controllers/nodes.ts";
import { loadNodes } from "./controllers/nodes.ts";
import {
  ensureHostLanguageSync,
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
  // Mirror the current host UI locale to the embedded Pixelle backend so
  // its language picker boots aligned with the shell instead of falling
  // back to its default `en_US`. Also subscribes to host-language changes
  // so subsequent toggles propagate without a tab switch.
  ensureHostLanguageSync(host);
  // Immediate fetch so the view doesn't wait 3s on first open.
  void loadVideoStudioStatusState(host);
  host.videoStudioPollTimer = window.setInterval(() => {
    if (host.tab !== "videoStudio") {
      return;
    }
    // Re-check on every tick so a deps change (auth refresh) or a
    // first-time-arrival-after-HMR still gets a chance to push the
    // host locale through. ensureHostLanguageSync is idempotent and
    // dedupes internally, so no duplicate POSTs.
    ensureHostLanguageSync(host);
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
