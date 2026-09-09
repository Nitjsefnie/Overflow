import { describe, expect, it } from "vitest";
import { enforcementStateLabel, visibilityLabel } from "@/lib/dashboard/labels";

describe("visibilityLabel", () => {
  it("reads PUBLIC as Public", () => {
    expect(visibilityLabel("PUBLIC")).toBe("Public");
  });

  it("reads PRIVATE as Private", () => {
    expect(visibilityLabel("PRIVATE")).toBe("Private");
  });

  it("reads a value the schema does not admit as Unknown", () => {
    expect(visibilityLabel("INTERNAL")).toBe("Unknown");
  });
});

describe("enforcementStateLabel", () => {
  it("reads ACTIVE as Active", () => {
    expect(enforcementStateLabel("ACTIVE")).toBe("Active");
  });

  it("reads UNDER_AUDIT as Under audit", () => {
    expect(enforcementStateLabel("UNDER_AUDIT")).toBe("Under audit");
  });

  it("reads WARNED as Warned", () => {
    expect(enforcementStateLabel("WARNED")).toBe("Warned");
  });

  it("reads RECALIBRATING as Recalibrating", () => {
    expect(enforcementStateLabel("RECALIBRATING")).toBe("Recalibrating");
  });

  it("reads BANNED as Banned", () => {
    expect(enforcementStateLabel("BANNED")).toBe("Banned");
  });

  it("reads a state the schema does not admit as Unknown", () => {
    expect(enforcementStateLabel("SUSPENDED")).toBe("Unknown");
  });
});
