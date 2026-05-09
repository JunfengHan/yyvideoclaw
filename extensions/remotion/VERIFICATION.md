# Remotion Plugin — Phase 1 Verification Playbook

This document is the canonical "how do I prove the POC works" guide. It
captures the exact commands and acceptance criteria for each verification
tier. Reproduce all four tiers before considering Phase 1 done; rerun the
relevant tier after any change to render or security paths.

> All paths assume the repo root is the workspace. Replace
> `<repo>` with the actual absolute path when copying commands.

---

## Tier 1 — Automated unit / lint / typecheck

Fastest, no Chromium needed. Verifies plugin contract, schema, security
helpers, and queue logic with mocked workers.

```bash
# Unit tests (50 cases)
pnpm test extensions/remotion

# Lint (must produce zero remotion-specific findings)
pnpm lint:extensions 2>&1 | grep extensions/remotion   # → empty

# Prod typecheck (must produce zero remotion-specific errors)
pnpm tsgo:prod 2>&1 | grep extensions/remotion         # → empty
```

**Pass criteria**: 50/50 tests green, both greps return no output.

---

## Tier 2 — Source-mode end-to-end (vitest e2e lane)

Exercises the full pipeline against the live `@remotion/bundler` +
`@remotion/renderer` chain, but reads the plugin from source (`*.ts`
under `extensions/remotion/src/`). Uses the fixture under
`test/e2e/fixtures/minimal-project/`.

```bash
# First-time only — install Remotion + Chromium (≈1–2 min)
cd extensions/remotion && pnpm install && cd ../..

# Run the e2e lane (NOT `pnpm vitest run` — the default lane excludes e2e files)
OPENCLAW_REMOTION_E2E=1 OPENCLAW_E2E_VERBOSE=1 \
  pnpm test:e2e extensions/remotion/test/e2e/render.e2e.test.ts

# Optional: keep outputs around so you can `open` the produced mp4
OPENCLAW_REMOTION_E2E=1 OPENCLAW_REMOTION_E2E_KEEP=1 OPENCLAW_E2E_VERBOSE=1 \
  pnpm test:e2e extensions/remotion/test/e2e/render.e2e.test.ts
```

**Pass criteria**: 2/2 tests green; with `KEEP=1`, the printed temp dir
contains a `<jobId>/out.mp4` of nonzero bytes that plays in any video
player.

---

## Tier 3 — Production-dist smoke (real plugin pipeline)

Verifies the **packaged build** that OpenClaw actually loads at runtime,
including:

- `dist/extensions/remotion/index.js` (bundled plugin entry)
- `dist/extensions/remotion/src/render-worker.js` (independent worker entry)
- `dist/extensions/remotion/node_modules/...` (staged Remotion deps)

```bash
# 1) Build the plugin (and the rest of the dist tree)
pnpm build

# 2) Verify discovery: openclaw should list the plugin as `loaded`
pnpm openclaw plugins list 2>&1 | grep -i remotion
# Expected: a row with status `loaded` and source `stock:remotion/index.js`

pnpm openclaw plugins inspect remotion 2>&1 | grep -E "Status|Tools" -A 3
# Expected:
#   Status: loaded
#   Tools:
#   remotion_list_compositions
#   remotion_render_video
#   remotion_render_still

# 3) Drive the built plugin directly (bypasses the agent, fastest signal):
node - <<'EOF'
import("/Users/johnhan/Desktop/myself/yyvideoclaw/dist/extensions/remotion/index.js").then(async (m) => {
  const plugin = m.default ?? m;
  const tools = [];
  await plugin.register({
    pluginConfig: {
      templateRoots: ["<repo>/extensions/remotion/test/e2e/fixtures/minimal-project"],
      outputDir: "/tmp/openclaw-remotion-smoke",
      jobTimeoutMs: 5 * 60 * 1000,
      maxOutputBytes: 50 << 20,
      allowNetwork: false,
    },
    logger: { info: console.log, warn: console.warn, error: console.error, debug: () => {} },
    registerTool: (t) => tools.push(t),
    registerCommand: () => {}, registerHook: () => {}, registerService: () => {},
    registerHttpRoute: () => {}, config: {}, runtime: {},
  });
  const tool = tools.find((t) => t.name === "remotion_render_video");
  const result = await tool.execute("smoke", {
    entryPoint: "<repo>/extensions/remotion/test/e2e/fixtures/minimal-project/src/index.ts",
    compositionId: "HelloWorld",
    inputProps: { tint: "#22c55e" },
  });
  console.log(result);
});
EOF

# 4) Open the produced mp4 (macOS)
open /tmp/openclaw-remotion-smoke/*/out.mp4
```

**Pass criteria**: `Status: loaded`; the inline node script returns
`isError: undefined` and a body containing `outputPath`, `sizeBytes > 0`;
the mp4 plays.

### Enabling the plugin in the live agent

Edit `~/.openclaw/openclaw.json` and add (or merge):

```jsonc
{
  "plugins": {
    "entries": {
      "remotion": {
        "enabled": true,
        "config": {
          "templateRoots": ["/absolute/path/to/your/remotion/project"],
          "jobTimeoutMs": 300000,
          "maxOutputBytes": 52428800,
          "allowNetwork": false,
        },
      },
    },
  },
}
```

> `templateRoots` MUST be absolute paths. Relative paths are rejected at
> config time and the plugin disables itself.

Then in an agent session:

- `用 remotion_list_compositions 列出 <abs path>/src/index.ts 里的 compositions`
- `用 remotion_render_still 渲染 HelloWorld 第 0 帧 PNG`
- `用 remotion_render_video 渲染 HelloWorld，inputProps 用 {"tint":"#3b82f6"}`

---

## Tier 4 — Security boundary attack matrix

Every entry must be rejected by the plugin (or never registered at all).
These are exercised against the **production dist** to ensure the
hardening survives bundling.

| #   | Attack                                       | Expected defense                                                                                          |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | `entryPoint: ".../../../etc/passwd"`         | rejected at `realpath` or allowlist check                                                                 |
| 2   | `entryPoint: "/etc/hosts"` (outside)         | `template rejected (not-in-allowlist)`                                                                    |
| 3   | `templateRoots: ["./relative"]`              | plugin refuses to register; no tools appear                                                               |
| 4   | Prefix attack `/tmp/proj` ↔ `/tmp/proj-evil` | `not-in-allowlist`                                                                                        |
| 5   | `jobTimeoutMs: 500` while rendering          | SIGKILL + `RenderTimeoutError` within < 5s                                                                |
| 6   | `maxOutputBytes: 1024` produces ≫1KB         | output deleted, `output size N exceeds maxOutputBytes 1024`                                               |
| 7   | Set `OPENAI_API_KEY=…` in parent env         | worker env contains only `PATH HOME TMPDIR LANG LC_ALL TZ REMOTION_DISABLE_TELEMETRY` (no leaked secrets) |

The tier-4 verification scripts under `/tmp/test-remotion-{security,env}.mjs`
in your last verification run encapsulate these checks; copy them into
the repo if you want them committed long-term.

**Pass criteria**: all 7 cases produce defensive outcomes — none allow
the worker to read sensitive paths or env, render past the timeout, or
return an oversized artifact.
