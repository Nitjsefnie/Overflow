import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pins the maxWorkers resolution in vitest.config.ts (issue 626). The config
 * reads the environment once at module load, so every case resets the module
 * registry, shapes process.env, then imports the config fresh.
 *
 * The matrix: a numeric VITEST_MAX_WORKERS always wins; without it the key
 * stays absent — vitest's own unbounded default — when CI is set; otherwise a
 * local default of 2 bounds the worker pool. A non-numeric VITEST_MAX_WORKERS
 * is treated as unset.
 *
 * Written first (TDD): before vitest.config.ts grew the issue-626 block these
 * fail on the absent maxWorkers. The CI-unbounded case is green before the
 * implementation too — the key is absent because nothing sets it — and gets
 * its teeth from the mutant proof: inverting the CI check must fail this case
 * by name.
 */

type VitestConfigModule = typeof import("../../vitest.config.ts");

const savedMaxWorkers = process.env.VITEST_MAX_WORKERS;
const savedCi = process.env.CI;

async function importTestConfig(): Promise<NonNullable<VitestConfigModule["default"]["test"]>> {
  const config = (await import("../../vitest.config.ts")).default;
  expect(config.test, "vitest.config.ts must keep a test block").toBeDefined();
  return config.test!;
}

afterAll(() => {
  if (savedMaxWorkers === undefined) {
    delete process.env.VITEST_MAX_WORKERS;
  } else {
    process.env.VITEST_MAX_WORKERS = savedMaxWorkers;
  }
  if (savedCi === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = savedCi;
  }
});

describe("vitest.config.ts maxWorkers resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.VITEST_MAX_WORKERS;
    delete process.env.CI;
  });

  it("honours a numeric VITEST_MAX_WORKERS even when CI is set", async () => {
    process.env.VITEST_MAX_WORKERS = "4";
    process.env.CI = "1";
    expect((await importTestConfig()).maxWorkers).toBe(4);
  });

  it("leaves maxWorkers absent — unbounded — when CI is set and VITEST_MAX_WORKERS is unset", async () => {
    process.env.CI = "1";
    expect(await importTestConfig()).not.toHaveProperty("maxWorkers");
  });

  it("bounds the pool at 2 locally, with neither VITEST_MAX_WORKERS nor CI set", async () => {
    expect((await importTestConfig()).maxWorkers).toBe(2);
  });

  it("honours a numeric VITEST_MAX_WORKERS with CI unset too", async () => {
    // beforeEach leaves CI unset; the override must not depend on CI being set.
    process.env.VITEST_MAX_WORKERS = "4";
    expect((await importTestConfig()).maxWorkers).toBe(4);
  });

  it.each(["lots", "4x", "3.5", "", "-2", " 4"])(
    "treats the non-numeric VITEST_MAX_WORKERS %j as unset (CI set, so unbounded)",
    async (value) => {
      process.env.VITEST_MAX_WORKERS = value;
      process.env.CI = "1";
      expect(await importTestConfig()).not.toHaveProperty("maxWorkers");
    },
  );

  it("treats a non-numeric VITEST_MAX_WORKERS as unset for the local default too", async () => {
    process.env.VITEST_MAX_WORKERS = "4x";
    expect((await importTestConfig()).maxWorkers).toBe(2);
  });

  it("pins teardownTimeout at 120 seconds for the shared-container teardown", async () => {
    expect((await importTestConfig()).teardownTimeout).toBe(120_000);
  });
});
