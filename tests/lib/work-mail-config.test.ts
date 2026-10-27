import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  addressDigestInput,
  parseContributorAddress,
  readContributorMailConfig,
  type ContributorMailConfig,
} from "@/lib/accounts/work-mail-config";

const SMTP_URL = "OVERFLOW_CONTRIBUTOR_MAIL_SMTP_URL";
const FROM = "OVERFLOW_CONTRIBUTOR_MAIL_FROM";
const DAILY_LIMIT = "OVERFLOW_CONTRIBUTOR_MAIL_DAILY_LIMIT";

// Built at run time: no credential-shaped literal is committed.
const password = randomBytes(12).toString("hex");
const smtpUrl = (host: string, credentials = `mailer:${password}`) => `smtps://${credentials}@${host}`;

function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { [SMTP_URL]: smtpUrl("mail.example.net"), [FROM]: "work@Example.org", [DAILY_LIMIT]: "250", ...overrides };
}

function warnedVariables(config: ContributorMailConfig): string[] {
  expect(config.enabled).toBe(false);
  return config.enabled ? [] : config.warnings.map((warning) => /OVERFLOW_CONTRIBUTOR_MAIL_[A-Z_]+/.exec(warning)?.[0] ?? warning);
}

describe("parseContributorAddress", () => {
  it("trims the input and lowercases only the domain", () => {
    expect(parseContributorAddress("  Ada.Lovelace+work@Mail.Example.COM \n")).toEqual({
      address: "Ada.Lovelace+work@mail.example.com",
    });
  });

  it("accepts every RFC 5322 atext special in the local part", () => {
    const local = "!#$%&'*+-/=?^_`{|}~";
    expect(parseContributorAddress(`${local}@example.org`)).toEqual({ address: `${local}@example.org` });
  });

  it.each(['"', "(", ")", ",", ":", ";", "<", ">", "[", "\\", "]"])("refuses the non-atext character %s in the local part", (character) => {
    expect(parseContributorAddress(`a${character}b@example.org`)).toBeNull();
  });

  it("bounds the local part at 64 characters", () => {
    expect(parseContributorAddress(`${"a".repeat(64)}@example.org`)).not.toBeNull();
    expect(parseContributorAddress(`${"a".repeat(65)}@example.org`)).toBeNull();
  });

  it("bounds a domain label at 63 characters", () => {
    expect(parseContributorAddress(`a@${"b".repeat(63)}.org`)).not.toBeNull();
    expect(parseContributorAddress(`a@${"b".repeat(64)}.org`)).toBeNull();
  });

  it("bounds the whole address at 254 characters", () => {
    const local = "a".repeat(64);
    const domain = (lastLabel: number) => `${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(lastLabel)}`;
    expect(`${local}@${domain(61)}`).toHaveLength(254);
    expect(parseContributorAddress(`${local}@${domain(61)}`)).not.toBeNull();
    expect(parseContributorAddress(`${local}@${domain(62)}`)).toBeNull();
  });

  it.each([
    ["an empty input", ""],
    ["a blank input", "   "],
    ["no local part", "@example.org"],
    ["no domain", "ada@"],
    ["no @", "ada.example.org"],
    ["two @", "ada@lovelace@example.org"],
    ["two @ before two valid domains", "ada@example.org@example.net"],
    ["adjacent @", "ada@@example.org"],
    ["a single-label domain", "ada@localhost"],
    ["a leading dot", ".ada@example.org"],
    ["a trailing dot", "ada.@example.org"],
    ["consecutive dots", "ada..lovelace@example.org"],
    ["a leading hyphen in a label", "ada@-example.org"],
    ["a trailing hyphen in a label", "ada@example-.org"],
    ["an empty label", "ada@example..org"],
    ["a domain with a trailing dot", "ada@example.org."],
    ["a domain with a leading dot", "ada@.example.org"],
    ["an underscore in the domain", "ada@mail_host.example.org"],
    ["an address literal", "ada@[192.0.2.1]"],
    ["a quoted local part", '"ada"@example.org'],
    ["inner whitespace", "ada lovelace@example.org"],
    ["an inner tab", "ada\tlovelace@example.org"],
    ["whitespace in the domain", "ada@exam ple.org"],
    ["a header injection", "ada@example.org\r\nBcc: victim@example.net"],
    ["an inner line feed", "ada\n@example.org"],
    ["a NUL", "ada\u0000@example.org"],
    ["a DEL", "ada\u007f@example.org"],
    ["a non-ASCII local part", "adé@example.org"],
    ["a non-ASCII domain", "ada@exämple.org"],
  ])("refuses %s", (_name, input) => {
    expect(parseContributorAddress(input)).toBeNull();
  });
});

describe("addressDigestInput", () => {
  it("lowercases the whole address, local part included", () => {
    expect(addressDigestInput("Ada.Lovelace@example.org")).toBe("ada.lovelace@example.org");
  });
});

describe("readContributorMailConfig", () => {
  it("is off without a warning when all three variables are unset", () => {
    expect(readContributorMailConfig({})).toEqual({ enabled: false, warnings: [] });
  });

  it("treats empty values as unset", () => {
    expect(readContributorMailConfig({ [SMTP_URL]: "", [FROM]: "", [DAILY_LIMIT]: "" })).toEqual({ enabled: false, warnings: [] });
  });

  it("is on with the parsed transport, sender and ceiling when all three are valid", () => {
    expect(readContributorMailConfig(validEnv())).toEqual({
      enabled: true,
      smtp: { host: "mail.example.net", port: 465, username: "mailer", password },
      from: "work@example.org",
      dailyLimit: 250,
    });
  });

  it("prefers the OVERFLOW_ names over the bare names", () => {
    const config = readContributorMailConfig({
      ...validEnv(),
      CONTRIBUTOR_MAIL_SMTP_URL: "smtp://bare.example.net",
      CONTRIBUTOR_MAIL_FROM: "not an address",
      CONTRIBUTOR_MAIL_DAILY_LIMIT: "0",
    });
    expect(config.enabled).toBe(true);
  });

  it("reads the bare names when only they are set", () => {
    const config = readContributorMailConfig({
      CONTRIBUTOR_MAIL_SMTP_URL: smtpUrl("mail.example.net"),
      CONTRIBUTOR_MAIL_FROM: "work@example.org",
      CONTRIBUTOR_MAIL_DAILY_LIMIT: "5",
    });
    expect(config).toMatchObject({ enabled: true, dailyLimit: 5 });
  });

  it("takes an explicit port and percent-decodes the credentials", () => {
    const secret = `${randomBytes(6).toString("hex")}:/@`;
    const config = readContributorMailConfig(
      validEnv({ [SMTP_URL]: smtpUrl("Mail.Example.NET:2465", `mailer%40example.net:${encodeURIComponent(secret)}`) }),
    );
    expect(config).toMatchObject({
      enabled: true,
      smtp: { host: "mail.example.net", port: 2465, username: "mailer@example.net", password: secret },
    });
  });

  it.each([
    ["the smtp: scheme", "smtp://mailer:pw@mail.example.net"],
    ["the https: scheme", "https://mailer:pw@mail.example.net"],
    ["a value that is not a URL", "mail.example.net"],
    ["no credentials", "smtps://mail.example.net"],
    ["a username without a password", "smtps://mailer@mail.example.net"],
    ["an empty password", "smtps://mailer:@mail.example.net"],
    ["an empty username", "smtps://:pw@mail.example.net"],
    ["a malformed percent escape", "smtps://mailer:%zz@mail.example.net"],
    ["no host", "smtps://mailer:pw@"],
    ["localhost", "smtps://mailer:pw@localhost"],
    ["upper-case localhost", "smtps://mailer:pw@LOCALHOST"],
    ["localhost with a trailing dot", "smtps://mailer:pw@localhost."],
    ["a name under localhost", "smtps://mailer:pw@mail.localhost"],
    ["127.0.0.1", "smtps://mailer:pw@127.0.0.1"],
    ["another 127/8 address", "smtps://mailer:pw@127.200.3.4"],
    ["shorthand 127.1", "smtps://mailer:pw@127.1"],
    ["hexadecimal loopback", "smtps://mailer:pw@0x7f.0.0.1"],
    ["integer loopback", "smtps://mailer:pw@2130706433"],
    ["::1", "smtps://mailer:pw@[::1]"],
    ["uncompressed ::1", "smtps://mailer:pw@[0:0:0:0:0:0:0:1]"],
    ["IPv4-mapped loopback", "smtps://mailer:pw@[::ffff:127.0.0.1]"],
    ["smtp.gmail.com", "smtps://mailer:pw@smtp.gmail.com"],
    ["mixed-case smtp.gmail.com", "smtps://mailer:pw@SMTP.Gmail.COM"],
    ["smtp.gmail.com with a trailing dot", "smtps://mailer:pw@smtp.gmail.com."],
    ["smtp.googlemail.com", "smtps://mailer:pw@smtp.googlemail.com:465"],
    ["the unspecified IPv4 address", "smtps://mailer:pw@0.0.0.0"],
    ["integer 0", "smtps://mailer:pw@0"],
    ["hexadecimal 0", "smtps://mailer:pw@0x0"],
    ["the unspecified IPv6 address", "smtps://mailer:pw@[::]"],
    ["uncompressed ::", "smtps://mailer:pw@[0:0:0:0:0:0:0:0]"],
    ["IPv4-mapped 0.0.0.0", "smtps://mailer:pw@[::ffff:0.0.0.0]"],
    ["port 0", "smtps://mailer:pw@mail.example.net:0"],
  ])("is off and names only the SMTP variable for %s", (_name, value) => {
    const env = validEnv({ [SMTP_URL]: value.replace(":pw@", `:${password}@`) });
    const config = readContributorMailConfig(env);
    expect(warnedVariables(config)).toEqual([SMTP_URL]);
    expect(JSON.stringify(config)).not.toContain(password);
  });

  it.each([
    ["an IPv4 address outside 127/8", "128.0.0.1"],
    ["a name containing localhost", "localhost.example.net"],
    ["a name containing smtp.gmail.com", "smtp.gmail.com.example.net"],
    ["a non-loopback IPv6 address", "[2001:db8::1]"],
    ["an IPv4-mapped address outside 127/8", "[::ffff:128.0.0.1]"],
    ["an IPv4 address next to 0.0.0.0", "0.0.0.1"],
    ["an IPv6 address next to ::", "[::2]"],
    ["port 1", "mail.example.net:1"],
  ])("accepts %s as the SMTP host", (_name, host) => {
    expect(readContributorMailConfig(validEnv({ [SMTP_URL]: smtpUrl(host) })).enabled).toBe(true);
  });

  it("is off and names only the sender variable for an invalid sender", () => {
    const config = readContributorMailConfig(validEnv({ [FROM]: "Overflow <work@example.org>" }));
    expect(warnedVariables(config)).toEqual([FROM]);
    expect(JSON.stringify(config)).not.toContain("work@example.org");
  });

  it.each(["0", "-1", "1.5", "1e3", " 5", "ten", "9007199254740993"])("is off and names only the ceiling variable for %j", (value) => {
    expect(warnedVariables(readContributorMailConfig(validEnv({ [DAILY_LIMIT]: value })))).toEqual([DAILY_LIMIT]);
  });

  it("accepts a ceiling of one", () => {
    expect(readContributorMailConfig(validEnv({ [DAILY_LIMIT]: "1" }))).toMatchObject({ enabled: true, dailyLimit: 1 });
  });

  it("warns once for each missing variable of a partial configuration", () => {
    expect(warnedVariables(readContributorMailConfig({ [SMTP_URL]: smtpUrl("mail.example.net") }))).toEqual([FROM, DAILY_LIMIT]);
    expect(warnedVariables(readContributorMailConfig({ [DAILY_LIMIT]: "10" }))).toEqual([SMTP_URL, FROM]);
  });

  it("names every invalid variable when all three are wrong", () => {
    const config = readContributorMailConfig({ [SMTP_URL]: "smtp://x", [FROM]: "x", [DAILY_LIMIT]: "x" });
    expect(warnedVariables(config)).toEqual([SMTP_URL, FROM, DAILY_LIMIT]);
  });
});
