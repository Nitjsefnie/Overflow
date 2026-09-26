import { describe, expect, it } from "vitest";
import { MAX_REASON_LENGTH, reasonText } from "@/lib/validation/reason";

describe("reasonText", () => {
  it("exposes the 2000-character cap as a shared constant", () => {
    expect(MAX_REASON_LENGTH).toBe(2000);
  });

  it("accepts exactly MAX_REASON_LENGTH characters and rejects one more", () => {
    const schema = reasonText();
    expect(schema.parse("x".repeat(MAX_REASON_LENGTH))).toBe("x".repeat(MAX_REASON_LENGTH));
    expect(() => schema.parse("x".repeat(MAX_REASON_LENGTH + 1))).toThrow();
  });

  it("counts characters, not UTF-16 code units, against the cap", () => {
    const astral = "😀".repeat(MAX_REASON_LENGTH);
    expect(astral).toHaveLength(2 * MAX_REASON_LENGTH);
    expect(reasonText().parse(astral)).toBe(astral);
  });

  it("measures length after trimming", () => {
    expect(reasonText().parse(`  ${"x".repeat(MAX_REASON_LENGTH)}\n`)).toBe("x".repeat(MAX_REASON_LENGTH));
  });

  it("rejects a blank value", () => {
    expect(() => reasonText().parse("   ")).toThrow();
  });

  it("hands a blank value through when the service owns blank-rejection", () => {
    expect(reasonText({ allowBlank: true }).parse("   ")).toBe("");
    expect(() => reasonText({ allowBlank: true }).parse("x".repeat(MAX_REASON_LENGTH + 1))).toThrow();
  });
});
