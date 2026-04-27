import { describe, expect, it, vi } from "vitest";
import {
  bindInternalToken,
  INTERNAL_TOKEN_ALLOWED_ROUTES,
  InternalTokenRegistry,
  type AuditEvent,
  type TokenGenerator,
} from "./internal-token.js";

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function sequentialGenerator(): TokenGenerator {
  let n = 0;
  return () => `tok-${++n}`;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("InternalTokenRegistry.issue", () => {
  it("registers a unique bearer and emits an `issued` audit event", () => {
    const events: AuditEvent[] = [];
    const registry = new InternalTokenRegistry({
      generator: sequentialGenerator(),
      audit: (e) => events.push(e),
    });
    const meta = registry.issue({ ownerLabel: "supervisor#1" });
    expect(meta.token).toBe("tok-1");
    expect(meta.ownerLabel).toBe("supervisor#1");
    expect(registry.size).toBe(1);
    expect(events).toEqual([{ kind: "issued", ownerLabel: "supervisor#1" }]);
  });

  it("never issues the same bearer twice, even if the generator collides", () => {
    let call = 0;
    const collidingGenerator: TokenGenerator = () => {
      call += 1;
      return call < 3 ? "dup" : "unique";
    };
    const registry = new InternalTokenRegistry({ generator: collidingGenerator });
    const first = registry.issue({ ownerLabel: "a" });
    const second = registry.issue({ ownerLabel: "b" });
    expect(first.token).toBe("dup");
    expect(second.token).toBe("unique");
    expect(registry.size).toBe(2);
  });
});

describe("InternalTokenRegistry.check", () => {
  it("accepts the allow-listed POST /v1/chat/completions route", () => {
    const registry = new InternalTokenRegistry({ generator: sequentialGenerator() });
    const { token } = registry.issue({ ownerLabel: "x" });

    const result = registry.check({ token, method: "POST", pathname: "/v1/chat/completions" });
    expect(result.kind).toBe("accept");
  });

  it("rejects any other path with a 403 and emits a rejected audit event", () => {
    const events: AuditEvent[] = [];
    const registry = new InternalTokenRegistry({
      generator: sequentialGenerator(),
      audit: (e) => events.push(e),
    });
    const { token } = registry.issue({ ownerLabel: "rogue" });

    const result = registry.check({ token, method: "GET", pathname: "/tools/invoke" });
    expect(result).toEqual({
      kind: "reject",
      status: 403,
      reason: expect.stringContaining("chat completions"),
    });
    expect(events.at(-1)).toMatchObject({
      kind: "rejected",
      ownerLabel: "rogue",
      method: "GET",
      pathname: "/tools/invoke",
    });
  });

  it("returns `unknown` for bearers it never issued", () => {
    const registry = new InternalTokenRegistry();
    expect(
      registry.check({ token: "not-mine", method: "POST", pathname: "/v1/chat/completions" }),
    ).toEqual({
      kind: "unknown",
    });
  });

  it("is case-insensitive on the HTTP method (defensive)", () => {
    const registry = new InternalTokenRegistry({ generator: sequentialGenerator() });
    const { token } = registry.issue({ ownerLabel: "x" });
    const result = registry.check({ token, method: "post", pathname: "/v1/chat/completions" });
    expect(result.kind).toBe("accept");
  });
});

describe("InternalTokenRegistry.revoke", () => {
  it("removes the token and emits an audit event only once", () => {
    const events: AuditEvent[] = [];
    const registry = new InternalTokenRegistry({
      generator: sequentialGenerator(),
      audit: (e) => events.push(e),
    });
    const { token } = registry.issue({ ownerLabel: "x" });
    registry.revoke(token);
    registry.revoke(token); // second call must be a silent no-op
    expect(registry.size).toBe(0);
    expect(events.filter((e) => e.kind === "revoked")).toHaveLength(1);
    expect(registry.check({ token, method: "POST", pathname: "/v1/chat/completions" })).toEqual({
      kind: "unknown",
    });
  });
});

describe("bindInternalToken", () => {
  it("issues a token and returns a matching revoke closure", () => {
    const registry = new InternalTokenRegistry({ generator: sequentialGenerator() });
    const binding = bindInternalToken(registry, "binding-test");
    expect(registry.size).toBe(1);
    binding.revoke();
    expect(registry.size).toBe(0);
  });
});

describe("INTERNAL_TOKEN_ALLOWED_ROUTES", () => {
  it("is frozen at the canonical single-entry allow-list", () => {
    expect(INTERNAL_TOKEN_ALLOWED_ROUTES).toEqual([
      { method: "POST", path: "/v1/chat/completions" },
    ]);
  });
});

describe("audit sink robustness", () => {
  it("does not call the sink for unknown tokens (no leaky signal)", () => {
    const audit = vi.fn();
    const registry = new InternalTokenRegistry({ audit });
    registry.check({ token: "ghost", method: "POST", pathname: "/v1/chat/completions" });
    expect(audit).not.toHaveBeenCalled();
  });
});
