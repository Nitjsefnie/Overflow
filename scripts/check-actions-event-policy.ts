#!/usr/bin/env node
// Fail visibly until the repository's Actions event policy explicitly allows
// every event used by the pull-request gates and ledger relay.

import { pathToFileURL } from "node:url";

const POLICY_URL =
  "https://api.github.com/repos/Nitjsefnie/Overflow/actions/permissions/events";
const REQUIRED_EVENTS = ["pull_request_target", "workflow_run"] as const;

type RequiredEvent = (typeof REQUIRED_EVENTS)[number];
type Classification = { pass: boolean; reason: string };
type Decision = "allow" | "block";

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function requiredEvent(value: string): RequiredEvent | undefined {
  const normalized = normalize(value);
  return REQUIRED_EVENTS.find((event) => normalize(event) === normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusDecision(value: unknown): Decision | undefined {
  if (typeof value === "boolean") return value ? "allow" : "block";
  if (typeof value !== "string") return undefined;

  const status = normalize(value);
  if (
    ["allow", "allowed", "enable", "enabled", "permit", "permitted", "active", "true", "yes"]
      .includes(status)
  ) {
    return "allow";
  }
  if (
    [
      "deny",
      "denied",
      "block",
      "blocked",
      "disable",
      "disabled",
      "disallow",
      "disallowed",
      "forbidden",
      "prohibited",
      "false",
      "no",
      "notallowed",
      "notenabled",
    ].includes(status)
  ) {
    return "block";
  }
  return undefined;
}

const ALLOW_FIELDS = new Set([
  "allow",
  "allowed",
  "enable",
  "enabled",
  "permit",
  "permitted",
  "active",
  "isallowed",
  "isenabled",
]);
const BLOCK_FIELDS = new Set([
  "deny",
  "denied",
  "block",
  "blocked",
  "disable",
  "disabled",
  "disallow",
  "disallowed",
  "forbidden",
  "prohibited",
  "isblocked",
  "isdenied",
]);
const STATUS_FIELDS = new Set([
  "status",
  "state",
  "policy",
  "permission",
  "access",
  "mode",
  "effect",
  "decision",
  "result",
  "value",
]);
const EVENT_NAME_FIELDS = new Set([
  "event",
  "eventname",
  "trigger",
  "triggername",
  "workflowevent",
  "name",
]);

function fieldDecision(value: unknown, kind: "allow" | "block" | "status"): Decision | undefined {
  if (kind === "block" && typeof value === "boolean") {
    return value ? "block" : undefined;
  }
  if (kind === "block" && typeof value === "string") {
    const status = normalize(value);
    return [
      "true",
      "yes",
      "deny",
      "denied",
      "block",
      "blocked",
      "disable",
      "disabled",
      "disallow",
      "disallowed",
      "forbidden",
      "prohibited",
    ].includes(status)
      ? "block"
      : undefined;
  }
  return statusDecision(value);
}

function listDecision(field: string): Decision | undefined {
  const normalized = normalize(field);
  if (
    ["blocked", "denied", "disallowed", "disabled", "forbidden", "prohibited", "deny", "block"]
      .some((prefix) => normalized.startsWith(prefix)) ||
    normalized.includes("denylist") ||
    normalized.includes("blocklist")
  ) {
    return "block";
  }
  if (
    ["allowed", "allow", "enabled", "enable", "permitted", "permit"]
      .some((prefix) => normalized.startsWith(prefix)) ||
    normalized.includes("allowlist") ||
    normalized.includes("permittedlist")
  ) {
    return "allow";
  }
  return undefined;
}

/**
 * Classifies the API response without assuming one particular future schema.
 * Unknown or ambiguous JSON fails closed: each required event needs an
 * explicit allow entry, and any explicit deny takes precedence.
 */
export function classify(response: { status: number; body: string }): Classification {
  if (response.status === 404) {
    return {
      pass: false,
      reason:
        "Actions event-policy surface is absent (HTTP 404); GitHub enforcement starts " +
        "2026-11-02. Issue 818 alarm: the policy cannot be verified.",
    };
  }
  if (response.status !== 200) {
    return {
      pass: false,
      reason:
        `HTTP ${response.status}; cannot verify the Actions event policy ` +
        "(the token may lack access or the API may be rate limiting).",
    };
  }

  let document: unknown;
  try {
    document = JSON.parse(response.body) as unknown;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return {
      pass: false,
      reason:
        `HTTP 200 returned malformed JSON (${cause}). Raw event-policy document:\n` +
        response.body,
    };
  }

  const evidence = new Map<RequiredEvent, { allowed: boolean; blocked: boolean }>(
    REQUIRED_EVENTS.map((event) => [event, { allowed: false, blocked: false }]),
  );
  const mark = (event: RequiredEvent, decision: Decision): void => {
    const item = evidence.get(event);
    if (item === undefined) return;
    if (decision === "allow") item.allowed = true;
    else item.blocked = true;
  };

  const inspectDecisionFields = (event: RequiredEvent, value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const decision = statusDecision(item);
        if (decision !== undefined) mark(event, decision);
        else inspectDecisionFields(event, item);
      }
      return;
    }
    if (!isRecord(value)) return;

    for (const [key, child] of Object.entries(value)) {
      const field = normalize(key);
      const kind = ALLOW_FIELDS.has(field)
        ? "allow"
        : BLOCK_FIELDS.has(field)
          ? "block"
          : STATUS_FIELDS.has(field)
            ? "status"
            : undefined;
      if (kind !== undefined) {
        const decision = fieldDecision(child, kind);
        if (decision !== undefined) mark(event, decision);
      }
      if (isRecord(child) || Array.isArray(child)) inspectDecisionFields(event, child);
    }
  };

  const readEventName = (value: unknown): RequiredEvent | undefined => {
    if (!isRecord(value)) return undefined;
    for (const [key, child] of Object.entries(value)) {
      if (EVENT_NAME_FIELDS.has(normalize(key)) && typeof child === "string") {
        const event = requiredEvent(child);
        if (event !== undefined) return event;
      }
    }
    return undefined;
  };

  const visit = (value: unknown, parentKey = ""): void => {
    if (Array.isArray(value)) {
      const inheritedDecision = listDecision(parentKey);
      for (const item of value) {
        if (typeof item === "string" && inheritedDecision !== undefined) {
          const event = requiredEvent(item);
          if (event !== undefined) mark(event, inheritedDecision);
        }
        if (isRecord(item)) {
          const event = readEventName(item);
          if (event !== undefined) {
            if (inheritedDecision !== undefined) mark(event, inheritedDecision);
            inspectDecisionFields(event, item);
          }
        }
        visit(item);
      }
      return;
    }
    if (!isRecord(value)) return;

    const inheritedDecision = listDecision(parentKey);
    const namedEvent = readEventName(value);
    if (namedEvent !== undefined) {
      if (inheritedDecision !== undefined) mark(namedEvent, inheritedDecision);
      inspectDecisionFields(namedEvent, value);
    }

    for (const [key, child] of Object.entries(value)) {
      const event = requiredEvent(key);
      if (event !== undefined) {
        if (inheritedDecision !== undefined) mark(event, inheritedDecision);
        if (typeof child === "boolean" || typeof child === "string") {
          const decision = statusDecision(child);
          if (decision !== undefined) mark(event, decision);
        } else {
          inspectDecisionFields(event, child);
        }
      }
      visit(child, key);
    }
  };

  visit(document);

  const blocked = REQUIRED_EVENTS.filter((event) => evidence.get(event)?.blocked);
  const missing = REQUIRED_EVENTS.filter((event) => {
    const item = evidence.get(event);
    return item !== undefined && !item.allowed && !item.blocked;
  });
  if (blocked.length === 0 && missing.length === 0) {
    return { pass: true, reason: "Both required events are explicitly allowed." };
  }

  const details: string[] = [];
  if (blocked.length > 0) details.push(`blocked: ${blocked.join(", ")}`);
  if (missing.length > 0) details.push(`missing explicit allow: ${missing.join(", ")}`);
  return {
    pass: false,
    reason:
      `HTTP 200 event policy does not admit both required events (${details.join("; ")}). ` +
      `Raw event-policy document:\n${response.body}`,
  };
}

function errorCause(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.replace(/\s+/g, " ").trim();
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    const message =
      "::error::Missing GITHUB_TOKEN and GH_TOKEN; cannot verify the Actions event policy.";
    console.error(message);
    console.log(message);
    process.exitCode = 1;
    return;
  }

  try {
    const response = await fetch(POLICY_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(30_000),
    });
    const result = classify({ status: response.status, body: await response.text() });
    console.log(result.reason);
    if (!result.pass) process.exitCode = 1;
  } catch (error) {
    console.error(
      `::error::Actions event policy check failed; network/transport error: ${errorCause(error)}`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
