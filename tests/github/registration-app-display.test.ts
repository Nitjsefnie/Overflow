import { describe, expect, it } from "vitest";
import { registrationAppConfigured, registrationAppInstallUrl } from "@/lib/github/registration-app-display";

describe("registration App display", () => {
  it.each([undefined, "", "Uppercase", "-app", "app-", "a/b", "a?b", "a b", "a\n"])(
    "does not link an absent or invalid slug %s", (slug) => expect(registrationAppInstallUrl(slug)).toBeNull(),
  );
  it.each(["a", "overflow-registration", "app123"])("links valid slug %s", (slug) => {
    expect(registrationAppInstallUrl(slug)).toBe(`https://github.com/apps/${slug}/installations/new`);
  });
  it.each([undefined, ""])("requires both nonempty unprefixed settings (%s)", (missing) => {
    expect(registrationAppConfigured({})).toBe(false);
    expect(registrationAppConfigured({ GITHUB_REGISTRATION_APP_ID: "1" })).toBe(false);
    expect(registrationAppConfigured({ GITHUB_REGISTRATION_APP_ID: missing, GITHUB_REGISTRATION_APP_PRIVATE_KEY_PATH: "missing.pem" })).toBe(false);
    expect(registrationAppConfigured({ GITHUB_REGISTRATION_APP_ID: "1", GITHUB_REGISTRATION_APP_PRIVATE_KEY_PATH: missing })).toBe(false);
  });
  it("checks presence without reading or parsing a key", () => {
    expect(registrationAppConfigured({ GITHUB_REGISTRATION_APP_ID: "invalid-id",
      GITHUB_REGISTRATION_APP_PRIVATE_KEY_PATH: "/this/file/does/not/exist.pem" })).toBe(true);
  });
});
