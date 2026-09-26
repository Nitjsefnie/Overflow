import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { useTrustedOrigin } from "../support/trusted-origin";

// Issue 736: a test file's `vi.mock("next/headers")` is consulted only for
// module requests made while THAT file runs — vitest keeps one mock registry
// per test file, and with `isolate: false` the evaluated module graph is
// shared across every file a worker runs. The origin guard
// (`src/lib/security/server-action-origin.ts`) imports `headers` statically,
// so whichever file first loads the landing/actions graph in a worker freezes
// the binding the guard keeps for the worker's whole lifetime: a file that
// loads the graph with no next/headers mock in its own registry binds the
// REAL `headers`, and a later file's own mock can never rebind it. Four test
// files import the landing page; three register no next/headers mock of their
// own, and two of those three self-clean with a vi.resetModules() reset pair,
// leaving one file (tests/components/account-data-page.test.tsx) that loads
// the graph real-bound and leaves it cached. When the
// landing tests then ran after that file in the same worker, the guard read
// the real `headers` outside a request scope, threw, and the action never
// reached `signIn` — the 1-in-4 leg failure.
//
// vitest.setup.ts therefore registers the request-headers stub as the DEFAULT
// for every test file, so the graph can never be loaded without one. This file
// pins that guarantee where a mutant can fail it: it deliberately registers NO
// next/headers mock of its own, clears the shared graph, and runs the REAL
// action through the REAL guard. On a tree where the default stub is missing
// (or a regression reopens the order dependence), the guard binds the real
// `headers` and this test fails with the exact signature from the issue:
// "`headers` was called outside a request scope".
const signIn = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ signIn }));

useTrustedOrigin();

// Dynamic auth imports retain this file's mocks until the graph is cleared.
afterAll(() => {
  vi.resetModules();
});

describe("the server action origin guard's request-headers stub", () => {
  afterEach(() => {
    signIn.mockReset();
  });

  it("guards a server action even in a file that registers no next/headers mock of its own", async () => {
    // Clear the shared graph so this file is the guard's first evaluator in
    // the worker regardless of what its worker-mates ran before it: the
    // re-evaluated guard must bind a request-headers stub, not the real
    // module, or every action below refuses with the misconfigured/foreign
    // origin error instead of exercising the sign-in path.
    vi.resetModules();
    const { signInAsContributor } = await import("@/lib/auth/sign-in-actions");

    await signInAsContributor();

    expect(signIn).toHaveBeenCalledExactlyOnceWith("github", { redirectTo: "/dashboard" }, { scope: "" });
  });
});
