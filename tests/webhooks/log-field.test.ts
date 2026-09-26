import { describe, expect, it } from "vitest";
import { logField } from "@/lib/webhooks/log-field";

// Every code point the token must never carry literally: C0, DEL, C1, the two
// Unicode line/paragraph separators, and the bidi controls that can reorder
// what an operator reads on a terminal.
const forbiddenClasses: Array<{ name: string; from: number; to: number }> = [
  { name: "C0 controls", from: 0x00, to: 0x1f },
  { name: "DEL", from: 0x7f, to: 0x7f },
  { name: "C1 controls", from: 0x80, to: 0x9f },
  { name: "line separator", from: 0x2028, to: 0x2028 },
  { name: "paragraph separator", from: 0x2029, to: 0x2029 },
  { name: "bidi marks", from: 0x200e, to: 0x200f },
  { name: "bidi embeddings and overrides", from: 0x202a, to: 0x202e },
  { name: "bidi isolates", from: 0x2066, to: 0x2069 },
];

function codePointsIn(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function forbiddenCodeUnitsIn(text: string): number[] {
  const found: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (forbiddenClasses.some(({ from, to }) => unit >= from && unit <= to)) found.push(unit);
  }
  return found;
}

// A surrogate with no partner on the correct side, read per UTF-16 code unit.
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("logField", () => {
  it("wraps plain text in double quotes and changes nothing else", () => {
    expect(logField("gitlab-org/gitlab")).toBe("\"gitlab-org/gitlab\"");
    expect(logField("")).toBe("\"\"");
    expect(logField("héllo wörld 😀")).toBe("\"héllo wörld 😀\"");
  });

  it("escapes a double quote and a backslash so the closing quote is unambiguous", () => {
    expect(logField("a\"b\\c")).toBe("\"a\\\"b\\\\c\"");
    expect(logField("\" (+5 more)")).toBe("\"\\\" (+5 more)\"");
  });

  it.each(forbiddenClasses)("emits every code point in $name as a \\uXXXX escape", ({ from, to }) => {
    for (const codePoint of codePointsIn(from, to)) {
      const input = `a${String.fromCharCode(codePoint)}b`;
      const output = logField(input);
      expect(forbiddenCodeUnitsIn(output)).toEqual([]);
      expect(output).toBe(`"a\\u${codePoint.toString(16).padStart(4, "0")}b"`);
    }
  });

  it("leaves no forbidden code point in a token built from all of them at once", () => {
    const everything = forbiddenClasses
      .flatMap(({ from, to }) => codePointsIn(from, to))
      .map((codePoint) => String.fromCharCode(codePoint))
      .join("");
    expect(forbiddenCodeUnitsIn(everything).length).toBeGreaterThan(0);
    expect(forbiddenCodeUnitsIn(logField(everything))).toEqual([]);
  });

  it("decodes back to the input as a JSON string when nothing is truncated", () => {
    const input = "ns\n\u001b[2J\"\\ ‮\u0085\uD800x";
    expect(JSON.parse(logField(input))).toBe(input);
  });

  it("keeps at most 256 code units and names how many were dropped", () => {
    const output = logField("x".repeat(10_000));
    expect(output).toBe(`"${"x".repeat(256)}"… (+9744 more)`);
  });

  it("bounds the token even when every kept code unit needs an escape", () => {
    const output = logField("\n".repeat(10_000));
    // 256 six-character escapes, the two quotes and the marker.
    expect(output.length).toBeLessThanOrEqual(256 * 6 + 2 + " (+9744 more)…".length);
    expect(output.endsWith("… (+9744 more)")).toBe(true);
    expect(forbiddenCodeUnitsIn(output)).toEqual([]);
  });

  it("does not truncate an input of exactly 256 code units", () => {
    expect(logField("y".repeat(256))).toBe(`"${"y".repeat(256)}"`);
  });

  it("escapes the high surrogate a cut through a surrogate pair leaves behind", () => {
    // Code units 0..254 are "a", 255..256 are the pair for U+1F600, so the
    // 256-unit cut keeps only its high half.
    const input = `${"a".repeat(255)}😀${"b".repeat(10)}`;
    const output = logField(input);
    expect(loneSurrogate.test(output)).toBe(false);
    expect(output).toBe(`"${"a".repeat(255)}\\ud83d"… (+11 more)`);
  });

  it("keeps a surrogate pair literal and escapes a lone surrogate anywhere", () => {
    expect(logField("😀")).toBe("\"😀\"");
    const output = logField("a\uDC00b\uD800");
    expect(loneSurrogate.test(output)).toBe(false);
    expect(output).toBe("\"a\\udc00b\\ud800\"");
  });
});
