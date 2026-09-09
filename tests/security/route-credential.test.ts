import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { guardByCredential, resolveRouteCredential } from "@/lib/security/route-credential";
import { mintApiToken } from "@/lib/security/api-token";
import {
  foreignOrigin,
  requestHost,
  trustedOrigin,
  useTrustedOrigin,
} from "../support/trusted-origin";

useTrustedOrigin();

const ownerId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000002";
const apiToken = `ovf_${"route-credential".padEnd(43, "_")}`;
const apiTokenHash = createHash("sha256").update(apiToken).digest();
const tokenRejection = {
  error: { code: "UNAUTHENTICATED", message: "The supplied API token was not accepted." },
};

function tokenRequest(headers: Record<string, string> = {}): Request {
  return new Request(new URL("/api/moderation", requestHost), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({}),
  });
}

describe("guardByCredential", () => {
  it("sends a bearer-carrying request past the origin guard, as the repositories route does", () => {
    // A programmatic client attaches the credential deliberately and sends no
    // Origin header; the credential is what makes the request trustworthy.
    const refusal = guardByCredential(tokenRequest({ authorization: `Bearer ${apiToken}` }));

    expect(refusal).toBeNull();
  });

  it("still refuses a bearer-carrying request whose body is not JSON", () => {
    const refusal = guardByCredential(
      tokenRequest({ authorization: `Bearer ${apiToken}`, "content-type": "text/plain" }),
    );

    expect(refusal).not.toBeNull();
    expect(refusal?.status).toBe(415);
  });

  it("refuses a bearer-carrying foreign-origin request on the media type alone, not the origin", () => {
    // Order matters here: a bearer credential is not a cookie a web page can
    // attach for its visitor, so a foreign origin alone refuses nothing.
    const refusal = guardByCredential(
      tokenRequest({ authorization: `Bearer ${apiToken}`, origin: foreignOrigin }),
    );

    expect(refusal).toBeNull();
  });

  it("keeps the origin guard for a request that carries no bearer credential", () => {
    const refusal = guardByCredential(tokenRequest({ origin: foreignOrigin }));

    expect(refusal).not.toBeNull();
    expect(refusal?.status).toBe(403);
  });

  it("keeps the origin guard for a trusted-origin request without a bearer credential", () => {
    const refusal = guardByCredential(
      tokenRequest({ origin: trustedOrigin, authorization: "Basic abc" }),
    );

    expect(refusal).toBeNull();
  });
});

describe("resolveRouteCredential", () => {
  it("resolves a bearer token to its owner with the role deliberately omitted", async () => {
    // The account row carries the role, and authorization must not take it:
    // the gate's own fresh-role lookup stays the single role authority.
    const findAccountByTokenHash = vi.fn().mockResolvedValue({
      id: ownerId,
      role: "MODERATOR",
      enforcementState: "ACTIVE",
    });

    const credential = await resolveRouteCredential(tokenRequest({ authorization: `Bearer ${apiToken}` }), {
      getSession: vi.fn(),
      findAccountByTokenHash,
    });

    expect(findAccountByTokenHash).toHaveBeenCalledExactlyOnceWith(apiTokenHash);
    expect(credential).toEqual({ user: { id: ownerId } });
  });

  it("rejects a malformed bearer with the credential rejection and no lookup", async () => {
    const credential = "deliberately-malformed-credential";
    const findAccountByTokenHash = vi.fn();
    const response = await resolveRouteCredential(
      tokenRequest({ authorization: `Bearer ${credential}` }),
      { getSession: vi.fn(), findAccountByTokenHash },
    );

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(401);
    await expect((response as Response).json()).resolves.toEqual(tokenRejection);
    expect(findAccountByTokenHash).not.toHaveBeenCalled();
  });

  it("rejects an unknown bearer with the same credential rejection", async () => {
    const findAccountByTokenHash = vi.fn().mockResolvedValue(null);
    const response = await resolveRouteCredential(tokenRequest({ authorization: `Bearer ${apiToken}` }), {
      getSession: vi.fn(),
      findAccountByTokenHash,
    });

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(401);
    await expect((response as Response).json()).resolves.toEqual(tokenRejection);
  });

  it("propagates a token-store failure for the caller's own error mapping", async () => {
    const findAccountByTokenHash = vi.fn().mockRejectedValue(new Error("token store outage"));

    await expect(
      resolveRouteCredential(tokenRequest({ authorization: `Bearer ${apiToken}` }), {
        getSession: vi.fn(),
        findAccountByTokenHash,
      }),
    ).rejects.toThrow("token store outage");
  });

  it("passes a session through untouched and never touches the token store", async () => {
    const session = { user: { id: memberId, role: "MEMBER" } };
    const getSession = vi.fn().mockResolvedValue(session);
    const findAccountByTokenHash = vi.fn();

    const credential = await resolveRouteCredential(tokenRequest(), { getSession, findAccountByTokenHash });

    expect(credential).toBe(session);
    expect(findAccountByTokenHash).not.toHaveBeenCalled();
  });

  it("passes a missing session through as null", async () => {
    const getSession = vi.fn().mockResolvedValue(null);

    const credential = await resolveRouteCredential(tokenRequest(), {
      getSession,
      findAccountByTokenHash: vi.fn(),
    });

    expect(credential).toBeNull();
  });

  it("propagates a session-lookup failure for the caller's own error mapping", async () => {
    const getSession = vi.fn().mockRejectedValue(new Error("session store outage"));

    await expect(
      resolveRouteCredential(tokenRequest(), {
        getSession,
        findAccountByTokenHash: vi.fn(),
      }),
    ).rejects.toThrow("session store outage");
  });

  it("takes the bearer path on credential presence alone, not credential validity", async () => {
    // A malformed credential has already taken the bearer path here — the
    // media-type guard ran with it — so the resolution still refuses the
    // credential instead of falling through to the cookie.
    const getSession = vi.fn();
    const response = await resolveRouteCredential(
      tokenRequest({ authorization: "Bearer deliberately-malformed-credential" }),
      { getSession, findAccountByTokenHash: vi.fn() },
    );

    expect(response).toBeInstanceOf(Response);
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe("the minted-token round trip", () => {
  it("resolves a freshly minted token to its owner by digest", async () => {
    const { token, tokenHash } = mintApiToken();
    const findAccountByTokenHash = vi.fn().mockResolvedValue({ id: ownerId });

    const credential = await resolveRouteCredential(tokenRequest({ authorization: `Bearer ${token}` }), {
      getSession: vi.fn(),
      findAccountByTokenHash,
    });

    expect(findAccountByTokenHash).toHaveBeenCalledExactlyOnceWith(tokenHash);
    expect(credential).toEqual({ user: { id: ownerId } });
  });
});
