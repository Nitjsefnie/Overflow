import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { assertNoSharedProvisionSurvivors, resetSharedProvisions } from "./tests/support/postgres-container";

beforeAll(() => {
  // Workers are reused across files (isolate:false), so the provision
  // registry must be cleared once per FILE, not per test: suites provision
  // in beforeAll, which runs before any per-test hook and would otherwise be
  // erased before the audit could ever see it. A beforeAll registered in a
  // setup file attaches to the file's root suite, so it runs before every
  // describe-level beforeAll — exactly the per-file boundary needed.
  resetSharedProvisions();
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  // While this worker is still alive, fail the file loudly if any role this
  // file provisioned on the shared server still holds a connection: the
  // shared server removed the loud tripwire a leaked pool used to produce,
  // and globalSetup teardown cannot see worker-held sockets (vitest reaps
  // the workers before it runs).
  await assertNoSharedProvisionSurvivors();
});
