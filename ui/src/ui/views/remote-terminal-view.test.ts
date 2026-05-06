/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { renderRemoteTerminalView } from "./remote-terminal-view.ts";

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }),
  );
}

type MockWebSocketListener = (event: Event) => void;

class MockWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: MockWebSocketListener) {
    super.addEventListener(type, listener as EventListener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

function saveProfile(container: HTMLElement, host: string, username = "deploy") {
  // The "Add server" entry is rendered as a card-shaped button living
  // inside the profile grid (see `.remote-terminal-profile--add`), not
  // as the section heading's primary action. Tests open the dialog
  // through the same affordance the user clicks.
  container.querySelector<HTMLButtonElement>(".remote-terminal-profile--add")?.click();
  setInputValue(container.querySelector<HTMLInputElement>('input[name="host"]')!, host);
  setInputValue(container.querySelector<HTMLInputElement>('input[name="username"]')!, username);
  container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
}

describe("renderRemoteTerminalView", () => {
  beforeEach(async () => {
    const localStorage = createStorageMock();
    vi.stubGlobal("localStorage", localStorage);
    Object.defineProperty(window, "localStorage", {
      value: localStorage,
      writable: true,
      configurable: true,
    });
    getSafeLocalStorage()?.clear();
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    getSafeLocalStorage()?.clear();
    document.body.innerHTML = "";
    delete (globalThis as { __yyRemoteTerminalDraft?: unknown }).__yyRemoteTerminalDraft;
    delete (globalThis as { __yyRemoteTerminalSelectedId?: unknown }).__yyRemoteTerminalSelectedId;
    delete (globalThis as { __yyRemoteTerminalMessage?: unknown }).__yyRemoteTerminalMessage;
    delete (globalThis as { __yyRemoteTerminalDeleteConfirmId?: unknown })
      .__yyRemoteTerminalDeleteConfirmId;
    delete (globalThis as { __yyRemoteTerminalProfileDialogOpen?: unknown })
      .__yyRemoteTerminalProfileDialogOpen;
    delete (globalThis as { __yyRemoteTerminalStatus?: unknown }).__yyRemoteTerminalStatus;
    delete (globalThis as { __yyRemoteTerminalSocket?: unknown }).__yyRemoteTerminalSocket;
    delete (globalThis as { __yyRemoteTerminalConnectTimer?: unknown })
      .__yyRemoteTerminalConnectTimer;
    delete (globalThis as { __yyRemoteTerminalServiceUrl?: unknown }).__yyRemoteTerminalServiceUrl;
    delete (globalThis as { __yyRemoteTerminalServicePort?: unknown })
      .__yyRemoteTerminalServicePort;
    delete (globalThis as { __yyRemoteTerminalLocalBindUrl?: unknown })
      .__yyRemoteTerminalLocalBindUrl;
    delete (globalThis as { __yyRemoteTerminalComfyUiApplying?: unknown })
      .__yyRemoteTerminalComfyUiApplying;
    delete (globalThis as { __yyRemoteTerminalComfyUiPhase?: unknown })
      .__yyRemoteTerminalComfyUiPhase;
    delete (globalThis as { __yyRemoteTerminalComfyUiMessage?: unknown })
      .__yyRemoteTerminalComfyUiMessage;
    delete (globalThis as { __yyRemoteTerminalActiveProfileId?: unknown })
      .__yyRemoteTerminalActiveProfileId;
    delete (globalThis as { __yyRemoteTerminalOutput?: unknown }).__yyRemoteTerminalOutput;
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  it("closes the Add server dialog and renders the saved server after Save server", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const requestUpdate = vi.fn(() => {
      render(renderRemoteTerminalView({ basePath: "", requestUpdate }), container);
    });

    render(renderRemoteTerminalView({ basePath: "", requestUpdate }), container);

    container.querySelector<HTMLButtonElement>(".remote-terminal-profile--add")?.click();
    expect(container.querySelector(".remote-terminal-profile-dialog")).not.toBeNull();

    setInputValue(container.querySelector<HTMLInputElement>('input[name="host"]')!, "192.168.1.10");
    setInputValue(container.querySelector<HTMLInputElement>('input[name="username"]')!, "deploy");
    container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();

    await Promise.resolve();

    expect(container.querySelector(".remote-terminal-profile-dialog")).toBeNull();
    // Saved profile renders an article card alongside the persistent
    // "Add server" affordance — the empty-state placeholder is gone in
    // the card-grid layout, so we assert on the saved card content
    // instead of querying for `.remote-terminal-empty`.
    expect(
      container.querySelector(".remote-terminal-profile:not(.remote-terminal-profile--add)"),
    ).not.toBeNull();
    expect(container.textContent).toContain("192.168.1.10");
    expect(container.textContent).toContain("deploy@192.168.1.10:22");
    expect(container.textContent).toContain("Remote service port:6006");
  });

  it("requires confirmation before deleting a saved server", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const requestUpdate = vi.fn(() => {
      render(renderRemoteTerminalView({ basePath: "", requestUpdate }), container);
    });

    render(renderRemoteTerminalView({ basePath: "", requestUpdate }), container);
    saveProfile(container, "192.168.1.10", "deploy");

    const deleteButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Delete",
    );
    deleteButton?.click();

    expect(container.textContent).toContain("Delete this server?");
    expect(container.textContent).toContain("192.168.1.10");

    const confirmButton = container.querySelector<HTMLButtonElement>(
      ".remote-terminal-delete-confirm .danger",
    );
    confirmButton?.click();

    await Promise.resolve();

    expect(container.textContent).toContain("Deleted 192.168.1.10.");
    // After deletion the saved-server card disappears; the "Add server"
    // tile remains in place since it's the persistent entry point in
    // the new card-grid layout.
    expect(
      container.querySelector(".remote-terminal-profile:not(.remote-terminal-profile--add)"),
    ).toBeNull();
    expect(container.querySelector(".remote-terminal-profile--add")).not.toBeNull();
  });

  it("shows connection logs and switches to Connected when the backend reports ready", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    MockWebSocket.instances = [];
    const container = document.createElement("div");
    document.body.append(container);
    const requestUpdate = vi.fn(() => {
      render(renderRemoteTerminalView({ basePath: "", requestUpdate }), container);
    });

    render(renderRemoteTerminalView({ basePath: "", requestUpdate }), container);
    saveProfile(container, "192.168.1.10", "deploy");
    const connectButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Connect",
    );
    connectButton?.click();

    const socket = MockWebSocket.instances[0];
    expect(socket).toBeTruthy();
    expect(container.textContent).toContain("Connecting");
    expect(container.textContent).toContain("Connecting to 192.168.1.10.");

    socket.open();
    expect(socket.sent[0]).toContain('"type":"start"');
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      profile: { servicePort: 6006, forwardPort: 6006 },
    });
    socket.receive({ type: "status", message: "Starting SSH process for deploy@192.168.1.10." });
    socket.receive({
      type: "ready",
      pid: 1234,
      service: {
        proxyUrl: "/remote-terminal/proxy/tunnel-1/?access=abc",
        servicePort: 6006,
        tunnelId: "tunnel-1",
        localPort: 45678,
        localBindUrl: "http://127.0.0.1:6006",
      },
    });

    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("WebSocket connected. Starting SSH session...");
    expect(container.textContent).toContain("Starting SSH process for deploy@192.168.1.10.");
    expect(container.textContent).toContain(
      "SSH process started. Waiting for SSH output/authentication result below.",
    );
    const openServiceButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Open ComfyUI"),
    );
    expect(openServiceButton).toBeTruthy();
    expect(openServiceButton?.getAttribute("title")).toContain("6006");
    // ready 后不应立即发 ensure-comfyui（SSH 还可能在认证）。
    expect(socket.sent.some((frame) => frame.includes('"ensure-comfyui"'))).toBe(false);
    // phase badge 显示 Waiting for ComfyUI，等 SSH 出数据后再触发探活。
    expect(container.textContent).toContain("Waiting for ComfyUI");
  });

  it("defers ensure-comfyui until SSH starts producing data", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    MockWebSocket.instances = [];
    const container = document.createElement("div");
    document.body.append(container);
    const requestUpdate = vi.fn(() => {
      render(renderRemoteTerminalView({ basePath: "", requestUpdate }), container);
    });

    render(renderRemoteTerminalView({ basePath: "", requestUpdate }), container);
    saveProfile(container, "192.168.1.10", "deploy");
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Connect")
      ?.click();

    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive({
      type: "ready",
      pid: 1234,
      service: {
        proxyUrl: "/remote-terminal/proxy/tunnel-1/?access=abc",
        servicePort: 6006,
        localPort: 6006,
        localBindUrl: "http://127.0.0.1:6006",
        tunnelId: "tunnel-1",
      },
    });

    expect(socket.sent.some((frame) => frame.includes('"ensure-comfyui"'))).toBe(false);

    socket.receive({ type: "data", data: "Welcome to Ubuntu\n" });

    // ensure 应该被排到 1.2s 后。
    expect(socket.sent.some((frame) => frame.includes('"ensure-comfyui"'))).toBe(false);
    await vi.advanceTimersByTimeAsync(1300);
    expect(socket.sent.some((frame) => frame.includes('"ensure-comfyui"'))).toBe(true);
    expect(container.textContent).toContain("Checking ComfyUI");
    vi.useRealTimers();
  });

  it("auto-applies Pixelle config when the backend reports comfyui-ready", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    MockWebSocket.instances = [];
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/video-studio/config/comfyui")) {
        return new Response(
          JSON.stringify({
            ok: true,
            configPath: "config.yaml",
            comfyuiUrl: "http://127.0.0.1:6006",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/video-studio/restart")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const requestUpdate = vi.fn(() => {
      render(renderRemoteTerminalView({ basePath: "", requestUpdate }), container);
    });

    render(renderRemoteTerminalView({ basePath: "", requestUpdate }), container);
    saveProfile(container, "192.168.1.10", "deploy");
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Connect")
      ?.click();

    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive({
      type: "ready",
      pid: 1234,
      service: {
        proxyUrl: "/remote-terminal/proxy/tunnel-1/?access=abc",
        servicePort: 6006,
        localPort: 6006,
        localBindUrl: "http://127.0.0.1:6006",
        tunnelId: "tunnel-1",
      },
    });

    socket.receive({ type: "comfyui-status", phase: "checking", message: "probing" });
    expect(container.textContent).toContain("Checking ComfyUI");

    socket.receive({
      type: "comfyui-ready",
      service: {
        proxyUrl: "/remote-terminal/proxy/tunnel-1/?access=abc",
        servicePort: 6006,
        localPort: 6006,
        localBindUrl: "http://127.0.0.1:6006",
        tunnelId: "tunnel-1",
      },
      healthUrl: "http://127.0.0.1:6006/system_stats",
      alreadyRunning: true,
    });

    // Allow the chained microtasks (config write -> restart) to settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const calls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calls).toContain("/video-studio/config/comfyui");
    expect(calls).toContain("/video-studio/restart");
    expect(container.textContent).toMatch(/Pixelle is using this|Applying to Pixelle/);
  });
});
