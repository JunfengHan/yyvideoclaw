# OpenClaw Remotion Plugin

**Status: POC (Phase 1).** Exposes Remotion rendering to the OpenClaw agent as
tools, without any UI integration. Do not use this in production yet — the
sandbox boundary described below is deliberately minimal.

## What it does

Registers three agent tools that drive [Remotion](https://www.remotion.dev/):

- `remotion_list_compositions` — list `<Composition>`s in a Remotion project.
- `remotion_render_video` — render a composition to an MP4.
- `remotion_render_still` — render a single frame to PNG/JPEG.

Renders happen in an isolated child Node process; outputs land in
`~/.openclaw/remotion/outputs/<jobId>/` by default.

## Why this design

Remotion projects are ordinary TypeScript/React codebases — rendering one is
equivalent to executing the project's code. Because we explicitly support the
case where users upload or edit those projects, every entry point must live
inside an **allowlist of absolute directories** that the operator configures
up front. Nothing outside those roots can be used as a render entry point, and
the renderer runs in a separate process with a sanitized environment so a
misbehaving composition cannot trivially read OpenClaw credentials or write
outside the plugin's output directory.

## Configuration

Configure via the normal OpenClaw plugin config mechanism
(`openclaw.plugin.json` → `configSchema`). Example:

```jsonc
{
  "remotion": {
    // REQUIRED. Absolute directories. Any entryPoint passed to a tool must
    // resolve (realpath) to a descendant of one of these roots.
    "templateRoots": ["/Users/me/remotion-templates", "/Users/me/my-video-projects"],

    // OPTIONAL. Defaults shown.
    "outputDir": "~/.openclaw/remotion/outputs",
    "cacheDir": "~/.openclaw/remotion/cache",
    "jobTimeoutMs": 600000, // 10 minutes
    "maxOutputBytes": 524288000, // 500 MiB
    "allowNetwork": false, // block Chromium network by default
    "chromiumExecutablePath": null, // use @remotion/renderer bundled binary
  },
}
```

Note: `~` is **not** expanded. The plugin requires absolute paths for every
directory field so that the allowlist cannot be bypassed via ambient CWD.

## Security boundaries (POC)

This phase enforces the following:

1. **Template allowlist.** `templateRoots` is required and must be a list of
   absolute directories. Every tool call resolves the user-supplied
   `entryPoint` with `fs.realpath` and rejects anything that does not live
   strictly inside one of those roots.
2. **Output scope lock.** All writes go under `config.outputDir/<jobId>/`.
   The plugin never writes anywhere else.
3. **Separate render process.** Each job runs in a fresh
   `child_process.spawn` Node subprocess; no render code executes in the main
   OpenClaw process.
4. **Environment scrubbed.** The render subprocess inherits only a
   hand-picked set of env vars (`PATH`, `HOME`, `TMPDIR`, `LANG`, `TZ`). No
   OpenClaw credentials, API keys, or agent secrets are forwarded.
5. **Network off by default.** Unless `allowNetwork: true`, the headless
   Chromium launched by Remotion is started with a `--proxy-server` that
   rejects all traffic.
6. **Hard timeout.** Jobs exceeding `jobTimeoutMs` are `SIGKILL`ed and their
   partial outputs removed.
7. **Output size cap.** Outputs larger than `maxOutputBytes` are deleted and
   the job fails.
8. **Concurrency = 1.** Jobs run serially in POC; no queuing UI yet.
9. **`spawn(cmd, args[])` only.** Commands are never built with string
   concatenation, preventing shell-injection.
10. **Log redaction.** `inputProps` are never logged by value — only their
    top-level key names and total JSON byte size.

### What this POC does **not** yet provide

- Container isolation (Docker / gVisor). A malicious composition can still
  burn CPU, exhaust memory, or probe the local filesystem within the
  subprocess's own permissions.
- Persistent job history or resumable renders.
- Video Studio UI integration (Phase 3).
- `VideoGenerationProvider` registration (Phase 2).

## Development

Disabled by default (`enabledByDefault: false` in the manifest). Enable it in
your OpenClaw config when you want to try it out.

### Running unit tests

```bash
pnpm test extensions/remotion
```

No Chromium required — the render queue is mocked with a fake worker.

### Running the end-to-end smoke test

The e2e test under `test/e2e/` is gated twice: by filename (`*.e2e.test.ts`,
excluded from the default vitest lane) and by env var (`OPENCLAW_REMOTION_E2E`).
To actually run it:

```bash
# 1) First-time only: install Remotion + @remotion/bundler + @remotion/renderer
cd extensions/remotion && pnpm install && cd ../..

# 2) Run via the e2e config (NOT `pnpm vitest run`, which will report
#    "No test files found" because of the default exclude list)
OPENCLAW_REMOTION_E2E=1 OPENCLAW_E2E_VERBOSE=1 \
  pnpm test:e2e extensions/remotion/test/e2e/render.e2e.test.ts
```

The test launches headless Chromium, renders the `HelloWorld` composition to
an MP4 in a temp directory, and asserts the file exists and is non-empty. It
typically takes 10-60 seconds depending on the host and whether Chromium is
already cached.
