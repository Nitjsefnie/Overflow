import { describe, expect, it } from "vitest";
import config from "../../next.config";

describe("Next.js agent rule generation", () => {
  it("disables generated agent rule files", () => {
    expect(config.agentRules).toBe(false);
  });
});
