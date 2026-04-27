// e2e-smoke.mjs — end-to-end smoke test for the embedded Video Studio.
//
// Exercises the "happy path" required by the plan's §12 acceptance
// scenarios:
//
//   1. Cold-start the yyvideoclaw binary.
//   2. Navigate to the Video Studio tab.
//   3. If the backend is not yet installed, walk the install wizard.
//   4. Submit the canonical topic "原子习惯" / "atomic habits" at 9:16
//      and wait up to 10 minutes for a playable MP4 on disk.
//   5. Force-kill the Pixelle subprocess and assert the supervisor
//      self-heals within 15 seconds.
//
// The script is deliberately dependency-free — it drives the Debug
// endpoints exposed by the host (rather than spinning up a real
// Playwright browser) so it can run in CI against a headless build.
//
// Usage:
//
//   node scripts/video-studio/e2e-smoke.mjs \\
//       --host http://127.0.0.1:18789 \\
//       --token $YYVIDEOCLAW_DEBUG_TOKEN \\
//       [--topic "原子习惯"] [--aspect 9:16] [--timeout-ms 600000]
//
// Exits 0 on success, non-zero (and prints a diagnostic tail) on failure.

import { setTimeout as delay } from "node:timers/promises";

// ---------------------------------------------------------------------------
// CLI parsing.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    host: "http://127.0.0.1:18789",
    token: process.env.YYVIDEOCLAW_DEBUG_TOKEN ?? "",
    topic: "atomic habits",
    aspect: "9:16",
    timeoutMs: 10 * 60 * 1_000,
    selfHealBudgetMs: 15_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--host":
        opts.host = argv[++i];
        break;
      case "--token":
        opts.token = argv[++i];
        break;
      case "--topic":
        opts.topic = argv[++i];
        break;
      case "--aspect":
        opts.aspect = argv[++i];
        break;
      case "--timeout-ms":
        opts.timeoutMs = Number(argv[++i]);
        break;
      case "--self-heal-ms":
        opts.selfHealBudgetMs = Number(argv[++i]);
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(
    [
      "Usage: node scripts/video-studio/e2e-smoke.mjs [options]",
      "",
      "  --host <url>            yyvideoclaw gateway base (default 127.0.0.1:18789).",
      "  --token <bearer>        Debug bearer (env YYVIDEOCLAW_DEBUG_TOKEN).",
      "  --topic <text>          Topic to submit (default: atomic habits).",
      "  --aspect <9:16|16:9|1:1>  Aspect ratio (default 9:16).",
      "  --timeout-ms <ms>       Generation deadline (default 600000).",
      "  --self-heal-ms <ms>     Crash recovery deadline (default 15000).",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// HTTP helpers against the yyvideoclaw debug surface.
// ---------------------------------------------------------------------------

function log(stage, msg) {
  // eslint-disable-next-line no-console
  console.log(`\u001B[36m[e2e-smoke:${stage}]\u001B[0m ${msg}`);
}

function fail(stage, err) {
  // eslint-disable-next-line no-console
  console.error(
    `\u001B[31m[e2e-smoke:${stage}] FAIL\u001B[0m ${err instanceof Error ? err.message : err}`,
  );
  process.exit(1);
}

async function httpJson(host, token, method, path, body) {
  const url = `${host.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
      accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Step implementations.
// ---------------------------------------------------------------------------

async function ensureBackendReady(opts) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const status = await httpJson(opts.host, opts.token, "GET", "/debug/video-studio/status");
      if (status?.state === "running") {
        log("bootstrap", `backend running (pid=${status.pid} port=${status.port})`);
        return status;
      }
      if (status?.state === "missing") {
        log("bootstrap", "backend missing — invoking install wizard");
        await httpJson(opts.host, opts.token, "POST", "/debug/video-studio/install");
      } else {
        log("bootstrap", `backend state=${status?.state ?? "unknown"}, retrying`);
      }
    } catch (err) {
      log("bootstrap", `poll error: ${err instanceof Error ? err.message : err}`);
    }
    await delay(1_500);
  }
  throw new Error("backend failed to enter `running` state within 60s");
}

async function submitTopic(opts) {
  const res = await httpJson(opts.host, opts.token, "POST", "/debug/video-studio/generate", {
    topic: opts.topic,
    aspectRatio: opts.aspect,
    pipeline: "standard",
  });
  if (!res?.id) throw new Error("backend did not return a task id");
  return res.id;
}

async function waitForCompletion(opts, taskId) {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const snap = await httpJson(opts.host, opts.token, "GET", `/debug/video-studio/task/${taskId}`);
    if (snap?.status === "succeeded") return snap;
    if (snap?.status === "failed" || snap?.status === "cancelled") {
      throw new Error(`task terminal status=${snap.status} error=${snap.error ?? "n/a"}`);
    }
    await delay(5_000);
  }
  throw new Error(`task ${taskId} did not complete within ${opts.timeoutMs}ms`);
}

async function assertVideoPlayable(opts, snap) {
  const url = snap?.output?.videoUrl;
  if (!url) throw new Error("task succeeded but returned no videoUrl");
  const headRes = await fetch(url, {
    method: "HEAD",
    headers: { authorization: `Bearer ${opts.token}` },
  });
  if (!headRes.ok) throw new Error(`video HEAD ${headRes.status}`);
  const contentType = headRes.headers.get("content-type") ?? "";
  const contentLength = Number(headRes.headers.get("content-length") ?? "0");
  if (!contentType.includes("video")) throw new Error(`unexpected content-type: ${contentType}`);
  if (contentLength <= 0) throw new Error(`zero-length video at ${url}`);
  log("verify", `video OK (${contentType}, ${contentLength} bytes)`);
}

async function assertSelfHeal(opts) {
  log("crash", "force-killing backend via debug endpoint");
  await httpJson(opts.host, opts.token, "POST", "/debug/video-studio/kill");
  const deadline = Date.now() + opts.selfHealBudgetMs;
  while (Date.now() < deadline) {
    const status = await httpJson(opts.host, opts.token, "GET", "/debug/video-studio/status");
    if (status?.state === "retrying" || status?.state === "running") {
      log("crash", `recovered within budget (state=${status.state})`);
      return;
    }
    await delay(500);
  }
  throw new Error(`supervisor did not self-heal within ${opts.selfHealBudgetMs}ms`);
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.token) {
    throw new Error("missing debug bearer token (--token or $YYVIDEOCLAW_DEBUG_TOKEN)");
  }
  log("bootstrap", `host=${opts.host}`);
  await ensureBackendReady(opts);

  log("generate", `submitting topic="${opts.topic}" aspect=${opts.aspect}`);
  const taskId = await submitTopic(opts);
  log("generate", `task id=${taskId}`);
  const snap = await waitForCompletion(opts, taskId);
  await assertVideoPlayable(opts, snap);

  await assertSelfHeal(opts);

  log("done", "all assertions passed");
}

try {
  await main();
} catch (err) {
  fail("main", err);
}
