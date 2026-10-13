import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("development server binding", () => {
  it("keeps pnpm dev on IPv4 loopback by default", () => {
    const { scripts } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const args = scripts.dev.trim().split(/\s+/);
    const hostnameFlag = args.lastIndexOf("--hostname");

    expect(hostnameFlag).toBeGreaterThan(-1);
    expect(args[hostnameFlag + 1]).toBe("127.0.0.1");
  });
});
