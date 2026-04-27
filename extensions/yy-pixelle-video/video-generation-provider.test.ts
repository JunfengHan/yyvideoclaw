import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mock the plugin-sdk modules the provider imports.
const pluginSdkMocks = vi.hoisted(() => ({
  postJsonRequestMock: vi.fn(),
  fetchWithTimeoutMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async (_response: Response, _label: string) => {}),
  normalizeBaseUrlMock: vi.fn((value: string | undefined) =>
    typeof value === "string" ? value.replace(/\/+$/u, "") : undefined,
  ),
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  postJsonRequest: pluginSdkMocks.postJsonRequestMock,
  fetchWithTimeout: pluginSdkMocks.fetchWithTimeoutMock,
  assertOkOrThrowHttpError: pluginSdkMocks.assertOkOrThrowHttpErrorMock,
  normalizeBaseUrl: pluginSdkMocks.normalizeBaseUrlMock,
}));

vi.mock("openclaw/plugin-sdk/text-runtime", () => ({
  isRecord: (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value),
  normalizeOptionalString: (value: unknown) => {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  },
}));

let buildYyPixelleVideoGenerationProvider: typeof import("./video-generation-provider.js").buildYyPixelleVideoGenerationProvider;

beforeAll(async () => {
  ({ buildYyPixelleVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

afterEach(() => {
  pluginSdkMocks.postJsonRequestMock.mockReset();
  pluginSdkMocks.fetchWithTimeoutMock.mockReset();
  pluginSdkMocks.assertOkOrThrowHttpErrorMock.mockClear();
  pluginSdkMocks.normalizeBaseUrlMock.mockClear();
});

type CfgLike = {
  models?: {
    providers?: {
      "yy-pixelle-video"?: Record<string, unknown>;
    };
  };
};

function createCfg(providerConfig: Record<string, unknown>): CfgLike {
  return {
    models: {
      providers: {
        "yy-pixelle-video": providerConfig,
      },
    },
  };
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

function bufferResponse(buffer: Buffer): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    text: async () => "",
    json: async () => ({}),
  } as unknown as Response;
}

describe("yy-pixelle-video video generation provider", () => {
  describe("declares explicit capabilities", () => {
    it("declines imageToVideo and videoToVideo", () => {
      const provider = buildYyPixelleVideoGenerationProvider();
      expect(provider.capabilities.imageToVideo).toEqual({ enabled: false });
      expect(provider.capabilities.videoToVideo).toEqual({ enabled: false });
      expect(provider.capabilities.aspectRatios).toEqual(
        expect.arrayContaining(["9:16", "16:9", "1:1"]),
      );
    });
  });

  describe("isConfigured", () => {
    it("returns false when endpoint is missing", () => {
      const provider = buildYyPixelleVideoGenerationProvider();
      expect(provider.isConfigured?.({ cfg: createCfg({}) as never })).toBe(false);
    });

    it("returns false when endpoint is not a valid http(s) URL", () => {
      const provider = buildYyPixelleVideoGenerationProvider();
      expect(
        provider.isConfigured?.({
          cfg: createCfg({ endpoint: "not-a-url" }) as never,
        }),
      ).toBe(false);
    });

    it("returns true when endpoint is a valid http URL", () => {
      const provider = buildYyPixelleVideoGenerationProvider();
      expect(
        provider.isConfigured?.({
          cfg: createCfg({ endpoint: "http://127.0.0.1:8000" }) as never,
        }),
      ).toBe(true);
    });
  });

  describe("generateVideo - success path", () => {
    it("submits async task, polls to completed, downloads MP4, and returns asset", async () => {
      const fakeMp4 = Buffer.from("mp4-bytes");

      // 1) Submit async task
      pluginSdkMocks.postJsonRequestMock.mockResolvedValueOnce(
        jsonResponse({ success: true, message: "ok", task_id: "task-123" }),
      );
      // 2) First poll → running
      pluginSdkMocks.fetchWithTimeoutMock.mockResolvedValueOnce(
        jsonResponse({ task_id: "task-123", status: "running" }),
      );
      // 3) Second poll → completed
      pluginSdkMocks.fetchWithTimeoutMock.mockResolvedValueOnce(
        jsonResponse({
          task_id: "task-123",
          status: "completed",
          result: {
            video_url: "http://127.0.0.1:8000/api/files/task-123/final.mp4",
            duration: 12.5,
            file_size: 1234,
          },
        }),
      );
      // 4) Download MP4
      pluginSdkMocks.fetchWithTimeoutMock.mockResolvedValueOnce(bufferResponse(fakeMp4));

      const provider = buildYyPixelleVideoGenerationProvider();
      const result = await provider.generateVideo({
        provider: "yy-pixelle-video",
        model: "pixelle-standard",
        prompt: "自律的力量",
        cfg: createCfg({
          endpoint: "http://127.0.0.1:8000",
          apiKey: "bearer-xyz",
          pollIntervalMs: 1,
        }) as never,
        aspectRatio: "9:16",
      });

      expect(result.videos).toHaveLength(1);
      expect(result.videos[0].mimeType).toBe("video/mp4");
      expect(result.videos[0].buffer?.equals(fakeMp4)).toBe(true);
      expect(result.videos[0].metadata).toEqual(
        expect.objectContaining({
          taskId: "task-123",
          sourceUrl: "http://127.0.0.1:8000/api/files/task-123/final.mp4",
          durationSeconds: 12.5,
          fileSize: 1234,
        }),
      );
      expect(result.metadata).toEqual(
        expect.objectContaining({
          taskId: "task-123",
          frameTemplate: "1080x1920/image_default.html",
        }),
      );

      // Verify submit payload and headers
      expect(pluginSdkMocks.postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "http://127.0.0.1:8000/api/video/generate/async",
          body: expect.objectContaining({
            text: "自律的力量",
            mode: "generate",
            frame_template: "1080x1920/image_default.html",
          }),
        }),
      );
      const submitCall = pluginSdkMocks.postJsonRequestMock.mock.calls[0]?.[0] as {
        headers: Headers;
      };
      expect(submitCall.headers.get("Authorization")).toBe("Bearer bearer-xyz");
      expect(submitCall.headers.get("Content-Type")).toBe("application/json");

      // Verify polling URL
      const pollCall = pluginSdkMocks.fetchWithTimeoutMock.mock.calls[0];
      expect(pollCall?.[0]).toBe("http://127.0.0.1:8000/api/tasks/task-123");
    });
  });

  describe("generateVideo - aspectRatio mapping", () => {
    const cases: Array<[string, string]> = [
      ["9:16", "1080x1920/image_default.html"],
      ["16:9", "1920x1080/image_full.html"],
      ["1:1", "1080x1080/image_minimal_framed.html"],
    ];
    for (const [aspect, frameTemplate] of cases) {
      it(`maps aspectRatio ${aspect} to frame_template ${frameTemplate}`, async () => {
        pluginSdkMocks.postJsonRequestMock.mockResolvedValueOnce(jsonResponse({ task_id: "t1" }));
        pluginSdkMocks.fetchWithTimeoutMock.mockResolvedValueOnce(
          jsonResponse({
            status: "completed",
            result: { video_url: "http://x/f.mp4", duration: 1, file_size: 0 },
          }),
        );
        pluginSdkMocks.fetchWithTimeoutMock.mockResolvedValueOnce(bufferResponse(Buffer.from("x")));

        const provider = buildYyPixelleVideoGenerationProvider();
        await provider.generateVideo({
          provider: "yy-pixelle-video",
          model: "m",
          prompt: "topic",
          cfg: createCfg({ endpoint: "http://127.0.0.1:8000", pollIntervalMs: 1 }) as never,
          aspectRatio: aspect,
        });

        const submitCall = pluginSdkMocks.postJsonRequestMock.mock.calls[0]?.[0] as {
          body: { frame_template: string };
        };
        expect(submitCall.body.frame_template).toBe(frameTemplate);
      });
    }
  });

  describe("generateVideo - failure paths", () => {
    it("throws with task error when status is failed", async () => {
      pluginSdkMocks.postJsonRequestMock.mockResolvedValueOnce(
        jsonResponse({ task_id: "task-fail" }),
      );
      pluginSdkMocks.fetchWithTimeoutMock.mockResolvedValueOnce(
        jsonResponse({
          task_id: "task-fail",
          status: "failed",
          error: "LLM quota exhausted",
        }),
      );

      const provider = buildYyPixelleVideoGenerationProvider();
      await expect(
        provider.generateVideo({
          provider: "yy-pixelle-video",
          model: "m",
          prompt: "topic",
          cfg: createCfg({ endpoint: "http://127.0.0.1:8000", pollIntervalMs: 1 }) as never,
        }),
      ).rejects.toThrow("LLM quota exhausted");
    });

    it("throws timeout error when polling exceeds timeoutMs", async () => {
      pluginSdkMocks.postJsonRequestMock.mockResolvedValueOnce(
        jsonResponse({ task_id: "task-slow" }),
      );
      // Always running
      pluginSdkMocks.fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ status: "running" }));

      const provider = buildYyPixelleVideoGenerationProvider();
      await expect(
        provider.generateVideo({
          provider: "yy-pixelle-video",
          model: "m",
          prompt: "topic",
          cfg: createCfg({
            endpoint: "http://127.0.0.1:8000",
            pollIntervalMs: 1,
            timeoutMs: 1, // 1 ms → will time out almost immediately
          }) as never,
        }),
      ).rejects.toThrow(/timed out/);
    });

    it("throws configuration error when endpoint is missing", async () => {
      const provider = buildYyPixelleVideoGenerationProvider();
      await expect(
        provider.generateVideo({
          provider: "yy-pixelle-video",
          model: "m",
          prompt: "topic",
          cfg: createCfg({}) as never,
        }),
      ).rejects.toThrow(/endpoint is missing or invalid/);
    });
  });
});
