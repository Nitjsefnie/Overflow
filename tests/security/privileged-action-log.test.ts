import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { logPrivilegedAction, readClientAddress } from "@/lib/security/privileged-action-log";

function requestWith(headers: Record<string, string>): Request {
  return new Request("https://overflow.internal/api/moderation", { headers });
}

describe("readClientAddress", () => {
  const proxySecret = "unit-proxy-secret-1044";
  const secretHeaderName = "x-privileged-proxy-secret";

  let savedSecret: string | undefined;
  let hadSecret = false;

  function setProxySecret(value: string | undefined): void {
    if (!hadSecret) {
      hadSecret = "PRIVILEGED_PROXY_SECRET" in process.env;
      savedSecret = process.env.PRIVILEGED_PROXY_SECRET;
    }
    if (value === undefined) {
      delete process.env.PRIVILEGED_PROXY_SECRET;
    } else {
      process.env.PRIVILEGED_PROXY_SECRET = value;
    }
  }

  afterEach(() => {
    if (hadSecret) {
      process.env.PRIVILEGED_PROXY_SECRET = savedSecret;
    } else {
      delete process.env.PRIVILEGED_PROXY_SECRET;
    }
    hadSecret = false;
    savedSecret = undefined;
  });

  it("returns an IPv4 X-Real-IP value, unverified without the proxy secret", () => {
    setProxySecret(undefined);
    expect(readClientAddress(requestWith({ "x-real-ip": "203.0.113.7" }))).toEqual({
      clientAddress: "203.0.113.7",
      clientAddressVerified: false,
    });
  });

  it("returns an IPv6 X-Real-IP value, unverified without the proxy secret", () => {
    setProxySecret(undefined);
    expect(readClientAddress(requestWith({ "x-real-ip": "2001:db8::17" }))).toEqual({
      clientAddress: "2001:db8::17",
      clientAddressVerified: false,
    });
  });

  it("trims surrounding whitespace before validating", () => {
    setProxySecret(undefined);
    expect(readClientAddress(requestWith({ "x-real-ip": "  198.51.100.4 " }))).toEqual({
      clientAddress: "198.51.100.4",
      clientAddressVerified: false,
    });
  });

  it("marks the address verified when the secret header carries the configured secret", () => {
    setProxySecret(proxySecret);
    expect(
      readClientAddress(requestWith({ "x-real-ip": "203.0.113.7", [secretHeaderName]: proxySecret })),
    ).toEqual({ clientAddress: "203.0.113.7", clientAddressVerified: true });
  });

  it("marks an IPv6 address verified too", () => {
    setProxySecret(proxySecret);
    expect(
      readClientAddress(requestWith({ "x-real-ip": "2001:db8::17", [secretHeaderName]: proxySecret })),
    ).toEqual({ clientAddress: "2001:db8::17", clientAddressVerified: true });
  });

  it("answers unverified when the secret header is absent", () => {
    setProxySecret(proxySecret);
    expect(readClientAddress(requestWith({ "x-real-ip": "203.0.113.7" }))).toEqual({
      clientAddress: "203.0.113.7",
      clientAddressVerified: false,
    });
  });

  it("answers unverified when the secret header is wrong", () => {
    setProxySecret(proxySecret);
    expect(
      readClientAddress(
        requestWith({ "x-real-ip": "203.0.113.7", [secretHeaderName]: "not-the-configured-secret" }),
      ),
    ).toEqual({ clientAddress: "203.0.113.7", clientAddressVerified: false });
  });

  it("answers unverified when the configured secret is the empty string", () => {
    setProxySecret("");
    expect(
      readClientAddress(requestWith({ "x-real-ip": "203.0.113.7", [secretHeaderName]: "" })),
    ).toEqual({ clientAddress: "203.0.113.7", clientAddressVerified: false });
  });

  it("answers unverified when a secret header arrives while no secret is configured (fail-safe)", () => {
    setProxySecret(undefined);
    expect(
      readClientAddress(requestWith({ "x-real-ip": "203.0.113.7", [secretHeaderName]: proxySecret })),
    ).toEqual({ clientAddress: "203.0.113.7", clientAddressVerified: false });
  });

  it("answers unverified when the address itself is missing, even with a matching secret", () => {
    setProxySecret(proxySecret);
    expect(readClientAddress(requestWith({ [secretHeaderName]: proxySecret }))).toEqual({
      clientAddress: null,
      clientAddressVerified: false,
    });
  });

  it.each(["", "not-an-address", "203.0.113.7, 198.51.100.4", "999.1.1.1", "203.0.113.7:443"])(
    "returns null for the unparseable value %j",
    (value) => {
      setProxySecret(proxySecret);
      expect(readClientAddress(requestWith({ "x-real-ip": value, [secretHeaderName]: proxySecret }))).toEqual({
        clientAddress: null,
        clientAddressVerified: false,
      });
    },
  );

  it("never falls back to X-Forwarded-For", () => {
    setProxySecret(proxySecret);
    expect(
      readClientAddress(requestWith({ "x-forwarded-for": "203.0.113.7", [secretHeaderName]: proxySecret })),
    ).toEqual({ clientAddress: null, "clientAddressVerified": false });
  });

  it("prefers X-Real-IP and ignores a disagreeing X-Forwarded-For", () => {
    setProxySecret(proxySecret);
    const request = requestWith({
      "x-real-ip": "198.51.100.4",
      "x-forwarded-for": "203.0.113.7",
      [secretHeaderName]: proxySecret,
    });
    expect(readClientAddress(request)).toEqual({ clientAddress: "198.51.100.4", clientAddressVerified: true });
  });
});

describe("logPrivilegedAction", () => {
  let consoleInfo: MockInstance<typeof console.info>;

  beforeEach(() => {
    consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleInfo.mockRestore();
  });

  it("writes one fixed message followed by one plain object", () => {
    logPrivilegedAction({
      action: "moderator-role.grant",
      actorId: "00000000-0000-4000-8000-000000000001",
      credential: { kind: "token", tokenId: "00000000-0000-4000-8000-0000000000aa" },
      clientAddress: "203.0.113.7",
      clientAddressVerified: false,
      subject: { targetAccountId: "00000000-0000-4000-8000-000000000002" },
    });

    expect(consoleInfo).toHaveBeenCalledTimes(1);
    expect(consoleInfo.mock.calls[0]).toEqual([
      "Privileged action",
      {
        action: "moderator-role.grant",
        actorId: "00000000-0000-4000-8000-000000000001",
        credential: { kind: "token", tokenId: "00000000-0000-4000-8000-0000000000aa" },
        clientAddress: "203.0.113.7",
        clientAddressVerified: false,
        subject: { targetAccountId: "00000000-0000-4000-8000-000000000002" },
      },
    ]);
  });

  it("logs the record with exactly the entry's keys, clientAddressVerified among them", () => {
    logPrivilegedAction({
      action: "audit.open",
      actorId: "00000000-0000-4000-8000-000000000001",
      credential: { kind: "session" },
      clientAddress: "203.0.113.7",
      clientAddressVerified: true,
      subject: { auditId: "00000000-0000-4000-8000-000000000003" },
    });

    const record = consoleInfo.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(record).sort()).toStrictEqual([
      "action",
      "actorId",
      "clientAddress",
      "clientAddressVerified",
      "credential",
      "subject",
    ]);
  });

  it("logs a session reference as its kind alone, and a verified address as verified", () => {
    logPrivilegedAction({
      action: "audit.dismiss",
      actorId: "00000000-0000-4000-8000-000000000001",
      credential: { kind: "session" },
      clientAddress: null,
      clientAddressVerified: false,
      subject: { auditId: "00000000-0000-4000-8000-000000000003" },
    });

    expect(consoleInfo.mock.calls[0]?.[1]).toEqual({
      action: "audit.dismiss",
      actorId: "00000000-0000-4000-8000-000000000001",
      credential: { kind: "session" },
      clientAddress: null,
      clientAddressVerified: false,
      subject: { auditId: "00000000-0000-4000-8000-000000000003" },
    });
  });

  it("copies only the reference's own fields, whatever object the caller hands it", () => {
    // A caller that passed a wider object than the reference type (say the
    // gate's whole resolved session) must not widen the journal line with it.
    const widened = { kind: "token", tokenId: "00000000-0000-4000-8000-0000000000aa", secret: "leak" };
    logPrivilegedAction({
      action: "audit.open",
      actorId: "00000000-0000-4000-8000-000000000001",
      credential: widened as { kind: "token"; tokenId: string },
      clientAddress: null,
      clientAddressVerified: false,
      subject: { auditId: "00000000-0000-4000-8000-000000000003" },
    });

    const [, entry] = consoleInfo.mock.calls[0] as [string, { credential: unknown }];
    expect(entry.credential).toEqual({ kind: "token", tokenId: "00000000-0000-4000-8000-0000000000aa" });
  });
});
