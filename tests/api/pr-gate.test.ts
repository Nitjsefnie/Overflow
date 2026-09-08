import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("pull-request admission gate Python suites", () => {
  it.each([
    "test_pr_gate.py",
    "test_pr_gate_claims.py",
    "test_pr_body.py",
    "test_pr_body_closing.py",
    "test_pr_body_elements.py",
    "test_pr_body_overflow.py",
  ])("passes %s against the real gate", (suite) => {
    const result = spawnSync("python3", [resolve("tests", suite)], {
      cwd: resolve("."),
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.error, result.error?.message).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
