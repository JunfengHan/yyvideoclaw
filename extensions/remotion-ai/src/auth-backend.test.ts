// extensions/remotion-ai/src/auth-backend.test.ts

import { describe, expect, it, vi } from "vitest";
import { AuthBackend, resolveBackendBaseUrl, type FetchLike } from "./auth-backend.js";

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function emptyResponse(status: number): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    text: async () => "",
  };
}

describe("AuthBackend.login", () => {
  it("returns a LoginSuccess on 200", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(200, { token: "tok", userEmail: "u@x", remainingCredits: 10 }),
    ) as unknown as FetchLike;
    const result = await new AuthBackend({ fetch: fetcher, baseUrl: "https://b" }).login({
      email: "u@x",
      password: "p",
    });
    expect(result).toEqual({ token: "tok", userEmail: "u@x", remainingCredits: 10 });
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://b/api/v1/auth/login");
    expect(init?.method).toBe("POST");
    // The password MUST be in the body, not the URL — defends against
    // server-side log captures that record path+query but not bodies.
    expect(init?.body).toContain('"password":"p"');
    expect(url).not.toContain("password=");
  });

  it("maps 401 to invalid_credentials", async () => {
    const fetcher = vi.fn(async () => jsonResponse(401, { error: "x" })) as unknown as FetchLike;
    const result = await new AuthBackend({ fetch: fetcher, baseUrl: "https://b" }).login({
      email: "u",
      password: "p",
    });
    expect(result).toEqual({ kind: "invalid_credentials" });
  });

  it("maps fetch rejection to network_error", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchLike;
    const result = await new AuthBackend({ fetch: fetcher, baseUrl: "https://b" }).login({
      email: "u",
      password: "p",
    });
    expect(result).toEqual({ kind: "network_error", detail: "ECONNREFUSED" });
  });

  it("maps non-2xx to server_error with detail", async () => {
    const fetcher = vi.fn(async () => jsonResponse(503, { error: "down" })) as unknown as FetchLike;
    const result = await new AuthBackend({ fetch: fetcher, baseUrl: "https://b" }).login({
      email: "u",
      password: "p",
    });
    expect(result).toMatchObject({ kind: "server_error", status: 503 });
  });

  it("rejects 200 without a token field", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(200, { userEmail: "u@x" }),
    ) as unknown as FetchLike;
    const result = await new AuthBackend({ fetch: fetcher, baseUrl: "https://b" }).login({
      email: "u@x",
      password: "p",
    });
    expect(result).toMatchObject({ kind: "server_error" });
  });
});

describe("AuthBackend.usage", () => {
  it("returns the parsed snapshot on 200", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(200, { remainingCredits: 7, monthlyQuota: 100 }),
    ) as unknown as FetchLike;
    const result = await new AuthBackend({ fetch: fetcher, baseUrl: "https://b" }).usage("tok");
    expect(result).toEqual({ remainingCredits: 7, monthlyQuota: 100 });
    const [, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init?.headers?.authorization).toBe("Bearer tok");
  });

  it("returns invalid_credentials on 401 (token expired)", async () => {
    const fetcher = vi.fn(async () => jsonResponse(401, { error: "x" })) as unknown as FetchLike;
    const result = await new AuthBackend({ fetch: fetcher, baseUrl: "https://b" }).usage("tok");
    expect(result).toEqual({ kind: "invalid_credentials" });
  });
});

describe("AuthBackend.logout", () => {
  it("succeeds on 204", async () => {
    const fetcher = vi.fn(async () => emptyResponse(204)) as unknown as FetchLike;
    const result = await new AuthBackend({ fetch: fetcher, baseUrl: "https://b" }).logout("tok");
    expect(result).toBe(true);
  });
  it("treats 401 as success — local logout proceeds anyway", async () => {
    const fetcher = vi.fn(async () => emptyResponse(401)) as unknown as FetchLike;
    const result = await new AuthBackend({ fetch: fetcher, baseUrl: "https://b" }).logout("tok");
    expect(result).toBe(true);
  });
});

describe("hostedOpenAiBaseUrl", () => {
  it("appends /api/v1/codex to the configured base", () => {
    const url = new AuthBackend({ baseUrl: "https://api.test" }).hostedOpenAiBaseUrl;
    expect(url).toBe("https://api.test/api/v1/codex");
  });
  it("strips trailing slashes from the base before composing", () => {
    const url = new AuthBackend({ baseUrl: "https://api.test///" }).hostedOpenAiBaseUrl;
    expect(url).toBe("https://api.test/api/v1/codex");
  });
});

describe("resolveBackendBaseUrl", () => {
  it("falls back to the production default", () => {
    expect(resolveBackendBaseUrl({})).toBe("https://api.yyvideoclaw.com");
  });
  it("respects YYVIDEOCLAW_BACKEND_BASE_URL", () => {
    expect(resolveBackendBaseUrl({ YYVIDEOCLAW_BACKEND_BASE_URL: "https://staging.test" })).toBe(
      "https://staging.test",
    );
  });
  it("respects the OPENCLAW_REMOTION_AI_BACKEND_BASE_URL alias", () => {
    expect(
      resolveBackendBaseUrl({ OPENCLAW_REMOTION_AI_BACKEND_BASE_URL: "https://other.test" }),
    ).toBe("https://other.test");
  });
});
