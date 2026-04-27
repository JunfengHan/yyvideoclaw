# yy-Pixelle-Video Provider Plugin

The `yy-pixelle-video` plugin bridges OpenClaw's video-generation contract to a running **[yy-Pixelle-Video](https://github.com/AIDC-AI/Pixelle-Video)** service — an open-source topic→full-short-video engine. Once enabled, any OpenClaw caller (agent, CLI, Gateway client) can produce an integrated short video from a single prompt via the familiar video-generation interface.

A companion change on the Pixelle side lets Pixelle **transparently reuse OpenClaw's LLM providers** (Qwen / OpenAI / Anthropic / Gemini / Ollama / …) through this same Gateway, so users only configure LLM credentials once — inside OpenClaw.

---

## 1. Architecture at a glance

```
┌────────────────────┐   1) POST /api/video/generate/async    ┌────────────────────────┐
│  OpenClaw caller   │ ─────────────────────────────────────► │ yy-Pixelle-Video       │
│ (agent / CLI /     │                                        │ FastAPI service        │
│  chat completions) │ ◄──────── { task_id } ────────────     │                        │
└────────┬───────────┘                                        └─────────┬──────────────┘
         │ 2) GET /api/tasks/{task_id} (poll every 5s)                  │
         │    until completed/failed/cancelled                          │
         │                                                              │
         │                     ╔═════════════════════════════╗          │
         │                     ║ LLM calls (transparent!):    ║          │
         │                     ║   Pixelle LLMService         ║          │
         │                     ║   POST /v1/chat/completions  ║          │
         │                     ║   model:  openclaw/llm-      ║          │
         │                     ║           passthrough        ║          │
         │                     ║   x-openclaw-model: <backend>║          │
         │                     ╚═════════════════════════════╝          │
         │                                                              │
         │ 3) GET result.video_url  (download MP4 buffer)               │
         ▼                                                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│              yyvideoclaw  (OpenClaw Gateway + LLM providers)          │
└────────────────────────────────────────────────────────────────────────┘
```

- **LLM reuse path**: Pixelle's `LLMService` talks to OpenClaw Gateway's `/v1/chat/completions`. OpenClaw dispatches the call to a transparent `llm-passthrough` agent, and the `x-openclaw-model` HTTP header selects the _real_ backend model per-request.
- **Video generation path**: the `yy-pixelle-video` OpenClaw plugin submits an async task to Pixelle, polls `/api/tasks/{id}`, then fetches the resulting MP4 via `result.video_url`.

---

## 2. Prerequisites

- A running **OpenClaw** (yyvideoclaw) install with the Gateway's OpenAI-compatible endpoint enabled.
- A running **yy-Pixelle-Video** service (default: `http://127.0.0.1:8000`).
- An OpenClaw bearer token for the Gateway (`gateway.auth.mode = "token"`).

---

## 3. Startup order

Follow this order to avoid transient health-check failures:

1. **Start OpenClaw Gateway** and verify `/v1/chat/completions` responds (see curl below).
2. **Start yy-Pixelle-Video** (`python api/app.py`) and verify `GET /health` returns 200.
3. **Enable the `yy-pixelle-video` plugin** in your OpenClaw config (it's `enabledByDefault: false`).

### 3.1 Enable Gateway OpenAI-compat + create passthrough agent

Add the following to your OpenClaw user config (`~/.openclaw/config.json5` or equivalent YAML):

```yaml
gateway:
  http:
    listen: "127.0.0.1:18789"
    endpoints:
      chatCompletions:
        enabled: true
  auth:
    mode: "token"
    token: "${OPENCLAW_GATEWAY_TOKEN}" # prefer env injection over literal

agents:
  list:
    - id: "llm-passthrough"
      systemPrompt: "" # transparent: no system-prompt injection
      model: "qwen/qwen-max" # default backend; override per-request
      tools:
        profile: "none"
        alsoAllow: []
      memory: { enabled: false }
      skills: { enabled: false }
      hooks: { enabled: false }
      thinkingDefault: false
      reasoningDefault: false
      compaction: { enabled: false }
      heartbeat: { enabled: false }
```

Quick verification of the link:

```bash
curl -sS -X POST "http://127.0.0.1:18789/v1/chat/completions" \
  -H "Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openclaw/llm-passthrough",
    "messages": [{"role":"user","content":"ping"}],
    "max_tokens": 16
  }'
```

Override the backend model per-request:

```bash
curl -sS -X POST "http://127.0.0.1:18789/v1/chat/completions" \
  -H "Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}" \
  -H "x-openclaw-model: openai/gpt-4o-mini" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw/llm-passthrough","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
```

### 3.2 Enable the `yy-pixelle-video` plugin

In the OpenClaw config, point the provider at your Pixelle service. The plugin config lives under `models.providers["yy-pixelle-video"]`:

```yaml
models:
  providers:
    "yy-pixelle-video":
      endpoint: "http://127.0.0.1:8000" # yy-Pixelle-Video base URL
      # apiKey: "..."                     # only if you front Pixelle with auth
      # pollIntervalMs: 5000              # default 5s
      # timeoutMs: 3000000                # default 50 minutes
```

Because the plugin is `enabledByDefault: false`, you'll also need to opt in from wherever your deployment toggles plugins (typically the `plugins` config section or CLI `--plugin yy-pixelle-video`).

---

## 4. Using it

### 4.1 From an agent / chat

Once enabled, call the video-generation interface with `provider: "yy-pixelle-video"`. The plugin accepts a `prompt` (topic text) and an `aspectRatio`:

| `aspectRatio` | Pixelle `frame_template`                           |
| ------------- | -------------------------------------------------- |
| `"9:16"`      | `1080x1920/image_default.html` (vertical, default) |
| `"16:9"`      | `1920x1080/image_full.html` (landscape)            |
| `"1:1"`       | `1080x1080/image_minimal_framed.html` (square)     |

The plugin returns a single `GeneratedVideoAsset` — in-memory MP4 buffer plus `taskId` / `durationSeconds` / `fileSize` / `sourceUrl` metadata.

### 4.2 Unsupported modes

`imageToVideo` and `videoToVideo` are **explicitly declined** because Pixelle produces full-topic compositions rather than single-clip transforms. Requests carrying `inputImages`/`inputVideos` should use a different provider (e.g. `alibaba`, `runway`, `fal`).

---

## 5. Docker / container deployments

When Pixelle runs in a container and needs to reach the Gateway on the host:

```yaml
# docker-compose.yml (Pixelle side)
services:
  pixelle:
    image: pixelle-video:latest
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      # Pixelle config.yaml llm section — point base_url at the host gateway:
      OPENCLAW_GATEWAY_URL: "http://host.docker.internal:18789/v1"
      OPENCLAW_GATEWAY_TOKEN: "${OPENCLAW_GATEWAY_TOKEN}"
```

In Pixelle's `config.yaml`, set:

```yaml
llm:
  provider: "openclaw"
  base_url: "http://host.docker.internal:18789/v1"
  api_key: "${OPENCLAW_GATEWAY_TOKEN}"
  agent: "openclaw/llm-passthrough"
  model: "qwen/qwen-max"
```

---

## 6. Security boundary

> ⚠️ **The Gateway token is operator-level.** Anyone holding it can spend LLM credits on your account (and, for non-passthrough agents, execute tools). Treat it like an SSH key:

- **Loopback / private network only.** Never expose `:18789` to the public internet.
- For remote Pixelle deployments, tunnel via SSH, WireGuard, or Tailscale. **Do not** publish the Gateway port publicly.
- Inject the token via `${OPENCLAW_GATEWAY_TOKEN}` env interpolation, not plain-text YAML.
- The `llm-passthrough` agent **disables all tools/memory/hooks**; a leaked token granted only via this agent cannot perform file I/O or shell execution through it. Still, it can spend LLM credits — rotate if compromised.

---

## 7. Verifying the end-to-end link

### Option A — quick script (recommended)

Pixelle ships with a standalone verifier:

```bash
# From the yy-Pixelle-Video repo:
python scripts/verify_pixelle_llm.py \
  --base-url http://127.0.0.1:18789/v1 \
  --api-key "$OPENCLAW_GATEWAY_TOKEN" \
  --agent openclaw/llm-passthrough \
  --model qwen/qwen-max
```

Expected output:

```
[verify_pixelle_llm] POST http://127.0.0.1:18789/v1/chat/completions ...
✅ Link OK.
   Reply (truncated): ...
```

### Option B — full live test

With the Gateway, Pixelle, and plugin all running, drive an actual video generation:

```bash
openclaw video-generate \
  --provider yy-pixelle-video \
  --prompt "原子习惯带来复利效应" \
  --aspect 9:16 \
  --output /tmp/pixelle-demo.mp4
```

A small (<1 MB) MP4 should appear after roughly 2–5 minutes (depending on ComfyUI / RunningHub backend speed).

---

## 8. Troubleshooting

| Symptom                                                                                      | Likely cause                                            | Fix                                                                           |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Pixelle logs `OpenClaw mode: gateway=... ; verify Gateway /v1/chat/completions is reachable` | Gateway not running, or wrong `base_url`                | Start Gateway; verify via curl (§3.1).                                        |
| `HTTP 401 / Invalid `x-openclaw-model`.`                                                     | Backend model id mistyped or not configured in OpenClaw | Use the whitelist UI or a valid `provider/model-id`.                          |
| `yy-pixelle-video endpoint is missing or invalid`                                            | `models.providers["yy-pixelle-video"].endpoint` unset   | Set the Pixelle base URL in OpenClaw config.                                  |
| `yy-Pixelle-Video task ... timed out`                                                        | `timeoutMs` too small or Pixelle backend stuck          | Raise `timeoutMs` (default 50 min); inspect Pixelle logs / `/api/tasks/{id}`. |
| MP4 downloads corrupt                                                                        | Proxy / SSL termination in between                      | Keep Pixelle on loopback or tunnel; avoid public HTTP proxies.                |

---

## 9. Related files

- Plugin manifest: [`extensions/yy-pixelle-video/openclaw.plugin.json`](../../extensions/yy-pixelle-video/openclaw.plugin.json)
- Plugin source: [`extensions/yy-pixelle-video/video-generation-provider.ts`](../../extensions/yy-pixelle-video/video-generation-provider.ts)
- Pixelle LLMService: `pixelle_video/services/llm_service.py` (yy-Pixelle-Video repo)
- Pixelle config schema: `pixelle_video/config/schema.py`
- Pixelle UI: `web/components/settings.py` (provider-mode toggle)
