import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("development server binding", () => {
  it("keeps pnpm dev on IPv4 loopback by default", () => {
    const { scripts } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    expect(scripts.dev).toBe("next dev --hostname 127.0.0.1");
  });
});
