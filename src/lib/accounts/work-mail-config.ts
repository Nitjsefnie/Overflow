import { readEnv } from "@/lib/env";

export type ContributorAddress = { address: string };
export type SmtpSettings = { host: string; port: number; username: string; password: string };
export type ContributorMailConfig =
  | { enabled: true; smtp: SmtpSettings; from: string; dailyLimit: number }
  | { enabled: false; warnings: string[] };

const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LOCAL_PART = new RegExp(`^${ATEXT}(?:\\.${ATEXT})*$`);
const LABEL = "(?!-)[A-Za-z0-9-]{1,63}(?<!-)";
const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

// Neither pattern admits whitespace or control characters: a parsed address is safe in a header and an SMTP command.
// shortcut: ASCII only (SMTPUTF8 out of scope); upgrade when a contributor needs an internationalised address.
export function parseContributorAddress(input: string): ContributorAddress | null {
  const trimmed = input.trim();
  const parts = trimmed.split("@");
  if (trimmed.length > 254 || parts.length !== 2) return null;
  const [local, domain] = parts;
  if (local.length > 64 || !LOCAL_PART.test(local) || !DOMAIN.test(domain)) return null;
  return { address: `${local}@${domain.toLowerCase()}` };
}

export function addressDigestInput(address: string): string {
  return address.toLowerCase();
}

// The unspecified addresses dial the local host on Linux, like loopback.
const REFUSED_HOSTS = new Set(["localhost", "::1", "0.0.0.0", "::", "::ffff:0:0", "smtp.gmail.com", "smtp.googlemail.com"]);

function refusedHost(host: string): boolean {
  return REFUSED_HOSTS.has(host) || host.endsWith(".localhost") || /^127\./.test(host)
    || /^::ffff:7f[0-9a-f]{2}:/.test(host);
}

function parseSmtpUrl(raw: string): SmtpSettings | null {
  try {
    const url = new URL(raw);
    // smtps: hosts stay opaque; re-parsing as https gives the lowercase, canonical-IP form that is dialled.
    const host = new URL(`https://${url.hostname}`).hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (url.protocol !== "smtps:" || username === "" || password === "" || refusedHost(host)) return null;
    const port = url.port === "" ? 465 : Number(url.port);
    return port === 0 ? null : { host, port, username, password };
  } catch {
    return null;
  }
}

function parseDailyLimit(raw: string): number | null {
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// A warning names the variable, never its value: the URL carries the SMTP password.
export function readContributorMailConfig(env: Record<string, string | undefined> = process.env): ContributorMailConfig {
  const names = ["CONTRIBUTOR_MAIL_SMTP_URL", "CONTRIBUTOR_MAIL_FROM", "CONTRIBUTOR_MAIL_DAILY_LIMIT"] as const;
  const [rawUrl, rawFrom, rawLimit] = names.map((name) => readEnv(name, env) ?? "");
  if (rawUrl === "" && rawFrom === "" && rawLimit === "") return { enabled: false, warnings: [] };
  const smtp = parseSmtpUrl(rawUrl);
  const from = parseContributorAddress(rawFrom)?.address ?? null;
  const dailyLimit = parseDailyLimit(rawLimit);
  if (smtp !== null && from !== null && dailyLimit !== null) return { enabled: true, smtp, from, dailyLimit };
  const warnings = [smtp, from, dailyLimit].flatMap((value, index) =>
    value === null ? [`OVERFLOW_${names[index]} is unset or invalid; contributor mail stays off.`] : []);
  return { enabled: false, warnings };
}
