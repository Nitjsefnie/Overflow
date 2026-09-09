import { describe, expect, it } from "vitest";
import { plural } from "@/lib/plural";

describe("plural", () => {
  it("reads one as the singular", () => {
    expect(plural(1, "credit")).toBe("credit");
  });

  it.each([0, 2, 10])("reads %s as the default plural", (count) => {
    expect(plural(count, "credit")).toBe("credits");
  });

  it("uses an explicit plural form when one is given", () => {
    expect(plural(2, "shelf", "shelves")).toBe("shelves");
    expect(plural(1, "shelf", "shelves")).toBe("shelf");
  });
});
