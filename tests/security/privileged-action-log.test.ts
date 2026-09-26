import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { logPrivilegedAction, readClientAddress } from "@/lib/security/privileged-action-log";

function requestWith(headers: Record<string, string>): Request {
  return new Request("https://overflow.internal/api/moderation", { headers });
}

describe("readClientAddress", () => {
  it("returns an IPv4 X-Real-IP value", () => {
    expect(readClientAddress(requestWith({ "x-real-ip": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("returns an IPv6 X-Real-IP value", () => {
    expect(readClientAddress(requestWith({ "x-real-ip": "2001:db8::17" }))).toBe("2001:db8::17");
  });

  it("trims surrounding whitespace before validating", () => {
    expect(readClientAddress(requestWith({ "x-real-ip": "  198.51.100.4 " }))).toBe("198.51.100.4");
  });

  it("returns null when the header is absent", () => {
    expect(readClientAddress(requestWith({}))).toBeNull();
  });

  it.each(["", "not-an-address", "203.0.113.7, 198.51.100.4", "999.1.1.1", "203.0.113.7:443"])(
    "returns null for the unparseable value %j",
    (value) => {
      expect(readClientAddress(requestWith({ "x-real-ip": value }))).toBeNull();
    },
  );

  it("never falls back to X-Forwarded-For", () => {
    expect(readClientAddress(requestWith({ "x-forwarded-for": "203.0.113.7" }))).toBeNull();
  });

  it("prefers X-Real-IP and ignores a disagreeing X-Forwarded-For", () => {
    const request = requestWith({ "x-real-ip": "198.51.100.4", "x-forwarded-for": "203.0.113.7" });
    expect(readClientAddress(request)).toBe("198.51.100.4");
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
        subject: { targetAccountId: "00000000-0000-4000-8000-000000000002" },
      },
    ]);
  });

  it("logs a session reference as its kind alone and a missing address as null", () => {
    logPrivilegedAction({
      action: "audit.dismiss",
      actorId: "00000000-0000-4000-8000-000000000001",
      credential: { kind: "session" },
      clientAddress: null,
      subject: { auditId: "00000000-0000-4000-8000-000000000003" },
    });

    expect(consoleInfo.mock.calls[0]?.[1]).toEqual({
      action: "audit.dismiss",
      actorId: "00000000-0000-4000-8000-000000000001",
      credential: { kind: "session" },
      clientAddress: null,
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
      subject: { auditId: "00000000-0000-4000-8000-000000000003" },
    });

    const [, entry] = consoleInfo.mock.calls[0] as [string, { credential: unknown }];
    expect(entry.credential).toEqual({ kind: "token", tokenId: "00000000-0000-4000-8000-0000000000aa" });
  });
});
