/** @vitest-environment jsdom */

import { randomBytes } from "node:crypto";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkMailDisclosure, WorkMailRecipient } from "@/components/work-mail-disclosure";

// Built at run time: no credential-shaped literal is committed.
const username = `mailer-${randomBytes(6).toString("hex")}`;
const password = randomBytes(12).toString("hex");
const HOST = "relay.mail-provider.example";
const FROM = "work@notify.example.org";
const smtpUrl = `smtps://${username}:${password}@${HOST}:465`;

function configure(url: string | undefined = smtpUrl): void {
  if (url !== undefined) vi.stubEnv("OVERFLOW_CONTRIBUTOR_MAIL_SMTP_URL", url);
  vi.stubEnv("OVERFLOW_CONTRIBUTOR_MAIL_FROM", FROM);
  vi.stubEnv("OVERFLOW_CONTRIBUTOR_MAIL_DAILY_LIMIT", "40");
}

function disclosure(): Element {
  const { container } = render(<WorkMailDisclosure />);
  const section = container.querySelector("section.surface");
  expect(section, "the disclosure is one labelled surface section").not.toBeNull();
  const labelledBy = section!.getAttribute("aria-labelledby");
  expect(section!.querySelector(`h2#${CSS.escape(labelledBy ?? "")}`)).not.toBeNull();
  return section!;
}

function expectNoCredential(text: string): void {
  for (const secret of [username, password, smtpUrl, "smtps:"]) expect(text).not.toContain(secret);
}

describe("work-mail disclosure", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders the configured sending identity and transport host, and never the credentials", () => {
    configure();
    const section = disclosure();

    expect(section.getAttribute("data-work-mail")).toBe("on");
    expect(section.querySelector("[data-work-mail-from]")?.textContent).toBe(FROM);
    expect(section.querySelector("[data-work-mail-host]")?.textContent).toBe(HOST);
    expectNoCredential(section.innerHTML);
  });

  it("renders the sends-none variant, without a sending identity, when nothing is configured", () => {
    const section = disclosure();

    expect(section.getAttribute("data-work-mail")).toBe("off");
    expect(section.querySelector("[data-work-mail-from]")).toBeNull();
    expect(section.querySelector("[data-work-mail-host]")).toBeNull();
  });

  it("renders the sends-none variant when the transport is invalid, though the sender is valid", () => {
    configure(smtpUrl.replace("smtps:", "smtp:"));
    const section = disclosure();

    expect(section.getAttribute("data-work-mail")).toBe("off");
    expect(section.querySelector("[data-work-mail-from]")).toBeNull();
    expect(section.textContent).not.toContain(FROM);
    expectNoCredential(section.innerHTML);
  });

  it("links only to page routes, never a mail address", () => {
    configure();
    const section = disclosure();

    const hrefs = Array.from(section.querySelectorAll("a[href]")).map((anchor) => anchor.getAttribute("href"));
    expect(hrefs).toEqual(["/dashboard"]);
  });

  it("names the transport host as a recipient only while contributor mail is configured", () => {
    configure();
    const enabled = render(<ul><WorkMailRecipient /></ul>).container;
    const items = enabled.querySelectorAll("li");
    expect(items).toHaveLength(1);
    expect(items[0]!.querySelector("[data-work-mail-host]")?.textContent).toBe(HOST);
    expectNoCredential(enabled.innerHTML);

    vi.unstubAllEnvs();
    expect(render(<ul><WorkMailRecipient /></ul>).container.querySelectorAll("li")).toHaveLength(0);
  });
});
