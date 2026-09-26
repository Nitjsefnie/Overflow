import { expect, it, vi } from "vitest";
import { GITHUB_CONTRIBUTOR_SCOPE } from "@/lib/auth/github-oauth-scopes";
import { confirmSignInForAccountDeletion } from "@/lib/auth/account-deletion-sign-in-action";

const { signIn } = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("@/auth", () => ({ signIn }));

it("reconfirms GitHub sign-in with contributor scope and returns to the dashboard", async () => {
  await confirmSignInForAccountDeletion();
  expect(signIn).toHaveBeenCalledExactlyOnceWith("github", { redirectTo: "/dashboard" }, { scope: GITHUB_CONTRIBUTOR_SCOPE });
});
