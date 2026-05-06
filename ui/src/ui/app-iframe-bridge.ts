// Bridge for `postMessage` traffic from embedded iframes back into the
// OpenClaw shell.
//
// Today the only producer is the Pixelle-Video Streamlit tab embedded
// under the Video Studio view (`<video-studio-view>` → `renderStreamlitFrame`).
// Some links inside the embedded UI need to take the user to a different
// OpenClaw tab — e.g. the ComfyUI settings panel exposes a "no local
// service? add a remote ComfyUI server" link that should drop the user
// into the Remote Terminal tab. The Pixelle iframe runs with the
// `allow-top-navigation` flag stripped from its sandbox (intentional, so
// stray redirects can't escape the embed), which means it cannot mutate
// `window.top.location` directly. Instead the iframe sends a structured
// message:
//
//     {
//       type: "openclaw:navigate",
//       tab:  "remoteTerminal",
//       path: "/yy-video/remote-servers/terminal" // optional, advisory
//     }
//
// We accept it, validate the requested tab against the navigation
// registry, and route through the shell's normal `setTab` (which also
// updates the URL via `app-settings.setTabInternal`). Anything we don't
// recognise is ignored — a defensive default since the embedded iframe
// is technically a third-party origin (`http://127.0.0.1:<port>`).
//
// The listener is installed in `app-lifecycle.handleConnected` and torn
// down in `handleDisconnected` so HMR / reconnect cycles don't leak
// duplicates.

import { tabFromPath, type Tab } from "./navigation.ts";

export type IframeBridgeHost = {
  setTab(next: Tab): void;
};

type NavigateMessage = {
  readonly type: "openclaw:navigate";
  readonly tab: string;
  readonly path?: string;
};

function isNavigateMessage(value: unknown): value is NavigateMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.type === "openclaw:navigate" && typeof v.tab === "string";
}

/**
 * Resolve the requested target into a known {@link Tab}.
 *
 * Strategy: prefer the explicit `path` (which is what the navigation
 * registry already maps via `tabFromPath`) and fall back to a path
 * synthesised from the `tab` field. Any unknown combination yields
 * `null` so unrecognised messages are dropped silently.
 */
function resolveTargetTab(message: NavigateMessage): Tab | null {
  if (message.path) {
    const fromPath = tabFromPath(message.path);
    if (fromPath) return fromPath;
  }
  // Allow shorthand `{ tab: "remoteTerminal" }` by reusing the same
  // path-based resolver. Synthesize a leading-slash path so the
  // navigation registry's `PATH_TO_TAB` map can match it; this avoids
  // having to export the full Tab union just for an `isTab` guard.
  const synth = `/${message.tab.replace(/^\/+/, "")}`;
  const fromTab = tabFromPath(synth);
  if (fromTab) return fromTab;
  return null;
}

export function createIframeBridgeListener(host: IframeBridgeHost): (event: MessageEvent) => void {
  return (event: MessageEvent) => {
    // We never trust the data shape blindly — only structurally-valid
    // navigation requests for known tabs are honoured. Other message
    // formats (Streamlit's own internal frames, browser extensions,
    // etc.) just fall through.
    const data = event.data;
    if (!isNavigateMessage(data)) return;
    const tab = resolveTargetTab(data);
    if (!tab) return;
    host.setTab(tab);
  };
}
