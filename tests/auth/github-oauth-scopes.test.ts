import { describe, expect, it } from "vitest";
import {
  GITHUB_CONTRIBUTOR_SCOPE,
  GITHUB_REPOSITORY_REGISTRATION_SCOPE,
  grantsWebhookAdministration,
  parseGrantedScopes,
} from "@/lib/auth/github-oauth-scopes";

// Issue 599: GitHub reports granted scopes comma-delimited in the token
// response (`scope` claim) and comma-and-space-delimited in the
// X-OAuth-Scopes header; a request spells them space-delimited.
describe("parseGrantedScopes", () => {
  it.each([
    { label: "an empty string", raw: "", expected: [] },
    { label: "whitespace only", raw: "  ", expected: [] },
    { label: "an absent value", raw: undefined, expected: [] },
    { label: "a null value", raw: null, expected: [] },
    { label: "a non-string value", raw: 42, expected: [] },
    { label: "one scope", raw: "admin:repo_hook", expected: ["admin:repo_hook"] },
    { label: "a comma-delimited token response", raw: "admin:repo_hook,read:user", expected: ["admin:repo_hook", "read:user"] },
    { label: "a comma-and-space-delimited header", raw: "repo, read:user", expected: ["repo", "read:user"] },
    { label: "a space-delimited request", raw: "public_repo user:email", expected: ["public_repo", "user:email"] },
    { label: "surrounding whitespace and trailing delimiters", raw: " repo , ", expected: ["repo"] },
  ])("reads $label", ({ raw, expected }) => {
    expect(parseGrantedScopes(raw)).toEqual(expected);
  });
});

describe("grantsWebhookAdministration", () => {
  it.each([
    { label: "the contributor grant", scopes: parseGrantedScopes(GITHUB_CONTRIBUTOR_SCOPE), expected: false },
    { label: "the registration grant", scopes: parseGrantedScopes(GITHUB_REPOSITORY_REGISTRATION_SCOPE), expected: true },
    { label: "full repository access", scopes: ["repo"], expected: true },
    { label: "public repository access", scopes: ["public_repo"], expected: true },
    { label: "hook administration beside identity scopes", scopes: ["read:user", "admin:repo_hook"], expected: true },
    { label: "hook write without delete", scopes: ["write:repo_hook"], expected: false },
    { label: "hook read only", scopes: ["read:repo_hook"], expected: false },
    { label: "identity scopes alone", scopes: ["read:user", "user:email"], expected: false },
    { label: "a prefix that is not the scope", scopes: ["admin:repo_hooks"], expected: false },
    { label: "a differently cased spelling", scopes: ["Admin:Repo_Hook"], expected: false },
  ])("answers $expected for $label", ({ scopes, expected }) => {
    expect(grantsWebhookAdministration(scopes)).toBe(expected);
  });
});
