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
    "test_pr_gate_recovery.py",
    "test_pr_gate_context.py",
    "test_pr_content.py",
  ])("passes %s against the real gate", (suite) => {
    assertPythonPassed(runPython([resolve("tests", suite)]));
  });

  it("rejects zero Python execution through the package bridge", () => {
    const result = runPython(["-c", [
      "import sys; sys.path.insert(0, 'tests'); import _util",
      "raise SystemExit(_util.runner(_util.collect({}), tmp_prefix='emptygate_'))",
    ].join("; ")]);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("No tests collected");
    expect(() => assertPythonPassed(result)).toThrow();
  });
});

function runPython(args: string[]) {
  return spawnSync("python3", args, {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: 60_000,
  });
}

function assertPythonPassed(result: ReturnType<typeof runPython>) {
  expect(result.error, result.error?.message).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const summaries = [...result.stdout.matchAll(/^(\d+) passed, (\d+) failed$/gm)];
  expect(summaries, result.stdout).toHaveLength(1);
  expect(Number(summaries[0]?.[1]), result.stdout).toBeGreaterThan(0);
  expect(Number(summaries[0]?.[2]), result.stdout).toBe(0);
}
