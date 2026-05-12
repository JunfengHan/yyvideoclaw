// extensions/remotion-ai/src/engine/codex-launcher.cjs
//
// Tiny CommonJS wrapper that the remotion-ai engine uses to spawn the
// bundled `@openai/codex` CLI with extra environment variables injected
// from a sidecar JSON file. We need a wrapper because:
//
//   1. The codex plugin's `appServer.env` config field exists in its
//      schema but is not yet read by `resolveCodexAppServerRuntimeOptions`,
//      so we can't pipe env through the existing config surface.
//   2. We must NOT mutate the gateway's `process.env` — that would leak
//      our API key to every other plugin and to log captures.
//   3. The codex bin itself is a `bin/codex.js` ESM entry which we
//      already invoke as `node <bin> app-server --listen stdio://`, so
//      adding one more node-level shim adds zero process count.
//
// Protocol:
//   argv = [
//     <node>,                      // process.execPath
//     <this-file>,                 // __filename
//     <env-file>,                  // path to JSON: { env: {...}, clearEnv: [...] }
//     <codex-bin-js>,              // absolute path to @openai/codex bin
//     ...codex args                // e.g. "app-server", "--listen", "stdio://"
//   ]
//
// Behaviour:
//   * Read the env-file; merge `env` into process.env, then unset every
//     key listed in `clearEnv`.
//   * Best-effort delete the env-file once consumed (it contains a
//     bearer token; we don't want it sitting around).
//   * Re-emit argv as `[node, codex-bin-js, ...codex-args]` and spawn
//     codex with stdio inherited so its stdio/JSON-RPC stays intact.
//   * Forward exit code + signals 1:1 so the codex plugin's spawn
//     wrapper sees the same lifecycle it would with a direct spawn.
//
// We deliberately DO NOT use `require()` to load the codex bin in-process
// — codex's bin uses ESM and top-level `process.argv`, so spawning a
// child is both simpler and more correct.

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");

function readEnvFile(envFilePath) {
  let raw;
  try {
    raw = fs.readFileSync(envFilePath, "utf8");
  } catch {
    // Missing env file → run codex with the parent's env unchanged. This
    // is the "auth not configured" case; the failure surfaces inside the
    // codex turn (model returns 401), which our turn_complete handler
    // will project into a user-visible error.
    return { env: {}, clearEnv: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      env: parsed && typeof parsed.env === "object" && parsed.env !== null ? parsed.env : {},
      clearEnv: Array.isArray(parsed?.clearEnv)
        ? parsed.clearEnv.filter((v) => typeof v === "string")
        : [],
    };
  } catch {
    return { env: {}, clearEnv: [] };
  }
}

function tryUnlinkSync(target) {
  try {
    fs.unlinkSync(target);
  } catch {
    // Best-effort cleanup — keep the launcher silent on permission errors.
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    process.stderr.write("codex-launcher: usage: <env-file> <codex-bin-js> [codex args...]\n");
    process.exit(2);
  }
  const envFile = argv[0];
  const codexBin = argv[1];
  const codexArgs = argv.slice(2);

  const { env: extraEnv, clearEnv } = readEnvFile(envFile);
  // Best-effort delete the env-file before spawning so a crashed codex
  // doesn't leave a stale bearer token on disk for longer than necessary.
  tryUnlinkSync(envFile);

  const childEnv = { ...process.env };
  for (const key of clearEnv) {
    delete childEnv[key];
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (typeof value === "string") {
      childEnv[key] = value;
    }
  }

  const child = spawn(process.execPath, [codexBin, ...codexArgs], {
    stdio: "inherit",
    env: childEnv,
  });

  // Forward signals 1:1 so the orchestrator's AbortSignal → codex.abort()
  // chain still works end-to-end. We don't translate; if the parent gets
  // SIGINT we hand it to codex unchanged.
  const forwardSignal = (sig) => {
    if (!child.killed) {
      try {
        child.kill(sig);
      } catch {
        // ignore
      }
    }
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) {
      // Match the child's signal exit semantics: re-raise the same signal
      // on ourselves so our parent observes the canonical exit code.
      process.kill(process.pid, signal);
      return;
    }
    process.exit(typeof code === "number" ? code : 0);
  });
  child.on("error", (err) => {
    process.stderr.write(
      `codex-launcher: spawn failed: ${String(err && err.message ? err.message : err)}\n`,
    );
    process.exit(127);
  });
}

main();
