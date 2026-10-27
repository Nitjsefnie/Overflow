import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildConfirmationMessage, buildDigestMessage, type WorkMailMessage } from "@/lib/accounts/work-mail-transport";

const origin = "https://overflow.example";
const now = new Date(Date.UTC(2026, 9, 7, 8, 5, 3));
const token = () => randomBytes(32).toString("base64url");
const unsubscribeToken = () => `${randomUUID()}.${randomBytes(32).toString("base64url")}`;
const confirmationInput = (overrides = {}) => ({ from: "work@Mail.Example.org", to: "Ada@Example.NET", origin, token: token(), now, ...overrides });
const digestInput = (overrides = {}) => ({
  from: "work@mail.example.org", to: "ada@example.net", origin, count: 7, unsubscribeToken: unsubscribeToken(), now, ...overrides,
});

const COMMON_HEADERS = ["From", "To", "Subject", "Date", "Message-ID", "MIME-Version", "Content-Type", "Content-Transfer-Encoding", "Auto-Submitted"];

function parse(message: WorkMailMessage): { headers: [string, string][]; bodyLines: string[] } {
  const lines = message.content.split("\r\n");
  const blank = lines.indexOf("");
  expect(blank).toBeGreaterThan(0);
  const headers = lines.slice(0, blank).map((line): [string, string] => {
    const colon = line.indexOf(": ");
    return [line.slice(0, colon), line.slice(colon + 2)];
  });
  return { headers, bodyLines: lines.slice(blank + 1) };
}

const header = (message: WorkMailMessage, name: string) => parse(message).headers.find(([key]) => key === name)?.[1];

describe.each([
  ["confirmation", () => buildConfirmationMessage(confirmationInput())],
  ["digest", () => buildDigestMessage(digestInput())],
])("the %s message", (_kind, build) => {
  it("is CRLF-delimited 7-bit text with no line over 998 octets", () => {
    const { content } = build();
    expect(content.endsWith("\r\n")).toBe(true);
    for (const line of content.split("\r\n")) {
      expect(line).not.toMatch(/[\r\n]/);
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(998);
    }
    expect(content).toMatch(/^[\x20-\x7e\r\n]*$/);
    expect(header(build(), "Content-Transfer-Encoding")).toBe("7bit");
  });

  it("carries the fixed MIME and auto-submission headers", () => {
    const message = build();
    expect(header(message, "MIME-Version")).toBe("1.0");
    expect(header(message, "Content-Type")).toBe("text/plain; charset=utf-8");
    expect(header(message, "Auto-Submitted")).toBe("auto-generated");
  });

  it("dates it in RFC 5322 form and gives it a fresh uuid Message-ID at the sender's domain", () => {
    const first = build();
    expect(header(first, "Date")).toBe("Wed, 07 Oct 2026 08:05:03 +0000");
    expect(header(first, "Message-ID")).toMatch(/^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@mail\.example\.org>$/);
    expect(header(build(), "Message-ID")).not.toBe(header(first, "Message-ID"));
  });
});

it("gives the two kinds distinct fixed subjects", () => {
  const confirmation = header(buildConfirmationMessage(confirmationInput()), "Subject");
  expect(header(buildConfirmationMessage(confirmationInput({ to: "grace@example.net" })), "Subject")).toBe(confirmation);
  expect(header(buildDigestMessage(digestInput()), "Subject")).not.toBe(confirmation);
});

describe("buildConfirmationMessage", () => {
  it("addresses the validated, domain-lowercased addresses in the envelope and the headers", () => {
    const message = buildConfirmationMessage(confirmationInput());
    expect(message).toMatchObject({ from: "work@mail.example.org", to: "Ada@example.net" });
    expect(parse(message).headers.map(([name]) => name)).toEqual(COMMON_HEADERS);
    expect(header(message, "From")).toBe("work@mail.example.org");
    expect(header(message, "To")).toBe("Ada@example.net");
  });

  it("links the dashboard with the token in the fragment", () => {
    const confirmToken = token();
    const { bodyLines } = parse(buildConfirmationMessage(confirmationInput({ token: confirmToken })));
    expect(bodyLines).toContain(`${origin}/dashboard#work-mail-confirm=${confirmToken}`);
  });

  it("dates it now when no time is given", () => {
    const before = Date.now();
    const date = Date.parse(header(buildConfirmationMessage(confirmationInput({ now: undefined })), "Date") ?? "");
    expect(date).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(date).toBeLessThanOrEqual(Date.now());
  });
});

describe("buildDigestMessage", () => {
  it("adds the one-click unsubscribe headers after the common ones", () => {
    const optOut = unsubscribeToken();
    const message = buildDigestMessage(digestInput({ unsubscribeToken: optOut }));
    expect(parse(message).headers.map(([name]) => name)).toEqual([...COMMON_HEADERS, "List-Unsubscribe", "List-Unsubscribe-Post"]);
    expect(header(message, "List-Unsubscribe")).toBe(`<${origin}/api/work-mail/unsubscribe?token=${optOut}>`);
    expect(header(message, "List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");
  });

  it("links the board and the opt-out page and states the count", () => {
    const optOut = unsubscribeToken();
    const { bodyLines } = parse(buildDigestMessage(digestInput({ count: 7, unsubscribeToken: optOut })));
    expect(bodyLines).toContain(`${origin}/issues`);
    expect(bodyLines).toContain(`${origin}/work-mail/unsubscribe#token=${optOut}`);
    expect(bodyLines.some((line) => /\b7\b/.test(line))).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses the count %s", (count) => {
    expect(() => buildDigestMessage(digestInput({ count }))).toThrow();
  });
});

describe("header injection", () => {
  const injection = "\r\nBcc: victim@example.net";

  it.each([
    ["the sender", { from: `work@mail.example.org${injection}` }],
    ["the recipient", { to: `ada@example.net${injection}` }],
    ["the origin", { origin: `${origin}${injection}` }],
    ["an origin with a line feed inside the host", { origin: "https://overflow.exam\nple" }],
  ])("refuses a CR/LF in %s of either kind", (_name, overrides) => {
    expect(() => buildConfirmationMessage(confirmationInput(overrides))).toThrow();
    expect(() => buildDigestMessage(digestInput(overrides))).toThrow();
  });

  it("refuses a CR/LF in the confirmation token", () => {
    expect(() => buildConfirmationMessage(confirmationInput({ token: `${token()}${injection}` }))).toThrow();
  });

  it("refuses a CR/LF in the unsubscribe token", () => {
    expect(() => buildDigestMessage(digestInput({ unsubscribeToken: `${unsubscribeToken()}${injection}` }))).toThrow();
  });

  it.each([
    ["plain http", "http://overflow.example"],
    ["a path", `${origin}/dashboard`],
    ["a trailing slash", `${origin}/`],
    ["not a URL", "overflow.example"],
  ])("refuses an origin with %s", (_name, value) => {
    expect(() => buildConfirmationMessage(confirmationInput({ origin: value }))).toThrow();
  });

  it.each(["has space", "semi;colon", "angle>", "pct%41", ""])("refuses the token %j", (value) => {
    expect(() => buildConfirmationMessage(confirmationInput({ token: value }))).toThrow();
    expect(() => buildDigestMessage(digestInput({ unsubscribeToken: value }))).toThrow();
  });
});
