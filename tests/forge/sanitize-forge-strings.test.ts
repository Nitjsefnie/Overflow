import { describe, expect, it } from "vitest";
import { sanitizeForgeStrings } from "@/lib/forge/sanitize-forge-strings";

describe("sanitizeForgeStrings", () => {
  it("replaces every NUL in nested strings without mutating the input", () => {
    const input = { title: "a\u0000b\u0000c", nested: [{ body: "x\u0000y" }, ["\u0000z"]] };

    expect(sanitizeForgeStrings(input)).toEqual({ title: "a\uFFFDb\uFFFDc", nested: [{ body: "x\uFFFDy" }, ["\uFFFDz"]] });
    expect(input).toEqual({ title: "a\u0000b\u0000c", nested: [{ body: "x\u0000y" }, ["\u0000z"]] });
  });

  it("preserves values outside plain objects and arrays by identity", () => {
    const date = new Date("2026-09-08T10:00:00Z");
    class Named { constructor(readonly name: string) {} }
    const instance = new Named("x\u0000y");
    const unchanged = "plain text";
    const input = { date, instance, unchanged, nil: null, missing: undefined, count: 3, flag: false };
    const output = sanitizeForgeStrings(input);

    expect(output).toEqual(input);
    expect(output.date).toBe(date);
    expect(output.instance).toBe(instance);
    expect(sanitizeForgeStrings(unchanged)).toBe(unchanged);
  });

  it("reuses unchanged arrays and plain objects, including an unchanged subtree", () => {
    const unchanged = { nested: ["safe", { body: "clean" }] };
    expect(sanitizeForgeStrings(unchanged)).toBe(unchanged);
    expect(sanitizeForgeStrings(unchanged.nested)).toBe(unchanged.nested);

    const input = { unchanged, changed: "x\u0000y" };
    const output = sanitizeForgeStrings(input);
    expect(output).not.toBe(input);
    expect(output).toEqual({ unchanged, changed: "x\uFFFDy" });
    expect(output.unchanged).toBe(unchanged);
  });
});
