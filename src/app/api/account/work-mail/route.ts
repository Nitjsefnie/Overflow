import { errorResponse } from "@/lib/http/error-response";
import { findLiveAccountIdentity } from "@/lib/accounts/self-service";
import {
  parseContributorAddress,
  readContributorMailConfig,
  type ContributorMailConfig,
  type SmtpSettings,
} from "@/lib/accounts/work-mail-config";
import { PostgresWorkMailStore } from "@/lib/accounts/work-mail-store";
import {
  buildConfirmationMessage,
  createSmtpsTransport,
  type WorkMailTransport,
} from "@/lib/accounts/work-mail-transport";
import { getSql } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/types";
import { readBodyWithinLimit } from "@/lib/http/request-body";
import { readTrustedOrigin, rejectUntrustedRequest } from "@/lib/security/request-origin";

/** The POST body is one JSON object carrying one address of at most 254 characters. */
const WORK_MAIL_BODY_LIMIT_BYTES = 4 * 1024; // 4 KiB

type Session = { user: { id: string } };
type Identity = NonNullable<Awaited<ReturnType<typeof findLiveAccountIdentity>>>;

export type WorkMailStore = Pick<
  PostgresWorkMailStore,
  "requestConfirmation" | "confirm" | "getSubscription" | "deleteSubscription"
>;

export type WorkMailRouteDependencies = {
  getSession: () => Promise<Session | null>;
  getSql: () => SqlClient;
  findIdentity?: (sql: SqlClient, userId: string) => Promise<Identity | null>;
  createStore?: (sql: SqlClient) => WorkMailStore;
  readConfig?: () => ContributorMailConfig;
  createTransport?: (smtp: SmtpSettings) => WorkMailTransport;
};

// Fixed log lines only: a database error or an SMTP reply can carry the address.
function upstreamFailure(log: string): Response {
  console.error(log);
  return errorResponse(502, "UPSTREAM_FAILURE", "The work mail operation could not complete.");
}

function featureOff(): Response {
  return errorResponse(404, "NOT_FOUND", "Work mail is not enabled on this instance.");
}

/** The signed-in live account's id and the store, or the refusal to answer instead. */
async function member(
  dependencies: WorkMailRouteDependencies,
): Promise<{ userId: string; store: WorkMailStore } | Response> {
  try {
    const session = await dependencies.getSession();
    if (session === null) return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
    const sql = dependencies.getSql();
    const identity = await (dependencies.findIdentity ?? findLiveAccountIdentity)(sql, session.user.id);
    if (identity === null) return errorResponse(403, "FORBIDDEN", "A member account is required.");
    const store = (dependencies.createStore ?? ((client: SqlClient) => new PostgresWorkMailStore(client)))(sql);
    return { userId: session.user.id, store };
  } catch {
    return upstreamFailure("Work mail account lookup failed.");
  }
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function createWorkMailGetHandler(dependencies: WorkMailRouteDependencies) {
  return async function getWorkMail(): Promise<Response> {
    const config = (dependencies.readConfig ?? readContributorMailConfig)();
    const caller = await member(dependencies);
    if (caller instanceof Response) return caller;
    try {
      const stored = await caller.store.getSubscription(caller.userId);
      return Response.json({
        enabled: config.enabled,
        subscription: stored === null ? null : {
          address: stored.address,
          confirmed: stored.confirmedAt !== null,
          confirmedAt: iso(stored.confirmedAt),
          lastNotifiedAt: iso(stored.lastNotifiedAt),
          confirmExpiresAt: iso(stored.confirmExpiresAt),
        },
      });
    } catch {
      return upstreamFailure("Work mail read failed.");
    }
  };
}

/** Runs detached from the answer, so a sent and a suppressed request take the same time to answer. */
async function deliverConfirmation(
  config: Extract<ContributorMailConfig, { enabled: true }>,
  createTransport: (smtp: SmtpSettings) => WorkMailTransport,
  to: string,
  token: string,
): Promise<void> {
  try {
    const message = buildConfirmationMessage({ from: config.from, to, origin: readTrustedOrigin() ?? "", token });
    const result = await createTransport(config.smtp).send(message);
    if (!result.ok) console.warn(`Work mail confirmation was not sent (reply code ${result.code ?? "none"}).`);
  } catch {
    console.warn("Work mail confirmation was not sent.");
  }
}

export function createWorkMailPostHandler(dependencies: WorkMailRouteDependencies) {
  return async function requestWorkMail(request: Request): Promise<Response> {
    const config = (dependencies.readConfig ?? readContributorMailConfig)();
    if (!config.enabled) return featureOff();
    const untrusted = rejectUntrustedRequest(request);
    if (untrusted !== null) return untrusted;
    const caller = await member(dependencies);
    if (caller instanceof Response) return caller;

    let rawBody: Buffer | null;
    try {
      rawBody = await readBodyWithinLimit(request, WORK_MAIL_BODY_LIMIT_BYTES);
    } catch {
      rawBody = Buffer.alloc(0);
    }
    if (rawBody === null) return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      body = null;
    }
    const raw = (body as { address?: unknown } | null)?.address;
    const parsed = typeof raw === "string" ? parseContributorAddress(raw) : null;
    if (parsed === null) return errorResponse(400, "INVALID_REQUEST", "A valid email address is required.");

    let outcome;
    try {
      outcome = await caller.store.requestConfirmation(caller.userId, parsed.address, { dailyLimit: config.dailyLimit });
    } catch {
      return upstreamFailure("Work mail request failed.");
    }
    switch (outcome.kind) {
      case "account-limited":
        return errorResponse(429, "RATE_LIMITED",
          "Too many confirmation emails for this account. Retry after the number of seconds the Retry-After header names.",
          { headers: { "retry-after": String(outcome.retryAfterSeconds) } });
      case "ceiling":
        return errorResponse(503, "DAILY_LIMIT_REACHED", "Overflow has sent all the email it may send today. Try again tomorrow.");
      case "send":
        void deliverConfirmation(config, dependencies.createTransport ?? createSmtpsTransport, parsed.address, outcome.token);
        return Response.json({ requested: true }, { status: 202 });
      case "suppressed":
        return Response.json({ requested: true }, { status: 202 });
    }
  };
}

export function createWorkMailDeleteHandler(dependencies: WorkMailRouteDependencies) {
  return async function deleteWorkMail(request: Request): Promise<Response> {
    const untrusted = rejectUntrustedRequest(request);
    if (untrusted !== null) return untrusted;
    const caller = await member(dependencies);
    if (caller instanceof Response) return caller;
    try {
      await caller.store.deleteSubscription(caller.userId);
      return Response.json({ deleted: true });
    } catch {
      return upstreamFailure("Work mail delete failed.");
    }
  };
}

const production: WorkMailRouteDependencies = {
  async getSession() {
    const { auth } = await import("@/auth");
    const session = await auth();
    const user = session?.user as { id?: unknown; role?: unknown } | undefined;
    if (typeof user?.id !== "string" || (user.role !== "MEMBER" && user.role !== "MODERATOR")) return null;
    return { user: { id: user.id } };
  },
  getSql,
};

export const GET = createWorkMailGetHandler(production);
export const POST = createWorkMailPostHandler(production);
export const DELETE = createWorkMailDeleteHandler(production);
