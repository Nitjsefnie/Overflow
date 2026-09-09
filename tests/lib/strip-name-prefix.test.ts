import { describe, expect, it } from "vitest";
import { stripNamePrefix } from "@/lib/strip-name-prefix";

describe("stripNamePrefix", () => {
  it("strips the resolved name and its colon separator from the head of the label", () => {
    expect(stripNamePrefix("perceived difficulty: 3", "perceived difficulty")).toBe("3");
  });

  it.each([
    ["3"],
    ["Unknown label"],
    ["Awaiting settlement"],
  ])("returns a label without the exact prefix unchanged (%s)", (label) => {
    expect(stripNamePrefix(label, "perceived difficulty")).toBe(label);
  });

  it("requires the whole name, not a trailing fragment of it", () => {
    expect(stripNamePrefix("perceived difficulty: 3", "difficulty")).toBe("perceived difficulty: 3");
  });

  it("strips nothing when the prefix differs from the name only by case", () => {
    expect(stripNamePrefix("perceived difficulty: 3", "Perceived difficulty")).toBe("perceived difficulty: 3");
  });

  it("leaves a bare name without the colon separator alone", () => {
    expect(stripNamePrefix("perceived difficulty", "perceived difficulty")).toBe("perceived difficulty");
  });

  it("strips nothing when the resolved name is absent", () => {
    expect(stripNamePrefix("perceived difficulty: 3", undefined)).toBe("perceived difficulty: 3");
  });

  it("strips nothing against an empty name", () => {
    expect(stripNamePrefix("perceived difficulty: 3", "")).toBe("perceived difficulty: 3");
  });

  it("strips once, from the head only", () => {
    expect(stripNamePrefix("perceived difficulty: perceived difficulty: 3", "perceived difficulty")).toBe(
      "perceived difficulty: 3",
    );
  });
});
