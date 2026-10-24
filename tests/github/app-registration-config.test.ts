import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readGitHubRegistrationAppAuthConfig } from "@/lib/github/app-installation-auth";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const env = {
  GITHUB_REGISTRATION_APP_ID: "202",
  GITHUB_REGISTRATION_APP_PRIVATE_KEY_PATH: "/keys/register.pem",
};

describe("registration GitHub App config", () => {
  it("reads the App's own id and key path", () => {
    const paths: string[] = [];
    const read = (path: string) => { paths.push(path); return pem; };
    expect(readGitHubRegistrationAppAuthConfig(env, read)).toEqual({ appId: "202", privateKey: pem });
    expect(paths).toEqual(["/keys/register.pem"]);
  });

  it.each([undefined, ""])("treats a missing registration variable (%s) as unconfigured", (value) => {
    for (const name of ["GITHUB_REGISTRATION_APP_ID", "GITHUB_REGISTRATION_APP_PRIVATE_KEY_PATH"]) {
      const partial = { ...env, [name]: value };
      expect(readGitHubRegistrationAppAuthConfig(partial, () => { throw new Error("unexpected read"); })).toBeNull();
    }
  });

  it("returns null with neither registration variable configured", () => {
    expect(readGitHubRegistrationAppAuthConfig({}, () => { throw new Error("unexpected read"); })).toBeNull();
  });

  it("names the registration key variable when a configured file is unreadable", () => {
    expect(() => readGitHubRegistrationAppAuthConfig(env, () => { throw new Error("EACCES"); }))
      .toThrow("GITHUB_REGISTRATION_APP_PRIVATE_KEY_PATH");
  });

  it.each(["unparseable", "non-RSA"])("rejects a configured %s key at wiring time with its own variable name", (kind) => {
    const key = kind === "non-RSA"
      ? generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString()
      : "invalid private key";
    expect(() => readGitHubRegistrationAppAuthConfig(env, () => key))
      .toThrow("GITHUB_REGISTRATION_APP_PRIVATE_KEY_PATH");
  });
});
