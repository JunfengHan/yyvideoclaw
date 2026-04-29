import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type ProxyOptions } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the bearer token that the Vite dev proxy should present to the
 * local OpenClaw gateway on behalf of the browser. Gateway-owned plugin
 * routes (e.g. `/video-studio/*`) are registered with `auth: "gateway"`
 * and expect the shared `gateway.auth.password`, which is a different
 * credential than the Control-UI device token the SPA normally carries.
 *
 * Resolution order (dev-only):
 *   1. `OPENCLAW_DEV_GATEWAY_TOKEN` — explicit override
 *   2. `gateway.auth.password` read from `OPENCLAW_CONFIG_PATH` if set
 *   3. `gateway.auth.password` read from `<repo>/openclaw.json` as a fallback
 *
 * Returns `null` when no candidate is found; in that case the proxy will
 * simply forward whatever Authorization the browser already attached.
 */
function resolveDevGatewayBearer(): string | null {
  const override = process.env.OPENCLAW_DEV_GATEWAY_TOKEN?.trim();
  if (override) return override;

  const candidates: string[] = [];
  const configEnv = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (configEnv) candidates.push(configEnv);
  // Repo-local fallback: `<repo>/openclaw.json` sits one level above `ui/`.
  candidates.push(path.resolve(here, "..", "openclaw.json"));

  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as {
        gateway?: { auth?: { password?: unknown } };
      };
      const password = parsed.gateway?.auth?.password;
      if (typeof password === "string" && password.trim().length > 0) {
        return password.trim();
      }
    } catch {
      // Try the next candidate; non-existence / parse errors are expected
      // when running outside the monorepo.
    }
  }
  return null;
}

function normalizeBase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed === "./") {
    return "./";
  }
  if (trimmed.endsWith("/")) {
    return trimmed;
  }
  return `${trimmed}/`;
}

/**
 * Build a ProxyOptions that forwards to the local gateway and, when a
 * shared gateway bearer is available, rewrites the outgoing
 * Authorization header so gateway-scoped plugin routes accept the
 * request. Purely a dev-server convenience; production flows use the
 * Control-UI auth chain.
 */
function gatewayProxy(
  target: string,
  bearer: string | null,
  extras: Pick<ProxyOptions, "ws">,
): ProxyOptions {
  const options: ProxyOptions = {
    target,
    changeOrigin: true,
    ws: extras.ws ?? false,
  };
  if (bearer) {
    options.configure = (proxy) => {
      proxy.on("proxyReq", (proxyReq) => {
        proxyReq.setHeader("authorization", `Bearer ${bearer}`);
      });
    };
  }
  return options;
}

export default defineConfig(() => {
  const envBase = process.env.OPENCLAW_CONTROL_UI_BASE_PATH?.trim();
  // Dev default is absolute `/` so that SPA history routes like
  // `/video-studio` resolve `<script src="./assets/xxx.js">` to
  // `/assets/xxx.js` regardless of the current URL. Build output keeps
  // the original behaviour via the envBase path.
  const base = envBase ? normalizeBase(envBase) : "/";
  // Where the local gateway is listening. Aligns with `gateway.port` in
  // openclaw.json (default 18789); override via env if you run multiple
  // gateway instances side-by-side.
  const gatewayPort = Number(process.env.OPENCLAW_DEV_GATEWAY_PORT ?? "18789");
  const gatewayTarget = `http://127.0.0.1:${Number.isFinite(gatewayPort) ? gatewayPort : 18789}`;
  const devBearer = resolveDevGatewayBearer();
  return {
    base,
    publicDir: path.resolve(here, "public"),
    optimizeDeps: {
      include: ["lit/directives/repeat.js"],
    },
    build: {
      outDir: path.resolve(here, "../dist/control-ui"),
      emptyOutDir: true,
      sourcemap: true,
      // Keep CI/onboard logs clean; current control UI chunking is intentionally above 500 kB.
      chunkSizeWarningLimit: 1024,
    },
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      // Forward the gateway-owned paths to the local OpenClaw gateway so the
      // UI served out of the Vite dev server can talk to real backend
      // endpoints (including /video-studio/* exposed by the runtime
      // plugin). `ws: true` covers the gateway WebSocket JSON-RPC channel.
      //
      // For `auth: "gateway"` routes we rewrite Authorization with the
      // shared gateway password so the browser never has to juggle two
      // different tokens in dev. The `/gateway` WS proxy is left alone
      // because the JSON-RPC handshake already carries its own auth
      // payload.
      //
      // IMPORTANT: only proxy the concrete API subpaths (status, install,
      // start, stop, preflight, proxy). The bare `/video-studio` URL is a
      // SPA history route and must fall back to `index.html`, not the
      // JSON status endpoint.
      proxy: {
        "/video-studio/status": gatewayProxy(gatewayTarget, devBearer, { ws: false }),
        "/video-studio/install": gatewayProxy(gatewayTarget, devBearer, { ws: false }),
        "/video-studio/start": gatewayProxy(gatewayTarget, devBearer, { ws: false }),
        "/video-studio/stop": gatewayProxy(gatewayTarget, devBearer, { ws: false }),
        "/video-studio/restart": gatewayProxy(gatewayTarget, devBearer, { ws: false }),
        "/video-studio/preflight": gatewayProxy(gatewayTarget, devBearer, { ws: false }),
        "/video-studio/proxy": gatewayProxy(gatewayTarget, devBearer, { ws: false }),
        "/v1": gatewayProxy(gatewayTarget, devBearer, { ws: false }),
        "/plugins": gatewayProxy(gatewayTarget, devBearer, { ws: false }),
        "/gateway": gatewayProxy(gatewayTarget, null, { ws: true }),
      },
    },
    plugins: [
      {
        name: "control-ui-dev-stubs",
        configureServer(server) {
          server.middlewares.use("/__openclaw/control-ui-config.json", (_req, res) => {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                basePath: "/",
                assistantName: "",
                assistantAvatar: "",
              }),
            );
          });
        },
      },
    ],
  };
});
