import { describe, expect, it } from "vitest";
import { reconciliationAppInstallUrl } from "@/lib/github/reconciliation-app-install-url";

describe("reconciliation App installation URL", () => {
  // An incorrect path or rejection of valid edge slugs breaks installation links.
  it.each(["overflow-reconcile", "a", "0", "app--2"])("links a valid slug: %s", (slug) => {
    expect(reconciliationAppInstallUrl({ GITHUB_APP_SLUG: slug }))
      .toBe(`https://github.com/apps/${slug}/installations/new`);
  });

  // Missing validation would expose a broken or injected installation URL.
  it.each([undefined, "", " ", " App", "App", "-app", "app-", "app_name", "app/name", "app?x=1", "app#x", "app.example", "https://example.test", "app\n"])(
    "hides the offer for an absent or malformed slug: %s", (slug) => {
      expect(reconciliationAppInstallUrl({ GITHUB_APP_SLUG: slug })).toBeNull();
    },
  );

  it("hides the offer when the variable is unset", () => {
    expect(reconciliationAppInstallUrl({})).toBeNull();
  });
});
