import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackendNotReadyError,
  createVideoStudioClient,
  InsecureEndpointError,
  InstallRequiredError,
  isLoopbackUrl,
  NetworkError,
  type TaskSnapshot,
  type VideoStudioClientConfig,
} from "./client.ts";

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function jsonResponse(
  body: unknown,
  init: { status?: number; statusText?: string } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(
  status: number,
  detail: string | undefined = undefined,
  statusText = "Boom",
): Response {
  return new Response(detail === undefined ? null : JSON.stringify({ detail }), {
    status,
    statusText,
    headers: detail === undefined ? undefined : { "content-type": "application/json" },
  });
}

function buildCfg(overrides: Partial<VideoStudioClientConfig> = {}): VideoStudioClientConfig {
  return {
    endpoint: "http://127.0.0.1:34567",
    token: "proc-abc",
    fetch: vi.fn().mockResolvedValue(jsonResponse({})) as unknown as typeof globalThis.fetch,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Loopback guard.
// ---------------------------------------------------------------------------

describe("isLoopbackUrl", () => {
  it("accepts 127.0.0.1 / localhost / ::1", () => {
    expect(isLoopbackUrl("http://127.0.0.1:9000")).toBe(true);
    expect(isLoopbackUrl("http://localhost:9000")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:9000")).toBe(true);
  });

  it("rejects any non-loopback hostname or non-http protocol", () => {
    expect(isLoopbackUrl("http://example.com")).toBe(false);
    expect(isLoopbackUrl("http://10.0.0.1")).toBe(false);
    expect(isLoopbackUrl("file:///etc/passwd")).toBe(false);
    expect(isLoopbackUrl("javascript:alert(1)")).toBe(false);
    expect(isLoopbackUrl("not-a-url")).toBe(false);
  });
});

describe("createVideoStudioClient(constructor)", () => {
  it("throws InsecureEndpointError when the endpoint is not loopback", () => {
    expect(() =>
      createVideoStudioClient({
        endpoint: "http://example.com",
        token: "x",
      } as VideoStudioClientConfig),
    ).toThrow(InsecureEndpointError);
  });
});

// ---------------------------------------------------------------------------
// Method-level contracts.
// ---------------------------------------------------------------------------

describe("videoStudioClient.getTemplates", () => {
  it("targets /api/frame/templates with a bearer token and unwraps both shapes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ templates: [{ key: "1080x1920/default.html" }] }))
      .mockResolvedValueOnce(jsonResponse([{ key: "1920x1080/default.html" }]));
    const client = createVideoStudioClient(
      buildCfg({ fetch: fetchMock as unknown as typeof globalThis.fetch }),
    );

    const wrapped = await client.getTemplates();
    expect(wrapped).toEqual([{ key: "1080x1920/default.html" }]);

    const bare = await client.getTemplates();
    expect(bare).toEqual([{ key: "1920x1080/default.html" }]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:34567/api/frame/templates");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer proc-abc");
  });

  it("maps a 404 on /frame/* to InstallRequiredError", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(404));
    const client = createVideoStudioClient(
      buildCfg({ fetch: fetchMock as unknown as typeof globalThis.fetch }),
    );
    await expect(client.getTemplates()).rejects.toBeInstanceOf(InstallRequiredError);
  });
});

describe("videoStudioClient.createVideoTask", () => {
  it("POSTs snake_case body to /video/generate/async", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: "t1", status: "pending" } satisfies TaskSnapshot));
    const client = createVideoStudioClient(
      buildCfg({ fetch: fetchMock as unknown as typeof globalThis.fetch }),
    );

    const snap = await client.createVideoTask({
      topic: "atomic habits",
      aspectRatio: "9:16",
      pipeline: "standard",
    });
    expect(snap).toEqual({ id: "t1", status: "pending" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:34567/api/video/generate/async");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      topic: "atomic habits",
      aspect_ratio: "9:16",
      pipeline: "standard",
    });
  });
});

describe("videoStudioClient.getTask", () => {
  it("URL-encodes the task id in the path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: "a/b", status: "running" } satisfies TaskSnapshot));
    const client = createVideoStudioClient(
      buildCfg({ fetch: fetchMock as unknown as typeof globalThis.fetch }),
    );
    await client.getTask("a/b");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:34567/api/tasks/a%2Fb");
  });
});

describe("videoStudioClient.listTasks", () => {
  it("unwraps both array and `{ tasks }` shapes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "t1", status: "succeeded" }]))
      .mockResolvedValueOnce(jsonResponse({ tasks: [{ id: "t2", status: "running" }] }));
    const client = createVideoStudioClient(
      buildCfg({ fetch: fetchMock as unknown as typeof globalThis.fetch }),
    );
    expect((await client.listTasks())[0]?.id).toBe("t1");
    expect((await client.listTasks())[0]?.id).toBe("t2");
  });
});

// ---------------------------------------------------------------------------
// Error normalisation.
// ---------------------------------------------------------------------------

describe("videoStudioClient error normalisation", () => {
  it("maps 503 to BackendNotReadyError", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(503));
    const client = createVideoStudioClient(
      buildCfg({ fetch: fetchMock as unknown as typeof globalThis.fetch }),
    );
    await expect(client.listTasks()).rejects.toBeInstanceOf(BackendNotReadyError);
  });

  it("maps a fetch rejection to BackendNotReadyError (transport down)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const client = createVideoStudioClient(
      buildCfg({ fetch: fetchMock as unknown as typeof globalThis.fetch }),
    );
    await expect(client.listTasks()).rejects.toBeInstanceOf(BackendNotReadyError);
  });

  it("maps non-2xx with JSON detail to NetworkError with status + detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(500, "kaboom"));
    const client = createVideoStudioClient(
      buildCfg({ fetch: fetchMock as unknown as typeof globalThis.fetch }),
    );
    try {
      await client.listTasks();
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).status).toBe(500);
      expect((err as NetworkError).message).toBe("kaboom");
    }
  });
});

// ---------------------------------------------------------------------------
// Loopback guard against buildUrl() results (defence in depth).
// ---------------------------------------------------------------------------

describe("videoStudioClient.getMediaUrl", () => {
  it("returns an absolute loopback URL prefixed with /api/files", () => {
    const client = createVideoStudioClient(buildCfg());
    expect(client.getMediaUrl("/outputs/foo.mp4")).toBe(
      "http://127.0.0.1:34567/api/files/outputs/foo.mp4",
    );
  });
});

// ---------------------------------------------------------------------------
// streamTaskEvents — polling fallback (no EventSource in vitest).
// ---------------------------------------------------------------------------

describe("videoStudioClient.streamTaskEvents (polling fallback)", () => {
  it("polls /tasks/{id} and stops once status leaves the running set", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: "t1", status: "running" } satisfies TaskSnapshot))
        .mockResolvedValueOnce(
          jsonResponse({ id: "t1", status: "succeeded" } satisfies TaskSnapshot),
        );
      const client = createVideoStudioClient(
        buildCfg({ fetch: fetchMock as unknown as typeof globalThis.fetch }),
      );

      const seen: string[] = [];
      const sub = client.streamTaskEvents("t1", (evt) => {
        const snap = evt as TaskSnapshot;
        seen.push(`${snap.id}:${snap.status}`);
      });
      // Drain both ticks: initial + one scheduled poll.
      await vi.runOnlyPendingTimersAsync();
      await vi.runOnlyPendingTimersAsync();
      await vi.runOnlyPendingTimersAsync();

      expect(seen).toContain("t1:running");
      expect(seen).toContain("t1:succeeded");
      sub.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
