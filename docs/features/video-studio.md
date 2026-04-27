# Video Studio

> Topic-to-video generator embedded as a first-class tab inside yyvideoclaw.
> Powered by the upstream [`yy-Pixelle-Video`](https://github.com/JunfengHan/yy-Pixelle-Video)
> project, wrapped as a managed subprocess so you never have to start a
> separate service.

## What it does

Give Video Studio a topic (e.g. "atomic habits") and it produces a short,
captioned vertical or horizontal video by orchestrating:

1. **Title generation** — a short headline from the topic.
2. **Narration** — a long-form script.
3. **Images** — visual prompts per beat.
4. **Frames** — HTML-templated captioned frames.
5. **TTS** — voice-over for the narration.
6. **Compose** — stitched MP4 with background music.

Every LLM call is routed through yyvideoclaw's transparent
`llm-passthrough` agent, so you can reuse any model already configured in
yyvideoclaw (Qwen, GPT, Claude, …) — no extra API keys required.

## Install

Video Studio is enabled out of the box. On first use:

1. Pick **🎬 Video Studio** from the left sidebar (under the _agent_ group).
2. If the card shows **"Video Studio backend is not installed"**, click
   **Install** — the runtime plugin provisions a managed Python virtualenv
   via `uv` under `~/.openclaw/video-studio/venv/` and installs the sibling
   `yy-Pixelle-Video` checkout in editable mode.
3. The **Backend Status** polls every 3 seconds; once it flips from
   `starting` to `ready`, the five-section studio layout renders and the
   frame-template dropdown populates itself.

Preflight probes FFmpeg + Chromium/Playwright availability and surfaces
per-platform install hints if either is missing.

Cold-start budget on first use is typically ≤ 8 s on an M-series laptop
once the venv is cached.

## Use

1. Pick **Video Studio** from the left sidebar.
2. Fill in a **title** (optional) and **narration** prompt.
3. Pick an **aspect ratio** (9:16 / 16:9 / 1:1) and optionally a
   **frame template**.
4. Choose a **pipeline** (`standard` is the best default).
5. Click **Generate** and watch the live progress panel.
6. When the task reaches **succeeded**, the result section renders an
   inline `<video>` player plus **Download / Copy link / Open in Finder
   / Regenerate** buttons.

Past runs show up in the **History** sidebar; click any entry to load
its output back into the result pane.

## Settings reference

| Setting                   | Description                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Enable Video Studio       | Master toggle. Persisted as `videoStudio.enabled`.                                                                           |
| Default LLM Model         | Any LLM-capable model from yyvideoclaw. Changing it restarts the Pixelle subprocess automatically. Default: `qwen/qwen-max`. |
| Default Aspect Ratio      | `9:16` / `16:9` / `1:1`.                                                                                                     |
| Default Pipeline          | `standard` (default) / `asset-based` / `linear` / `custom`.                                                                  |
| Default Frame Template    | Template key or blank to let Pixelle pick.                                                                                   |
| Auto-stop after (minutes) | Stop the Pixelle subprocess after N minutes of idle time. `0` keeps it running. Default: `30`.                               |

## Uninstall

**Settings → Video Studio → Uninstall** removes the entire
`<userData>/video-studio/` directory (venv, generated media, caches).
Subsequent yyvideoclaw launches behave as if the feature was never
installed.

## Troubleshooting

| Symptom                                 | Next step                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| "Video backend failed to start" card    | Click **View logs** — jumps to the Logs tab with `source=video-studio`.      |
| Stuck on "Starting…" for more than 30 s | Re-run preflight; FFmpeg or Playwright likely missing.                       |
| "Task failed" with a model quota error  | Switch Default LLM Model in Settings; save triggers a restart.               |
| Weird output frames                     | Try a different **Frame Template**; your topic may not suit the current one. |

For deeper issues, open the **Debug** tab's **Video Studio** panel and
click **Copy diagnostics** — the bundle is pre-redacted of tokens and
safe to attach to a bug report.

## FAQ

**Does Video Studio talk to the internet directly?** The Pixelle
subprocess binds loopback only. All LLM traffic flows through
yyvideoclaw's Gateway, which honours your existing provider + egress
policies.

**Where do my generated videos live?** Under
`<userData>/video-studio/outputs/`. This directory is sandboxed by
`HostEnvSecurityPolicy` — nothing outside Video Studio may write here.

**Can I still use the upstream Pixelle project standalone?** Yes —
`yy-Pixelle-Video` keeps its independent mode intact. The OpenClaw
provider we contributed is opt-in via `PIXELLE_LLM_PROVIDER=openclaw`.

## Architecture

Video Studio is wired end-to-end across four cooperating layers so UI
actions actually move bytes on disk:

```text
+-----------------------------------------------------------------+
|  ui/src/ui/views/video-studio-view.ts   (Lit render, no I/O)    |
|  └─ reads state.videoStudio* / fires callbacks                   |
+----------------------------------|------------------------------+
                                   v
+-----------------------------------------------------------------+
|  ui/src/ui/controllers/video-studio.ts                          |
|  └─ install / start / stop / generate / poll / mapping helpers  |
|  └─ auth candidates + basePath same-origin fetch                |
+----------------------------------|------------------------------+
                                   v  HTTP over gateway (same-origin)
+-----------------------------------------------------------------+
|  extensions/video-studio/index.ts   (runtime plugin)            |
|  └─ /video-studio/status|install|start|stop|preflight           |
|  └─ /video-studio/proxy/*   →  Pixelle loopback /api/*          |
+----------------------------------|------------------------------+
                                   v
+-----------------------------------------------------------------+
|  src/video-studio/*     (PixelleBackendSupervisor + Installer)  |
|  └─ spawns api/app.py with EMBEDDED_MODE=1 on ephemeral port    |
+-----------------------------------------------------------------+
```

Key properties of the wiring:

- **Single HTTP surface**: `/video-studio/*` is the _only_ new endpoint
  group. Everything else (auth, same-origin, basePath) reuses the exact
  same helpers as the bootstrap loader.
- **Ephemeral internal token**: the browser never sees the Pixelle
  loopback bearer. The plugin attaches it server-side inside
  `handleProxy`, so an XSS can't exfiltrate the token.
- **Tab-gated polling**: status polls at 3 s only while the user is on
  the Video Studio tab; generate polls at 2 s only until the task
  reaches a terminal status.
- **Dependency direction** is strictly one-way: view → controller →
  plugin → supervisor → Pixelle. No back-edge imports.

## See also

- [Architecture requirements](../../.codebuddy/plan/pixelle-video-integration/requirements.md)
- [SECURITY.md → Video Studio](../../SECURITY.md#video-studio-embedded-pixelle-backend)
