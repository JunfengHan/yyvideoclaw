import { describe, expect, it } from "vitest";
import { describeError, summarizeInputProps } from "./logging.js";

describe("summarizeInputProps", () => {
  it("returns key list and byte size for an object", () => {
    const summary = summarizeInputProps({ title: "hi", count: 3, nested: { a: 1 } });
    expect(summary.keys.toSorted()).toEqual(["count", "nested", "title"]);
    expect(summary.byteSize).toBeGreaterThan(0);
    expect(summary.truncatedKeys).toBe(false);
  });

  it("returns empty key list for null / non-objects without leaking the value", () => {
    expect(summarizeInputProps(null).keys).toEqual([]);
    expect(summarizeInputProps("a long sensitive string").keys).toEqual([]);
    expect(summarizeInputProps(42).keys).toEqual([]);
    expect(summarizeInputProps([1, 2, 3]).keys).toEqual([]);
  });

  it("truncates the key list above the cap and flags it", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 50; i++) {
      big[`k${i}`] = i;
    }
    const summary = summarizeInputProps(big);
    expect(summary.keys.length).toBe(32);
    expect(summary.truncatedKeys).toBe(true);
  });

  it("returns -1 byteSize for non-serialisable values without throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const summary = summarizeInputProps(cyclic);
    expect(summary.byteSize).toBe(-1);
  });

  it("never includes any value, only keys (regression: ensure no value leakage)", () => {
    const sensitive = { apiKey: "sk-secret-1234567890abcdef", token: "BEARER-XYZ" };
    const summary = summarizeInputProps(sensitive);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("BEARER");
  });
});

describe("describeError", () => {
  it("returns the message for a short Error", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error throws", () => {
    expect(describeError("plain string")).toBe("plain string");
    // Plain objects fall through to String(value) → "[object Object]"; we
    // intentionally do NOT JSON-stringify the value (it could leak secrets).
    expect(describeError({ weird: true })).toBe("[object Object]");
  });

  it("truncates very long messages and notes the truncation", () => {
    const long = "x".repeat(2000);
    const result = describeError(new Error(long), 100);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain("truncated");
  });
});
