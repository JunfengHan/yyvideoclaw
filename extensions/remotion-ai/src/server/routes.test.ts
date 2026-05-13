import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ResolvedRemotionAiConfig } from "../config.js";
import { JobsStore } from "../jobs-store.js";
import type { Orchestrator, SubmittedJob } from "../orchestrator.js";
import type { JobSnapshot } from "../types.js";
import {
  extractCancelFromPath,
  extractEventsFromPath,
  extractJobIdFromPath,
  handleHistory,
  handleSubmit,
  makeJobLookupHandler,
  type RouteContext,
} from "./routes.js";
import { handleVoiceover } from "./voiceover.js";

function makeRequest(method: string, url: string, body?: unknown): IncomingMessage {
  const stream = new PassThrough() as IncomingMessage & PassThrough;
  stream.method = method;
  stream.url = url;
  stream.headers = { "content-type": "application/json" };
  setImmediate(() => {
    if (body !== undefined) {
      stream.end(JSON.stringify(body));
    } else {
      stream.end();
    }
  });
  return stream;
}

interface CapturedResponse {
  res: ServerResponse;
  status: number | undefined;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
  done: Promise<void>;
}

function makeResponse(): CapturedResponse {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let captured = "";
  const headers: Record<string, string | string[] | number | undefined> = {};
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      captured += chunk.toString();
      callback();
    },
  }) as unknown as ServerResponse;
  let statusCode: number | undefined;
  Object.defineProperty(stream, "statusCode", {
    get: () => statusCode,
    set: (value: number) => {
      statusCode = value;
    },
  });
  (stream as { setHeader: (name: string, value: string | number | string[]) => void }).setHeader = (
    name,
    value,
  ) => {
    headers[name.toLowerCase()] = value;
  };
  const originalEnd = stream.end.bind(stream);
  (stream as unknown as { end: ServerResponse["end"] }).end = ((...args: unknown[]) => {
    if (args.length > 0 && typeof args[0] === "string") {
      captured += args[0];
    } else if (args.length > 0 && Buffer.isBuffer(args[0])) {
      captured += args[0].toString();
    }
    originalEnd();
    resolveDone();
    return stream;
  }) as ServerResponse["end"];

  const wrapper: CapturedResponse = {
    res: stream,
    get status(): number | undefined {
      return statusCode;
    },
    headers,
    get body(): string {
      return captured;
    },
    done,
  };
  return wrapper;
}

function makeConfig(overrides: Partial<ResolvedRemotionAiConfig> = {}): ResolvedRemotionAiConfig {
  return {
    engine: "codex",
    defaultOutputRoot: "/tmp/remotion-ai-test-library",
    outputRootAllowlist: undefined,
    retryMax: 3,
    jobTimeoutMs: 60_000,
    skillsBundled: false,
    starterDir: "/fake/starter",
    allowNetwork: false,
    chromiumExecutablePath: undefined,
    maxOutputBytes: 10 * 1024 * 1024,
    ...overrides,
  };
}

function makeOrchestrator(
  jobs: JobsStore,
  jobId = "fake-job",
): {
  orchestrator: Orchestrator;
  submitted: { count: number; lastOptions?: { prompt: string; outputRoot: string } };
  cancelled: string[];
} {
  const submitted = {
    count: 0,
    lastOptions: undefined as { prompt: string; outputRoot: string } | undefined,
  };
  const cancelled: string[] = [];
  const orchestrator = {
    submit: (options: { prompt: string; outputRoot: string }): SubmittedJob => {
      submitted.count += 1;
      submitted.lastOptions = options;
      const snapshot = jobs.enqueue({ jobId, engine: "codex", workspaceDir: "" });
      return {
        snapshot,
        waitForCompletion: async () => snapshot,
      };
    },
    cancel: (id: string): boolean => {
      cancelled.push(id);
      return true;
    },
  } as unknown as Orchestrator;
  return { orchestrator, submitted, cancelled };
}

function makeContext(
  jobs: JobsStore,
  orchestrator: Orchestrator,
  config: ResolvedRemotionAiConfig = makeConfig(),
): RouteContext {
  return {
    config,
    coreConfig: {},
    runtime: {
      tts: {
        textToSpeech: async () => ({ success: false, error: "TTS stub not configured" }),
        textToSpeechTelephony: async () => ({ success: false, error: "TTS stub not configured" }),
        listVoices: async () => [],
      },
    },
    jobs,
    orchestrator,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

describe("handleSubmit", () => {
  it("rejects non-POST requests with 405", async () => {
    const jobs = new JobsStore();
    const { orchestrator } = makeOrchestrator(jobs);
    const ctx = makeContext(jobs, orchestrator);
    const req = makeRequest("GET", "/remotion-ai/jobs");
    const cap = makeResponse();
    await handleSubmit(req, cap.res, ctx);
    await cap.done;
    expect(cap.status).toBe(405);
    expect(cap.body).toContain("method_not_allowed");
  });

  it("rejects malformed body with 400", async () => {
    const jobs = new JobsStore();
    const { orchestrator } = makeOrchestrator(jobs);
    const ctx = makeContext(jobs, orchestrator);
    const req = makeRequest("POST", "/remotion-ai/jobs", { prompt: "" });
    const cap = makeResponse();
    await handleSubmit(req, cap.res, ctx);
    await cap.done;
    expect(cap.status).toBe(400);
    expect(cap.body).toContain("prompt must be a non-empty string");
  });

  it("rejects relative outputRoot with 400", async () => {
    const jobs = new JobsStore();
    const { orchestrator } = makeOrchestrator(jobs);
    const ctx = makeContext(jobs, orchestrator);
    const req = makeRequest("POST", "/remotion-ai/jobs", {
      prompt: "title",
      outputRoot: "relative/path",
    });
    const cap = makeResponse();
    await handleSubmit(req, cap.res, ctx);
    await cap.done;
    expect(cap.status).toBe(400);
    expect(cap.body).toContain("outputRoot must be an absolute path");
  });

  it("returns 202 with snapshot+links on a valid submission", async () => {
    const jobs = new JobsStore();
    const { orchestrator, submitted } = makeOrchestrator(jobs, "abc-123");
    const ctx = makeContext(jobs, orchestrator);
    const req = makeRequest("POST", "/remotion-ai/jobs", {
      prompt: "title card",
      outputRoot: "/Users/me/projects",
    });
    const cap = makeResponse();
    await handleSubmit(req, cap.res, ctx);
    await cap.done;
    expect(cap.status).toBe(202);
    expect(cap.headers["location"]).toBe("/remotion-ai/jobs/abc-123");
    const parsed = JSON.parse(cap.body) as {
      job: JobSnapshot;
      snapshotUrl: string;
      eventsUrl: string;
      cancelUrl: string;
    };
    expect(parsed.job.jobId).toBe("abc-123");
    expect(parsed.job.phase).toBe("queued");
    expect(parsed.snapshotUrl).toBe("/remotion-ai/jobs/abc-123");
    expect(parsed.eventsUrl).toBe("/remotion-ai/jobs/abc-123/events");
    expect(parsed.cancelUrl).toBe("/remotion-ai/jobs/abc-123/cancel");
    expect(submitted.count).toBe(1);
    expect(submitted.lastOptions?.prompt).toBe("title card");
  });

  it("rejects invalid engine with 400", async () => {
    const jobs = new JobsStore();
    const { orchestrator } = makeOrchestrator(jobs);
    const ctx = makeContext(jobs, orchestrator);
    const req = makeRequest("POST", "/remotion-ai/jobs", {
      prompt: "title",
      outputRoot: "/abs",
      engine: "claude-code",
    });
    const cap = makeResponse();
    await handleSubmit(req, cap.res, ctx);
    await cap.done;
    expect(cap.status).toBe(400);
    expect(cap.body).toContain("engine");
  });
});

describe("makeJobLookupHandler", () => {
  it("returns the snapshot on GET /remotion-ai/jobs/:id", async () => {
    const jobs = new JobsStore();
    jobs.enqueue({ jobId: "lookup-1", engine: "codex", workspaceDir: "/ws" });
    const { orchestrator } = makeOrchestrator(jobs, "lookup-1");
    const ctx = makeContext(jobs, orchestrator);
    const handler = makeJobLookupHandler(extractJobIdFromPath);
    const req = makeRequest("GET", "/remotion-ai/jobs/lookup-1");
    const cap = makeResponse();
    await handler(req, cap.res, ctx);
    await cap.done;
    expect(cap.status).toBe(200);
    expect(JSON.parse(cap.body).job.jobId).toBe("lookup-1");
  });

  it("returns 404 when the job is unknown", async () => {
    const jobs = new JobsStore();
    const { orchestrator } = makeOrchestrator(jobs);
    const ctx = makeContext(jobs, orchestrator);
    const handler = makeJobLookupHandler(extractJobIdFromPath);
    const req = makeRequest("GET", "/remotion-ai/jobs/missing");
    const cap = makeResponse();
    await handler(req, cap.res, ctx);
    await cap.done;
    expect(cap.status).toBe(404);
    expect(cap.body).toContain("not_found");
  });

  it("delegates POST .../cancel to the orchestrator", async () => {
    const jobs = new JobsStore();
    jobs.enqueue({ jobId: "cancel-me", engine: "codex", workspaceDir: "/ws" });
    const { orchestrator, cancelled } = makeOrchestrator(jobs, "cancel-me");
    const ctx = makeContext(jobs, orchestrator);
    const handler = makeJobLookupHandler(extractJobIdFromPath);
    const req = makeRequest("POST", "/remotion-ai/jobs/cancel-me/cancel");
    const cap = makeResponse();
    await handler(req, cap.res, ctx);
    await cap.done;
    expect(cap.status).toBe(200);
    expect(cancelled).toEqual(["cancel-me"]);
    expect(JSON.parse(cap.body).cancelled).toBe(true);
  });
});

describe("handleHistory", () => {
  it("returns the most recent jobs", async () => {
    const jobs = new JobsStore();
    for (let i = 0; i < 4; i += 1) {
      jobs.enqueue({ jobId: `h-${i}`, engine: "codex", workspaceDir: `/ws/${i}` });
    }
    const { orchestrator } = makeOrchestrator(jobs);
    const ctx = makeContext(jobs, orchestrator);
    const req = makeRequest("GET", "/remotion-ai/history?limit=3");
    const cap = makeResponse();
    await handleHistory(req, cap.res, ctx);
    await cap.done;
    expect(cap.status).toBe(200);
    const parsed = JSON.parse(cap.body) as { jobs: JobSnapshot[] };
    expect(parsed.jobs).toHaveLength(3);
    expect(parsed.jobs[0]?.jobId).toBe("h-3");
  });
});

describe("handleVoiceover", () => {
  it("generates per-cue audio assets and a Remotion import module", async () => {
    const libraryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remotion-ai-voiceover-"));
    const workspaceDir = path.join(libraryRoot, "job-voiceover");
    const srcDir = path.join(workspaceDir, "src");
    await fs.mkdir(srcDir, { recursive: true });
    const sourceAudio = path.join(libraryRoot, "source.mp3");
    await fs.writeFile(sourceAudio, "mp3");

    const jobs = new JobsStore();
    jobs.enqueue({ jobId: "job-voiceover", engine: "codex", workspaceDir });
    const { orchestrator } = makeOrchestrator(jobs);
    const ctx = makeContext(jobs, orchestrator, makeConfig({ defaultOutputRoot: libraryRoot }));
    let ttsCalls = 0;
    Object.assign(ctx.runtime.tts, {
      textToSpeech: async ({ text }: { text: string }) => {
        ttsCalls += 1;
        return {
          success: true,
          audioPath: sourceAudio,
          provider: "mock",
          outputFormat: "mp3",
          voiceCompatible: true,
          latencyMs: text.length,
        };
      },
    });

    const req = makeRequest("POST", "/remotion-ai/voiceover", {
      jobId: "job-voiceover",
      voiceoverId: "narration",
      fps: 30,
      subtitles: [
        { id: "intro", text: "Hello", startFrame: 0, endFrame: 30 },
        { id: "outro", text: "World", startFrame: 30, endFrame: 60 },
      ],
    });
    const cap = makeResponse();
    await handleVoiceover(req, cap.res, ctx);
    await cap.done;

    expect(cap.status).toBe(201);
    expect(ttsCalls).toBe(2);
    const parsed = JSON.parse(cap.body) as {
      manifestPath: string;
      generatedModulePath: string;
      cues: Array<{ staticFile: string; durationInFrames: number }>;
    };
    expect(parsed.cues.map((cue) => cue.staticFile)).toEqual([
      "voiceover/narration/001-intro.mp3",
      "voiceover/narration/002-outro.mp3",
    ]);
    expect(parsed.cues.map((cue) => cue.durationInFrames)).toEqual([30, 30]);
    await expect(fs.stat(parsed.manifestPath)).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
    await expect(fs.readFile(parsed.generatedModulePath, "utf8")).resolves.toContain(
      "voiceoverCues",
    );
  });

  it("rejects workspaces outside configured output roots", async () => {
    const libraryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remotion-ai-library-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remotion-ai-outside-"));
    const jobs = new JobsStore();
    const { orchestrator } = makeOrchestrator(jobs);
    const ctx = makeContext(jobs, orchestrator, makeConfig({ defaultOutputRoot: libraryRoot }));
    const req = makeRequest("POST", "/remotion-ai/voiceover", {
      workspaceDir: outsideRoot,
      subtitles: [{ text: "Nope", startFrame: 0, endFrame: 30 }],
    });
    const cap = makeResponse();
    await handleVoiceover(req, cap.res, ctx);
    await cap.done;

    expect(cap.status).toBe(403);
    expect(cap.body).toContain("workspace_not_allowed");
  });
});

describe("path helpers", () => {
  it("extractJobIdFromPath matches snapshot/cancel/events shapes", () => {
    const make = (url: string): IncomingMessage => ({ url }) as unknown as IncomingMessage;
    expect(extractJobIdFromPath(make("/remotion-ai/jobs/abc-123"))).toBe("abc-123");
    expect(extractJobIdFromPath(make("/remotion-ai/jobs/abc-123/cancel"))).toBe("abc-123");
    expect(extractJobIdFromPath(make("/remotion-ai/jobs/abc-123/events"))).toBe("abc-123");
    expect(extractJobIdFromPath(make("/remotion-ai/jobs/abc-123?x=1"))).toBe("abc-123");
    expect(extractJobIdFromPath(make("/remotion-ai/history"))).toBeNull();
  });

  it("extractCancelFromPath only matches the /cancel suffix", () => {
    const make = (url: string): IncomingMessage => ({ url }) as unknown as IncomingMessage;
    expect(extractCancelFromPath(make("/remotion-ai/jobs/abc/cancel"))).toBe(true);
    expect(extractCancelFromPath(make("/remotion-ai/jobs/abc"))).toBe(false);
    expect(extractCancelFromPath(make("/remotion-ai/jobs/abc/events"))).toBe(false);
  });

  it("extractEventsFromPath only matches the /events suffix", () => {
    const make = (url: string): IncomingMessage => ({ url }) as unknown as IncomingMessage;
    expect(extractEventsFromPath(make("/remotion-ai/jobs/abc/events"))).toBe(true);
    expect(extractEventsFromPath(make("/remotion-ai/jobs/abc"))).toBe(false);
    expect(extractEventsFromPath(make("/remotion-ai/jobs/abc/cancel"))).toBe(false);
  });
});
