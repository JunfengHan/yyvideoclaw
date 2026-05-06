// Gateway HTTP endpoint that writes the embedded Pixelle-Video
// config.yaml on behalf of the Control UI.
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import YAML from "yaml";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { sendGatewayAuthFailure, sendJson } from "./http-common.js";
import { getBearerToken, resolveHttpBrowserOriginPolicy } from "./http-utils.js";

const PIXELLE_COMFYUI_CONFIG_ROUTE = "/video-studio/config/comfyui";
const MAX_BODY_BYTES = 8 * 1024;

function resolveScopedPath(pathname: string, controlUiBasePath: string): string | null {
  if (pathname === PIXELLE_COMFYUI_CONFIG_ROUTE) {
    return pathname;
  }
  const normalizedBase = controlUiBasePath.trim().replace(/\/+$/, "");
  if (!normalizedBase || normalizedBase === "/") {
    return null;
  }
  const scoped = `${normalizedBase}${PIXELLE_COMFYUI_CONFIG_ROUTE}`;
  return pathname === scoped ? scoped : null;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function resolvePixelleConfigPath(): Promise<string | null> {
  const overrideRoot = process.env.PIXELLE_VIDEO_ROOT?.trim();
  if (overrideRoot) {
    const overridePath = path.join(overrideRoot, "config.yaml");
    if (await fileExists(overridePath)) {
      return overridePath;
    }
  }

  let current = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(current, "vendor", "pixelle-video", "config.yaml");
    if (await fileExists(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

function isSafeLoopbackComfyUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function writeComfyUiUrl(configPath: string, comfyuiUrl: string): Promise<void> {
  let text = "";
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch {
    text = "";
  }
  const existing = (text.length > 0 ? YAML.parse(text) : {}) ?? {};
  const base = (
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>;
  const comfy = (
    base.comfyui && typeof base.comfyui === "object" && !Array.isArray(base.comfyui)
      ? (base.comfyui as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>;
  comfy.comfyui_url = comfyuiUrl;
  const next: Record<string, unknown> = {
    ...base,
    comfyui: comfy,
  };
  const serialized = YAML.stringify(next);
  await fs.writeFile(configPath, serialized, "utf8");
}

export async function handlePixelleComfyUiConfigRequest(opts: {
  req: IncomingMessage;
  res: ServerResponse;
  controlUiBasePath?: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
}): Promise<boolean> {
  const url = new URL(opts.req.url ?? "/", "http://localhost");
  const scoped = resolveScopedPath(url.pathname, opts.controlUiBasePath ?? "");
  if (scoped === null) {
    return false;
  }

  if (opts.req.method !== "POST") {
    sendJson(opts.res, 405, {
      ok: false,
      error: { type: "method_not_allowed", message: "POST required." },
    });
    return true;
  }

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

  let raw = "";
  try {
    raw = await readRequestBody(opts.req);
  } catch {
    sendJson(opts.res, 413, {
      ok: false,
      error: { type: "payload_too_large", message: "Request body too large." },
    });
    return true;
  }

  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    sendJson(opts.res, 400, {
      ok: false,
      error: { type: "invalid_json", message: "Request body must be JSON." },
    });
    return true;
  }
  const body =
    (parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null) ?? {};
  const comfyuiUrl = body.comfyuiUrl;
  if (!isSafeLoopbackComfyUrl(comfyuiUrl)) {
    sendJson(opts.res, 400, {
      ok: false,
      error: {
        type: "invalid_comfyui_url",
        message: "comfyuiUrl must be a loopback http(s) URL (127.0.0.1 / localhost).",
      },
    });
    return true;
  }

  const configPath = await resolvePixelleConfigPath();
  if (!configPath) {
    sendJson(opts.res, 503, {
      ok: false,
      error: {
        type: "pixelle_config_not_found",
        message:
          "vendor/pixelle-video/config.yaml not found. Set PIXELLE_VIDEO_ROOT or run from the project root.",
      },
    });
    return true;
  }

  try {
    await writeComfyUiUrl(configPath, comfyuiUrl.trim());
  } catch (err) {
    sendJson(opts.res, 500, {
      ok: false,
      error: {
        type: "write_failed",
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return true;
  }

  sendJson(opts.res, 200, {
    ok: true,
    configPath,
    comfyuiUrl: comfyuiUrl.trim(),
    restartRequired: true,
  });
  return true;
}
