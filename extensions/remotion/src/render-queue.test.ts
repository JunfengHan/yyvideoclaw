import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RenderProtocolError,
  RenderQueue,
  RenderTimeoutError,
  RenderWorkerError,
} from "./render-queue.js";

// We exercise the queue with ultra-small hand-rolled worker scripts so the
// unit tests never need Remotion, Chromium, or FFmpeg.

const tempDirs: string[] = [];

async function makeWorker(source: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-remotion-worker-"));
  tempDirs.push(dir);
  const file = path.join(dir, "fake-worker.mjs");
  await fs.writeFile(file, source, "utf8");
  return file;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("RenderQueue", () => {
  it("forwards list-compositions result", async () => {
    const worker = await makeWorker(`
      process.stdin.resume();
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({
          kind: "list-compositions",
          compositions: [{ id: "Hello", width: 1920, height: 1080, fps: 30, durationInFrames: 90 }],
        }) + "\\n");
        process.exit(0);
      });
      let buf = "";
      process.stdin.on("data", (c) => { buf += c; });
    `);
    const queue = new RenderQueue({ jobTimeoutMs: 5000, workerPath: worker });
    const list = await queue.enqueueList({
      entryPoint: "/tmp/x",
      allowNetwork: false,
    });
    expect(list).toEqual([
      { id: "Hello", width: 1920, height: 1080, fps: 30, durationInFrames: 90 },
    ]);
  });

  it("reports worker-error messages as RenderWorkerError", async () => {
    const worker = await makeWorker(`
      process.stdin.resume();
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ kind: "worker-error", message: "simulated boom" }) + "\\n");
        process.exit(1);
      });
      process.stdin.on("data", () => {});
    `);
    const queue = new RenderQueue({ jobTimeoutMs: 5000, workerPath: worker });
    await expect(
      queue.enqueueList({ entryPoint: "/tmp/x", allowNetwork: false }),
    ).rejects.toBeInstanceOf(RenderWorkerError);
  });

  it("rejects non-JSON stdout with RenderProtocolError", async () => {
    const worker = await makeWorker(`
      process.stdin.resume();
      process.stdin.on("end", () => {
        process.stdout.write("this is not json\\n");
        process.exit(0);
      });
      process.stdin.on("data", () => {});
    `);
    const queue = new RenderQueue({ jobTimeoutMs: 5000, workerPath: worker });
    await expect(
      queue.enqueueList({ entryPoint: "/tmp/x", allowNetwork: false }),
    ).rejects.toBeInstanceOf(RenderProtocolError);
  });

  it("kills workers that exceed the timeout", async () => {
    const worker = await makeWorker(`
      process.stdin.resume();
      // Never respond; keep the event loop alive so we can be killed.
      setInterval(() => {}, 1000);
    `);
    const queue = new RenderQueue({ jobTimeoutMs: 150, workerPath: worker });
    await expect(
      queue.enqueueList({ entryPoint: "/tmp/x", allowNetwork: false }),
    ).rejects.toBeInstanceOf(RenderTimeoutError);
  }, 10_000);

  it("serialises concurrent jobs (concurrency=1)", async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-remotion-serial-"));
    tempDirs.push(logDir);
    const logFile = path.join(logDir, "events.log");
    const worker = await makeWorker(`
      import { appendFileSync } from "node:fs";
      process.stdin.resume();
      let buf = "";
      process.stdin.on("data", (c) => { buf += c; });
      process.stdin.on("end", async () => {
        appendFileSync(${JSON.stringify(logFile)}, "START " + process.pid + "\\n");
        await new Promise(r => setTimeout(r, 80));
        appendFileSync(${JSON.stringify(logFile)}, "END " + process.pid + "\\n");
        process.stdout.write(JSON.stringify({
          kind: "list-compositions",
          compositions: [],
        }) + "\\n");
        process.exit(0);
      });
    `);
    const queue = new RenderQueue({ jobTimeoutMs: 5000, workerPath: worker });

    const [a, b, c] = await Promise.all([
      queue.enqueueList({ entryPoint: "/tmp/a", allowNetwork: false }),
      queue.enqueueList({ entryPoint: "/tmp/b", allowNetwork: false }),
      queue.enqueueList({ entryPoint: "/tmp/c", allowNetwork: false }),
    ]);
    expect([a, b, c]).toEqual([[], [], []]);

    // The log must alternate START/END; no two STARTs may be back-to-back.
    const lines = (await fs.readFile(logFile, "utf8")).trim().split("\n");
    let open = 0;
    for (const line of lines) {
      if (line.startsWith("START")) {
        open += 1;
        expect(open).toBe(1); // concurrency invariant
      } else {
        open -= 1;
      }
    }
    expect(open).toBe(0);
  }, 10_000);

  it("does not poison the queue when a job throws", async () => {
    const worker = await makeWorker(`
      process.stdin.resume();
      let buf = "";
      process.stdin.on("data", (c) => { buf += c; });
      process.stdin.on("end", () => {
        const input = JSON.parse(buf.trim());
        if (input.entryPoint === "/tmp/fail") {
          process.stdout.write(JSON.stringify({ kind: "worker-error", message: "fail" }) + "\\n");
          process.exit(1);
        }
        process.stdout.write(JSON.stringify({
          kind: "list-compositions",
          compositions: [{ id: "ok", width: 1, height: 1, fps: 1, durationInFrames: 1 }],
        }) + "\\n");
        process.exit(0);
      });
    `);
    const queue = new RenderQueue({ jobTimeoutMs: 5000, workerPath: worker });
    await expect(
      queue.enqueueList({ entryPoint: "/tmp/fail", allowNetwork: false }),
    ).rejects.toBeInstanceOf(RenderWorkerError);
    const ok = await queue.enqueueList({ entryPoint: "/tmp/ok", allowNetwork: false });
    expect(ok).toEqual([{ id: "ok", width: 1, height: 1, fps: 1, durationInFrames: 1 }]);
  }, 10_000);
});
