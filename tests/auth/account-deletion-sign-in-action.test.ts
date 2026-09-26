import { afterAll, expect, it, vi } from "vitest";
import { GITHUB_CONTRIBUTOR_SCOPE } from "@/lib/auth/github-oauth-scopes";
import { confirmSignInForAccountDeletion } from "@/lib/auth/account-deletion-sign-in-action";
import { useTrustedOrigin } from "../support/trusted-origin";

// Dynamic auth imports retain this file's mocks until the graph is cleared.
afterAll(() => { vi.resetModules(); });

const { signIn } = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("@/auth", () => ({ signIn }));

// Issue 700: the action opens with the origin guard, so the request headers
// must name the trusted origin (APP_URL is stubbed by useTrustedOrigin).
vi.mock("next/headers", async () => (await import("../support/trusted-origin")).trustedRequestHeaders());

useTrustedOrigin();

it("reconfirms GitHub sign-in with contributor scope and returns to the dashboard", async () => {
  await confirmSignInForAccountDeletion();
  expect(signIn).toHaveBeenCalledExactlyOnceWith("github", { redirectTo: "/dashboard" }, { scope: GITHUB_CONTRIBUTOR_SCOPE });
});
