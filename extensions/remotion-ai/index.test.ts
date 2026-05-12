import { describe, expect, it, vi } from "vitest";
import pluginEntry from "./index.js";

interface MockApi {
  readonly pluginConfig: unknown;
  readonly logger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  readonly registerHttpRoute: ReturnType<typeof vi.fn>;
  readonly runtime: Record<string, unknown>;
}

function createMockApi(pluginConfig: unknown): MockApi {
  return {
    pluginConfig,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    registerHttpRoute: vi.fn(),
    runtime: {},
  };
}

describe("remotion-ai plugin entry", () => {
  it("exposes a plugin entry with id 'remotion-ai' and a register function", () => {
    expect(pluginEntry).toBeDefined();
    expect(pluginEntry.id).toBe("remotion-ai");
    expect(typeof pluginEntry.register).toBe("function");
  });

  it("registers HTTP routes when the config is valid", () => {
    const api = createMockApi({});
    expect(() =>
      pluginEntry.register(api as unknown as Parameters<typeof pluginEntry.register>[0]),
    ).not.toThrow();
    expect(api.logger.error).not.toHaveBeenCalled();
    // PluginLogger only accepts a `message: string` argument; structured
    // fields are serialized into the message itself.
    expect(api.logger.info).toHaveBeenCalledTimes(1);
    const [registeredMessage] = api.logger.info.mock.calls[0];
    expect(registeredMessage).toContain("remotion-ai plugin registered");
    expect(registeredMessage).toContain("engine=codex");
    expect(registeredMessage).toContain("retryMax=3");

    // The plugin should register five routes:
    //   - POST   /remotion-ai/jobs              (exact)
    //   - GET    /remotion-ai/history           (exact)
    //   - GET    /remotion-ai/library           (exact)
    //   - POST   /remotion-ai/auth/login        (exact)
    //   - POST   /remotion-ai/auth/logout       (exact)
    //   - POST   /remotion-ai/auth/byok         (exact)
    //   - GET    /remotion-ai/auth/status       (exact)
    //   - GET    /remotion-ai/auth/usage        (exact)
    //   - GET    /remotion-ai/auth/openrouter/models  (exact)
    //   - prefix /remotion-ai/jobs/             (snapshot / cancel / events)
    //   - prefix /remotion-ai/library/          (delete item; collection with trailing slash; output.mp4)
    expect(api.registerHttpRoute).toHaveBeenCalledTimes(11);
    const paths = api.registerHttpRoute.mock.calls.map((call) => call[0].path);
    expect(paths).toContain("/remotion-ai/jobs");
    expect(paths).toContain("/remotion-ai/history");
    expect(paths).toContain("/remotion-ai/library");
    expect(paths).toContain("/remotion-ai/auth/login");
    expect(paths).toContain("/remotion-ai/auth/logout");
    expect(paths).toContain("/remotion-ai/auth/byok");
    expect(paths).toContain("/remotion-ai/auth/status");
    expect(paths).toContain("/remotion-ai/auth/usage");
    expect(paths).toContain("/remotion-ai/auth/openrouter/models");
    expect(paths).toContain("/remotion-ai/jobs/");
    expect(paths).toContain("/remotion-ai/library/");
    // Every route must be `auth: "gateway"`.
    for (const call of api.registerHttpRoute.mock.calls) {
      expect(call[0].auth).toBe("gateway");
    }
  });

  it("logs an error and skips registration when the config is malformed", () => {
    const api = createMockApi({ retryMax: "not-a-number" });
    expect(() =>
      pluginEntry.register(api as unknown as Parameters<typeof pluginEntry.register>[0]),
    ).not.toThrow();
    expect(api.logger.info).not.toHaveBeenCalled();
    expect(api.registerHttpRoute).not.toHaveBeenCalled();
    expect(api.logger.error).toHaveBeenCalledTimes(1);
    const [errorMessage] = api.logger.error.mock.calls[0];
    expect(errorMessage).toContain(
      "remotion-ai plugin config invalid; skipping route registration",
    );
    // The original config error reason is appended to the message.
    expect(errorMessage).toMatch(/retryMax/);
  });
});
