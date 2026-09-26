import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { assertNoSharedProvisionSurvivors, resetSharedProvisions } from "./tests/support/postgres-container";

// Issue 736: with `isolate: false` the evaluated module graph is shared by
// every test file a worker runs, and a module's import bindings freeze at its
// FIRST evaluation. vitest consults one mock registry per test file, so the
// origin guard (`src/lib/security/server-action-origin.ts`) keeps whichever
// `next/headers` binding its first-evaluating file's registry held. A file
// that loads the landing/actions graph with no mock of its own bound the REAL
// `headers` into the guard for the worker's whole lifetime, and the landing
// tests' own `vi.mock("next/headers")` could never rebind it — the 1-in-4
// form-test failure. Register the request-headers stub as the DEFAULT for
// every file here: this setup re-runs before each test file, so each file's
// registry starts with the stub, and the graph can no longer be loaded without
// one in any ordering. A file's own `vi.mock("next/headers")` re-registers the
// same id and wins for that file, so per-file overrides keep working.
vi.mock("next/headers", async () => (await import("./tests/support/trusted-origin")).trustedRequestHeaders());

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
