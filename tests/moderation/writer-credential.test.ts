import { describe, expect, it } from "vitest";
import type { RouteCredentialReference } from "@/lib/security/route-credential";
import { credentialKind, credentialTokenId } from "@/lib/moderation/writer-credential";

/**
 * The two functions every privileged-action row's credential columns are written
 * from, so they are where the shape the database accepts is produced.
 *
 * `db/migrations/054_privileged_action_credentials.sql` constrains each row to
 * exactly one of three pairs: (NULL, NULL) for a writer with no HTTP request
 * behind it, ('session', NULL) behind a cookie session, and ('token', a
 * `api_tokens` id) behind a bearer token. ('session', a token id) is the pair the
 * CHECK rejects, and a session has no issuance to name, so the token id has to be
 * decided from the kind alone rather than read off whatever the reference
 * happens to carry.
 */

const TOKEN_ISSUANCE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SECOND_ISSUANCE_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";

function credentialColumns(credential: RouteCredentialReference | null): [string | null, string | null] {
  return [credentialKind(credential), credentialTokenId(credential)];
}

describe("the credential columns a privileged-action row records", () => {
  it("records the token's issuance id behind a bearer credential", () => {
    const token: RouteCredentialReference = { kind: "token", tokenId: TOKEN_ISSUANCE_ID };

    expect(credentialColumns(token)).toEqual(["token", TOKEN_ISSUANCE_ID]);
  });

  it("records the session kind and no token id behind a cookie session", () => {
    const session: RouteCredentialReference = { kind: "session" };

    expect(credentialColumns(session)).toEqual(["session", null]);
  });

  it("records both columns as null for a writer with no HTTP request behind it", () => {
    // Null, not undefined: the pair goes into the row as it stands, and only the
    // (NULL, NULL) pair is the one the CHECK accepts for a writer with no
    // credential.
    expect(credentialKind(null)).toBeNull();
    expect(credentialTokenId(null)).toBeNull();
  });

  it("records no token id for a session kind, whatever the reference also carries", () => {
    // The reference is a plain object the gate built, so a field the type does not
    // declare can still be on it. Deciding the token id from the KIND is what
    // keeps the ('session', <id>) pair — the one the CHECK rejects — unwritten.
    const sessionCarryingAnIssuance = {
      kind: "session",
      tokenId: TOKEN_ISSUANCE_ID,
    } as unknown as RouteCredentialReference;

    expect(credentialColumns(sessionCarryingAnIssuance)).toEqual(["session", null]);
  });

  it("records the issuance id as it stands, with no truthiness filter applied to it", () => {
    // A filter here is the ('session', <id>) failure mode mirrored: a falsy id
    // collapsed to null turns a token row into the ('token', NULL) pair, which is
    // a pair the CHECK refuses — so the id crosses as the reference carries it, or
    // it does not cross at all.
    const tokenCarryingEmptyIssuance: RouteCredentialReference = { kind: "token", tokenId: "" };

    expect(credentialColumns(tokenCarryingEmptyIssuance)).toEqual(["token", ""]);
  });

  it("records a kind the CHECK does not accept verbatim rather than as one it does", () => {
    // The CHECK takes exactly 'session', 'token' and null, and a reference is a
    // plain object the gate built, so a kind outside that set is reachable in
    // principle. Recording it as written is what makes the CHECK refuse the row:
    // normalizing it to 'session' instead would write a pair the database accepts
    // for a credential that was in fact neither, which is the misattribution this
    // column exists to prevent.
    const undeclaredKind = { kind: "api_key" } as unknown as RouteCredentialReference;

    expect(credentialColumns(undeclaredKind)).toEqual(["api_key", null]);
  });

  it("records each token reference's own issuance, keeping the kind column the same across issuances", () => {
    const first: RouteCredentialReference = { kind: "token", tokenId: TOKEN_ISSUANCE_ID };
    const second: RouteCredentialReference = { kind: "token", tokenId: SECOND_ISSUANCE_ID };

    // Two issuances of the same kind: the kind column cannot move, and the token
    // id column is the reference's own — a rotation is visible as a different id
    // on the row that recorded the previous one.
    expect(credentialKind(first)).toBe(credentialKind(second));
    expect(credentialColumns(first)).toEqual(["token", TOKEN_ISSUANCE_ID]);
    expect(credentialColumns(second)).toEqual(["token", SECOND_ISSUANCE_ID]);
  });
});
